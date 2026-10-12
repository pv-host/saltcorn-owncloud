// Minimaler ownCloud-10-Nachbau (WebDAV + OCS-Shares) nur für Tests
const http = require("http");
function start(port, { user = "svc", pass = "app-pw" } = {}) {
  const files = new Map(); // "a/b.txt" -> {data, ct, mtime}
  const dirs = new Set([""]);
  const shares = [];
  const prefix = `/remote.php/dav/files/${user}`;
  const log = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      log.push({ method: req.method, url: req.url, headers: req.headers, bodyLen: body.length });
      const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
      if (req.headers.authorization !== auth) { res.writeHead(401); return res.end("<s:message>Username or password was incorrect</s:message>"); }
      const u = new URL(req.url, "http://x");
      if (u.pathname.startsWith("/ocs/v1.php/apps/files_sharing/api/v1/shares")) {
        if (req.headers["ocs-apirequest"] !== "true") { res.writeHead(400); return res.end(); }
        const send = (data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 100, message: "OK" }, data } })); };
        if (req.method === "GET") { const p = u.searchParams.get("path"); return send(shares.filter((s) => s.path === p)); }
        const params = new URLSearchParams(body.toString());
        const p = params.get("path").replace(/^\//, "");
        if (!files.has(p) && !dirs.has(p)) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ocs: { meta: { statuscode: 404, message: "Wrong path, file/folder doesn't exist" }, data: [] } })); }
        const s = { id: String(shares.length + 1), share_type: 3, path: params.get("path"), url: `http://localhost:${port}/index.php/s/TOKEN${shares.length + 1}`, expiration: params.get("expireDate") };
        shares.push(s); return send(s);
      }
      if (!u.pathname.startsWith(prefix)) { res.writeHead(404); return res.end(); }
      const rel = decodeURIComponent(u.pathname.slice(prefix.length)).replace(/^\/+|\/+$/g, "");
      const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      switch (req.method) {
        case "MKCOL":
          if (dirs.has(rel) || files.has(rel)) { res.writeHead(405); return res.end(); }
          if (!dirs.has(parent)) { res.writeHead(409); return res.end(); }
          dirs.add(rel); res.writeHead(201); return res.end();
        case "PUT":
          if (!dirs.has(parent)) { res.writeHead(409); return res.end(); }
          const existed = files.has(rel);
          files.set(rel, { data: body, ct: req.headers["content-type"], mtime: new Date() });
          res.writeHead(existed ? 204 : 201); return res.end();
        case "GET":
          if (!files.has(rel)) { res.writeHead(404); return res.end(); }
          const f = files.get(rel);
          res.writeHead(200, { "Content-Type": f.ct, "Content-Length": f.data.length }); return res.end(f.data);
        case "DELETE":
          if (files.delete(rel)) { res.writeHead(204); return res.end(); }
          if (dirs.has(rel)) { for (const k of [...files.keys()]) if (k.startsWith(rel + "/")) files.delete(k); for (const d of [...dirs]) if (d === rel || d.startsWith(rel + "/")) dirs.delete(d); res.writeHead(204); return res.end(); }
          res.writeHead(404); return res.end();
        case "PROPFIND": {
          const depth = req.headers.depth || "1";
          const isDir = dirs.has(rel);
          if (!isDir && !files.has(rel)) { res.writeHead(404); return res.end(); }
          const enc = (p) => prefix + "/" + p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
          const entry = (p, d) => {
            const f = files.get(p);
            return `<d:response><d:href>${enc(p)}${d ? "/" : ""}</d:href><d:propstat><d:prop>
<d:getlastmodified>${(f ? f.mtime : new Date()).toUTCString()}</d:getlastmodified>
${d ? "<d:resourcetype><d:collection/></d:resourcetype>" : `<d:resourcetype/><d:getcontentlength>${f.data.length}</d:getcontentlength><d:getcontenttype>${f.ct}</d:getcontenttype>`}
<d:getetag>"e${p.length}"</d:getetag><oc:fileid>${p.length + 100}</oc:fileid><oc:size>${d ? 0 : f.data.length}</oc:size><oc:permissions>RDNVW</oc:permissions>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
          };
          let out = entry(rel, isDir);
          if (isDir && depth !== "0") {
            for (const d of dirs) if (d && (d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") === rel && d !== rel) out += entry(d, true);
            for (const k of files.keys()) if ((k.includes("/") ? k.slice(0, k.lastIndexOf("/")) : "") === rel) out += entry(k, false);
          }
          res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
          return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns">${out}</d:multistatus>`);
        }
        default: res.writeHead(405); res.end();
      }
    });
  });
  return new Promise((r) => srv.listen(port, () => r({ srv, files, dirs, shares, log })));
}
module.exports = { start };
