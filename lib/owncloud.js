"use strict";
/**
 * Schlanker ownCloud-10.x-Client (WebDAV + OCS-Share-API).
 * Benötigt Node >= 18 (globales fetch).
 */
const fs = require("fs");
const { Readable } = require("stream");
const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) => name === "response" || name === "propstat",
});

const PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:resourcetype/>
    <d:getetag/>
    <oc:fileid/>
    <oc:size/>
    <oc:permissions/>
  </d:prop>
</d:propfind>`;

class OwnCloudError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Zerlegt einen Pfad in sichere Segmente; ".." und "." werden abgewiesen. */
function safeSegments(p) {
  if (p === undefined || p === null) return [];
  const segs = String(p)
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const s of segs) {
    if (s === "." || s === "..")
      throw new OwnCloudError(`Unzulässiger Pfadbestandteil: ${s}`, 400);
    if (/[\u0000-\u001f]/.test(s))
      throw new OwnCloudError("Steuerzeichen im Pfad sind nicht erlaubt", 400);
  }
  return segs;
}

/** Verbindet Pfadteile zu "a/b/c" (ohne führenden/abschließenden Slash). */
function joinPath(...parts) {
  return parts.flatMap((p) => safeSegments(p)).join("/");
}

/** Ersetzt Platzhalter {feld} in einer Vorlage durch Werte aus der Zeile. */
function fillTemplate(template, row) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => {
    const v = row && row[k] !== undefined && row[k] !== null ? String(row[k]) : "";
    // Slashes in Feldwerten nicht als Ordnertrenner zulassen
    return v.replace(/[\/\\]/g, "-");
  });
}

class OwnCloudClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.base_url  z.B. https://cloud.example.de  (ohne /remote.php)
   * @param {string} cfg.username  technischer Benutzer
   * @param {string} cfg.password  App-Passwort
   * @param {string} [cfg.root_folder] Basisordner, z.B. "Saltcorn"
   * @param {number} [cfg.timeout_ms]
   */
  constructor(cfg = {}) {
    if (!cfg.base_url || !cfg.username || !cfg.password)
      throw new OwnCloudError(
        "ownCloud-Plugin ist nicht konfiguriert (URL, Benutzer, App-Passwort)",
        500
      );
    this.base = String(cfg.base_url).replace(/\/+$/, "");
    this.user = cfg.username;
    this.root = safeSegments(cfg.root_folder || "").join("/");
    this.timeout = Number(cfg.timeout_ms) || 30000;
    this.auth =
      "Basic " +
      Buffer.from(`${cfg.username}:${cfg.password}`, "utf8").toString("base64");
    this.davRoot = `${this.base}/remote.php/dav/files/${encodeURIComponent(
      this.user
    )}`;
  }

  /** Pfad relativ zum Benutzer-Root (inkl. root_folder), z.B. "Saltcorn/Fall-1/a.pdf" */
  fullPath(rel) {
    return joinPath(this.root, rel);
  }

  davUrl(rel, isDir = false) {
    const p = this.fullPath(rel);
    const enc = p
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    return `${this.davRoot}/${enc}${isDir && enc ? "/" : ""}`;
  }

  async request(method, url, { headers = {}, body, expect = [], stream } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const opts = {
        method,
        headers: { Authorization: this.auth, ...headers },
        body,
        signal: ctrl.signal,
        redirect: "manual",
      };
      if (stream) opts.duplex = "half";
      const resp = await fetch(url, opts);
      if (expect.length && !expect.includes(resp.status)) {
        let detail = "";
        try {
          detail = (await resp.text()).slice(0, 500);
          const m = detail.match(/<s:message>([\s\S]*?)<\/s:message>/);
          if (m) detail = m[1];
        } catch (e) {}
        throw new OwnCloudError(
          `ownCloud ${method} ${resp.status}${detail ? ": " + detail : ""}`,
          resp.status
        );
      }
      return resp;
    } catch (e) {
      if (e.name === "AbortError")
        throw new OwnCloudError(`Zeitüberschreitung bei ${method}`, 504);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  /** Listet einen Ordner (Depth 1). Gibt null zurück, wenn er nicht existiert. */
  async list(rel) {
    const url = this.davUrl(rel, true);
    const resp = await this.request("PROPFIND", url, {
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
      expect: [207, 404],
    });
    if (resp.status === 404) return null;
    const xml = await resp.text();
    const doc = parser.parse(xml);
    const responses = (doc.multistatus && doc.multistatus.response) || [];
    const selfPath = new URL(url).pathname.replace(/\/+$/, "");
    const items = [];
    for (const r of responses) {
      const href = decodeURIComponent(String(r.href || ""));
      const hrefPath = href.replace(/^https?:\/\/[^/]+/, "").replace(/\/+$/, "");
      if (hrefPath === decodeURIComponent(selfPath)) continue; // Ordner selbst
      const ok = (r.propstat || []).find((ps) =>
        String(ps.status || "").includes(" 200 ")
      );
      const prop = (ok && ok.prop) || {};
      const isDir =
        prop.resourcetype && typeof prop.resourcetype === "object"
          ? "collection" in prop.resourcetype
          : false;
      const name = hrefPath.split("/").pop();
      items.push({
        name,
        is_dir: isDir,
        size: Number(prop.size || prop.getcontentlength || 0),
        content_type: isDir ? null : prop.getcontenttype || null,
        last_modified: prop.getlastmodified
          ? new Date(prop.getlastmodified).toISOString()
          : null,
        etag: prop.getetag ? String(prop.getetag).replace(/"/g, "") : null,
        fileid: prop.fileid ? String(prop.fileid) : null,
        permissions: prop.permissions || null,
      });
    }
    items.sort((a, b) =>
      a.is_dir === b.is_dir
        ? a.name.localeCompare(b.name, "de", { sensitivity: "base" })
        : a.is_dir
        ? -1
        : 1
    );
    return items;
  }

  async exists(rel) {
    const resp = await this.request("PROPFIND", this.davUrl(rel), {
      headers: { Depth: "0" },
      expect: [207, 404],
    });
    return resp.status === 207;
  }

  /** Legt einen Ordner inkl. aller fehlenden Elternordner an (idempotent). */
  async mkdirp(rel) {
    const segs = safeSegments(this.fullPath(rel));
    let cur = [];
    for (const s of segs) {
      cur.push(s);
      const url =
        `${this.davRoot}/` + cur.map(encodeURIComponent).join("/") + "/";
      // 201 = angelegt, 405 = existiert bereits
      await this.request("MKCOL", url, { expect: [201, 405] });
    }
    return segs.join("/");
  }

  /** Lädt eine lokale Datei (z.B. express-fileupload tempFilePath) hoch. */
  async uploadFile(relDir, filename, localPath, contentType) {
    const name = safeSegments(filename);
    if (name.length !== 1)
      throw new OwnCloudError("Ungültiger Dateiname", 400);
    const { size } = await fs.promises.stat(localPath);
    const url = this.davUrl(joinPath(relDir, name[0]));
    await this.request("PUT", url, {
      headers: {
        "Content-Type": contentType || "application/octet-stream",
        "Content-Length": String(size),
      },
      body: fs.createReadStream(localPath),
      stream: true,
      expect: [201, 204],
    });
    return joinPath(relDir, name[0]);
  }

  /** Lädt einen Buffer/String hoch. */
  async uploadBuffer(relPath, data, contentType) {
    await this.request("PUT", this.davUrl(relPath), {
      headers: { "Content-Type": contentType || "application/octet-stream" },
      body: data,
      expect: [201, 204],
    });
  }

  /** Gibt die fetch-Response zurück (Body als Web-Stream). */
  async download(relPath) {
    return await this.request("GET", this.davUrl(relPath), {
      expect: [200],
    });
  }

  async remove(relPath) {
    await this.request("DELETE", this.davUrl(relPath), {
      expect: [204, 404],
    });
  }

  async move(fromRel, toRel, overwrite = false) {
    await this.request("MOVE", this.davUrl(fromRel), {
      headers: {
        Destination: this.davUrl(toRel),
        Overwrite: overwrite ? "T" : "F",
      },
      expect: [201, 204],
    });
  }

  // ---------- OCS Share API ----------

  async ocs(method, path, params) {
    const url = new URL(
      `${this.base}/ocs/v1.php/apps/files_sharing/api/v1/${path}`
    );
    url.searchParams.set("format", "json");
    let body;
    if (method === "GET" && params)
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    else if (params) body = new URLSearchParams(params).toString();
    const resp = await this.request(method, url.toString(), {
      headers: {
        "OCS-APIRequest": "true",
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body,
      expect: [200, 404],
    });
    const json = await resp.json().catch(() => null);
    const meta = json && json.ocs && json.ocs.meta;
    if (!meta) throw new OwnCloudError("Ungültige OCS-Antwort", 502);
    if (meta.statuscode !== 100 && meta.statuscode !== 200)
      throw new OwnCloudError(
        `OCS-Fehler ${meta.statuscode}: ${meta.message || ""}`,
        meta.statuscode === 404 ? 404 : 502
      );
    return json.ocs.data;
  }

  /**
   * Erzeugt (oder findet) einen öffentlichen Link.
   * @param {string} rel Pfad relativ zum root_folder
   * @param {object} [o] { expireDays, password, permissions, reuse }
   */
  async publicLink(rel, o = {}) {
    const ocPath = "/" + this.fullPath(rel);
    if (o.reuse !== false) {
      try {
        const existing = await this.ocs("GET", "shares", {
          path: ocPath,
          reshares: "false",
        });
        const link = (existing || []).find(
          (s) => Number(s.share_type) === 3 && s.url
        );
        if (link) return { url: link.url, id: link.id, reused: true };
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    const params = {
      path: ocPath,
      shareType: "3",
      permissions: String(o.permissions || 1),
    };
    if (o.password) params.password = o.password;
    if (o.expireDays && Number(o.expireDays) > 0) {
      const d = new Date(Date.now() + Number(o.expireDays) * 86400000);
      params.expireDate = d.toISOString().slice(0, 10);
    }
    if (o.name) params.name = String(o.name).slice(0, 64);
    const data = await this.ocs("POST", "shares", params);
    return { url: data.url, id: data.id, reused: false };
  }
}

/** Streamt eine fetch-Response an eine Express-Response. */
async function pipeToExpress(fetchResp, res, filename, inline) {
  const { pipeline } = require("stream/promises");
  const ct = fetchResp.headers.get("content-type") || "application/octet-stream";
  const len = fetchResp.headers.get("content-length");
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  res.setHeader("Content-Type", ct);
  if (len) res.setHeader("Content-Length", len);
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
      filename
    )}`
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  await pipeline(Readable.fromWeb(fetchResp.body), res);
}

module.exports = {
  OwnCloudClient,
  OwnCloudError,
  safeSegments,
  joinPath,
  fillTemplate,
  pipeToExpress,
};
