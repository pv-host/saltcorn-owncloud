"use strict";
/**
 * Saltcorn-Plugin: ownCloud 10.x per WebDAV
 *
 * - Plugin-Konfiguration: URL, technischer Benutzer, App-Passwort, Basisordner
 * - View-Typ "ownCloudDateien": Dateiliste je Datensatz mit Unterordnern,
 *   Download/Vorschau (über Saltcorn geproxyt), Upload, Ordner anlegen,
 *   Löschen und öffentliche Links
 * - Aktionen: "owncloud_ordner_anlegen" (z.B. Trigger bei Insert),
 *             "owncloud_link_erzeugen" (öffentlicher Link in ein Feld schreiben)
 */
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const Role = require("@saltcorn/data/models/role");
const { div, script, domReady, text } = require("@saltcorn/markup/tags");
const {
  OwnCloudClient,
  OwnCloudError,
  joinPath,
  fillTemplate,
  pipeToExpress,
} = require("./lib/owncloud");

const INLINE_SAFE = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
];

// ----------------------------------------------------------------------------
// Plugin-Konfiguration
// ----------------------------------------------------------------------------
const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "ownCloud-Verbindung",
        form: async () =>
          new Form({
            fields: [
              {
                name: "base_url",
                label: "ownCloud-URL",
                sublabel:
                  "z.B. https://cloud.pv-host.net (ohne /remote.php/...). Bei Installation in Unterordner: https://host/owncloud",
                type: "String",
                required: true,
              },
              {
                name: "username",
                label: "Technischer Benutzer",
                sublabel: "Eigener ownCloud-Benutzer nur für Saltcorn",
                type: "String",
                required: true,
              },
              {
                name: "password",
                label: "App-Passwort",
                sublabel:
                  "ownCloud > Einstellungen > Sicherheit > App-Passwörter",
                type: "String",
                input_type: "password",
                required: true,
              },
              {
                name: "root_folder",
                label: "Basisordner",
                sublabel:
                  "Alle Pfade liegen unterhalb dieses Ordners, z.B. Saltcorn",
                type: "String",
                default: "Saltcorn",
              },
              {
                name: "timeout_ms",
                label: "Timeout (ms)",
                type: "Integer",
                default: 30000,
              },
            ],
          }),
      },
    ],
  });

// ----------------------------------------------------------------------------
// Hilfsfunktionen
// ----------------------------------------------------------------------------
const roleOf = (req) => (req && req.user && req.user.id ? req.user.role_id : 100);

/** Liest die Zeile mit Rechteprüfung und ermittelt den Basisordner. */
async function resolveRowFolder(table_id, config, id, req) {
  const table = await Table.findOne({ id: table_id });
  if (!table) throw new OwnCloudError("Tabelle nicht gefunden", 404);
  if (id === undefined || id === null || id === "")
    throw new OwnCloudError("Keine Datensatz-ID", 400);
  const row = await table.getRow(
    { [table.pk_name]: id },
    req && req.user && req.user.id ? { forUser: req.user } : { forPublic: true }
  );
  if (!row) throw new OwnCloudError("Datensatz nicht gefunden oder kein Zugriff", 403);
  let folder;
  if (config.path_mode === "field" && config.path_field)
    folder = row[config.path_field];
  else folder = fillTemplate(config.path_template || "{id}", row);
  folder = joinPath(folder || "");
  if (!folder)
    throw new OwnCloudError("Für diesen Datensatz ist kein ownCloud-Ordner hinterlegt", 400);
  return { table, row, folder };
}

const errJson = (e) => ({
  json: { error: e.message || String(e), status: e.status || 500 },
});

// ----------------------------------------------------------------------------
// View-Typ "ownCloudDateien"
// ----------------------------------------------------------------------------
const makeViewTemplate = (pluginCfg) => {
  const client = () => new OwnCloudClient(pluginCfg || {});

  const view_configuration_workflow = () =>
    new Workflow({
      steps: [
        {
          name: "Ordner und Rechte",
          form: async (context) => {
            const table = await Table.findOne({ id: context.table_id });
            const strFields = (await table.getFields())
              .filter((f) => f.type && f.type.name === "String")
              .map((f) => f.name);
            const roles = await Role.find({}, { orderBy: "id" });
            const roleOpts = roles.map((r) => ({ label: r.role, name: `${r.id}` }));
            return new Form({
              fields: [
                {
                  name: "path_mode",
                  label: "Ordner bestimmen über",
                  type: "String",
                  required: true,
                  attributes: {
                    options: [
                      { name: "template", label: "Pfadvorlage" },
                      { name: "field", label: "Feld der Tabelle" },
                    ],
                  },
                  default: "template",
                },
                {
                  name: "path_template",
                  label: "Pfadvorlage",
                  sublabel:
                    "Platzhalter in geschweiften Klammern, z.B. Zertifizierungen/{fallnummer}",
                  type: "String",
                  default: `${table.name}/{${table.pk_name}}`,
                  showIf: { path_mode: "template" },
                },
                {
                  name: "path_field",
                  label: "Feld mit Ordnerpfad",
                  type: "String",
                  attributes: { options: strFields },
                  showIf: { path_mode: "field" },
                },
                {
                  name: "auto_create",
                  label: "Ordner automatisch anlegen, wenn er fehlt",
                  type: "Bool",
                  default: true,
                },
                {
                  name: "min_role_write",
                  label: "Mindestrolle für Upload / neuer Ordner",
                  type: "String",
                  attributes: { options: roleOpts },
                  default: "40",
                },
                {
                  name: "min_role_delete",
                  label: "Mindestrolle für Löschen",
                  type: "String",
                  attributes: { options: roleOpts },
                  default: "1",
                },
                {
                  name: "min_role_share",
                  label: "Mindestrolle für öffentliche Links",
                  type: "String",
                  attributes: { options: roleOpts },
                  default: "40",
                },
                {
                  name: "share_expire_days",
                  label: "Ablauf öffentlicher Links (Tage, 0 = nie)",
                  type: "Integer",
                  default: 30,
                },
                {
                  name: "max_upload_mb",
                  label: "Max. Dateigröße Upload (MB)",
                  type: "Integer",
                  default: 100,
                },
              ],
            });
          },
        },
      ],
    });

  const get_state_fields = async (table_id) => {
    const table = await Table.findOne({ id: table_id });
    return [
      {
        name: table ? table.pk_name : "id",
        type: "Integer",
        primary_key: true,
        required: true,
      },
    ];
  };

  const perms = (config, req) => {
    const r = roleOf(req);
    return {
      write: r <= Number(config.min_role_write || 1),
      del: r <= Number(config.min_role_delete || 1),
      share: r <= Number(config.min_role_share || 1),
    };
  };

  // ---------------- run: rendert Container + Client-Skript ----------------
  const run = async (table_id, viewname, config, state, extra) => {
    const table = await Table.findOne({ id: table_id });
    const id = state[table.pk_name];
    if (id === undefined || id === null || id === "")
      return div({ class: "text-muted" }, "Kein Datensatz ausgewählt");
    const p = perms(config, extra && extra.req);
    const uid = "oc" + Math.random().toString(36).slice(2, 10);
    const opts = {
      viewname,
      id,
      uid,
      write: p.write,
      del: p.del,
      share: p.share,
      maxBytes: Number(config.max_upload_mb || 100) * 1024 * 1024,
    };
    return (
      div(
        { id: uid, class: "owncloud-files", "data-sc-embed-viewname": viewname },
        div(
          { class: "d-flex align-items-center gap-2 mb-2 flex-wrap" },
          `<nav aria-label="Pfad" class="me-auto"><ol class="breadcrumb mb-0 oc-crumbs"></ol></nav>`,
          p.write
            ? `<button type="button" class="btn btn-sm btn-outline-secondary oc-mkdir"><i class="fas fa-folder-plus"></i> Ordner</button>
               <label class="btn btn-sm btn-primary mb-0"><i class="fas fa-upload"></i> Hochladen
                 <input type="file" class="d-none oc-file" multiple></label>`
            : "",
          `<button type="button" class="btn btn-sm btn-outline-secondary oc-reload" title="Aktualisieren"><i class="fas fa-sync-alt"></i></button>`
        ),
        p.write
          ? div(
              { class: "oc-drop border border-2 rounded p-2 mb-2 text-center text-muted small" },
              "Dateien hierher ziehen"
            )
          : "",
        div({ class: "oc-msg" }),
        div({ class: "table-responsive" },
          `<table class="table table-sm table-hover align-middle mb-0">
             <thead><tr><th>Name</th><th class="text-end">Größe</th><th>Geändert</th><th class="text-end"></th></tr></thead>
             <tbody class="oc-body"><tr><td colspan="4" class="text-muted">Lade …</td></tr></tbody>
           </table>`)
      ) + script(domReady(clientScript(opts)))
    );
  };

  // ---------------- Routen (POST /view/<viewname>/<route>) ----------------
  const routes = {
    async list(table_id, viewname, config, body, { req }) {
      try {
        const { folder } = await resolveRowFolder(table_id, config, body.id, req);
        const sub = joinPath(body.sub || "");
        const c = client();
        let items = await c.list(joinPath(folder, sub));
        if (items === null && !sub && config.auto_create) {
          await c.mkdirp(folder);
          items = [];
        }
        if (items === null)
          return { json: { error: "Ordner existiert nicht", status: 404 } };
        return { json: { success: true, sub, items } };
      } catch (e) {
        return errJson(e);
      }
    },

    async download(table_id, viewname, config, body, { req, res }) {
      try {
        const { folder } = await resolveRowFolder(table_id, config, body.id, req);
        const rel = joinPath(folder, body.path || "");
        const name = rel.split("/").pop();
        const r = await client().download(rel);
        const ct = (r.headers.get("content-type") || "").split(";")[0].trim();
        const inline = body.inline === "1" && INLINE_SAFE.includes(ct);
        if (inline) res.setHeader("Content-Security-Policy", "sandbox");
        await pipeToExpress(r, res, name, inline);
      } catch (e) {
        if (!res.headersSent) res.status(e.status && e.status < 600 ? e.status : 500).send(text(e.message));
      }
    },

    async upload(table_id, viewname, config, body, { req }) {
      try {
        if (!perms(config, req).write)
          throw new OwnCloudError("Keine Berechtigung zum Hochladen", 403);
        const { folder } = await resolveRowFolder(table_id, config, body.id, req);
        const dir = joinPath(folder, body.sub || "");
        let files = req.files && req.files.file;
        if (!files) throw new OwnCloudError("Keine Datei übermittelt", 400);
        if (!Array.isArray(files)) files = [files];
        const max = Number(config.max_upload_mb || 100) * 1024 * 1024;
        const c = client();
        await c.mkdirp(dir);
        const done = [];
        for (const f of files) {
          if (f.size > max)
            throw new OwnCloudError(`${f.name}: Datei zu groß`, 413);
          if (f.tempFilePath)
            await c.uploadFile(dir, f.name, f.tempFilePath, f.mimetype);
          else await c.uploadBuffer(joinPath(dir, f.name), f.data, f.mimetype);
          done.push(f.name);
        }
        return { json: { success: true, uploaded: done } };
      } catch (e) {
        return errJson(e);
      }
    },

    async mkdir(table_id, viewname, config, body, { req }) {
      try {
        if (!perms(config, req).write)
          throw new OwnCloudError("Keine Berechtigung", 403);
        const { folder } = await resolveRowFolder(table_id, config, body.id, req);
        await client().mkdirp(joinPath(folder, body.sub || "", body.name || ""));
        return { json: { success: true } };
      } catch (e) {
        return errJson(e);
      }
    },

    async remove(table_id, viewname, config, body, { req }) {
      try {
        if (!perms(config, req).del)
          throw new OwnCloudError("Keine Berechtigung zum Löschen", 403);
        const { folder } = await resolveRowFolder(table_id, config, body.id, req);
        const rel = joinPath(folder, body.path || "");
        if (rel === folder)
          throw new OwnCloudError("Der Datensatz-Ordner selbst kann nicht gelöscht werden", 400);
        await client().remove(rel);
        return { json: { success: true } };
      } catch (e) {
        return errJson(e);
      }
    },

    async share(table_id, viewname, config, body, { req }) {
      try {
        if (!perms(config, req).share)
          throw new OwnCloudError("Keine Berechtigung für Links", 403);
        const { folder } = await resolveRowFolder(table_id, config, body.id, req);
        const link = await client().publicLink(joinPath(folder, body.path || ""), {
          expireDays: Number(config.share_expire_days || 0),
        });
        return { json: { success: true, ...link } };
      } catch (e) {
        return errJson(e);
      }
    },
  };

  return {
    name: "ownCloudDateien",
    description: "Dateien eines Datensatzes in ownCloud (WebDAV)",
    display_state_form: false,
    configuration_workflow: view_configuration_workflow,
    get_state_fields,
    run,
    routes,
  };
};

// ----------------------------------------------------------------------------
// Client-Skript (läuft im Browser, nutzt Saltcorns view_post inkl. CSRF)
// ----------------------------------------------------------------------------
function clientScript(o) {
  return `
(function(){
  var O = ${JSON.stringify(o)};
  var root = document.getElementById(O.uid);
  if (!root) return;
  var sub = "";
  var $ = function(s){ return root.querySelector(s); };
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
  function fmtSize(n){ if(!n) return ""; var u=["B","KB","MB","GB","TB"],i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return n.toFixed(i?1:0).replace(".",",")+" "+u[i]; }
  function fmtDate(s){ if(!s) return ""; var d=new Date(s); return d.toLocaleDateString("de-DE")+" "+d.toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"}); }
  function msg(t, kind){ $(".oc-msg").innerHTML = t ? '<div class="alert alert-'+(kind||"danger")+' py-1 px-2 small mb-2">'+esc(t)+'</div>' : ""; }
  function post(route, data, cb){
    view_post(O.viewname, route, data, function(res){
      if (res && res.error) { msg(res.error); return; }
      cb && cb(res);
    });
  }
  function join(a,b){ return a ? a+"/"+b : b; }
  function crumbs(){
    var parts = sub ? sub.split("/") : [];
    var h = '<li class="breadcrumb-item"><a href="#" data-sub=""><i class="fas fa-cloud"></i></a></li>';
    var acc = "";
    parts.forEach(function(p,i){
      acc = join(acc,p);
      h += i===parts.length-1
        ? '<li class="breadcrumb-item active">'+esc(p)+'</li>'
        : '<li class="breadcrumb-item"><a href="#" data-sub="'+esc(acc)+'">'+esc(p)+'</a></li>';
    });
    $(".oc-crumbs").innerHTML = h;
  }
  function load(){
    msg("");
    crumbs();
    post("list", {id:O.id, sub:sub}, function(res){
      var rows = res.items.map(function(it){
        var p = join(sub, it.name);
        var icon = it.is_dir ? "fa-folder text-warning" : "fa-file text-secondary";
        var name = it.is_dir
          ? '<a href="#" class="oc-open" data-sub="'+esc(p)+'">'+esc(it.name)+'</a>'
          : '<a href="#" class="oc-dl" data-path="'+esc(p)+'" data-inline="1">'+esc(it.name)+'</a>';
        var act = "";
        if (!it.is_dir) act += '<button class="btn btn-sm btn-link oc-dl" data-path="'+esc(p)+'" title="Herunterladen"><i class="fas fa-download"></i></button>';
        if (O.share) act += '<button class="btn btn-sm btn-link oc-share" data-path="'+esc(p)+'" title="Öffentlicher Link"><i class="fas fa-link"></i></button>';
        if (O.del) act += '<button class="btn btn-sm btn-link text-danger oc-del" data-path="'+esc(p)+'" data-name="'+esc(it.name)+'" title="Löschen"><i class="fas fa-trash-alt"></i></button>';
        return '<tr><td><i class="fas '+icon+' me-2"></i>'+name+'</td><td class="text-end text-nowrap">'+(it.is_dir?"":fmtSize(it.size))+'</td><td class="text-nowrap">'+fmtDate(it.last_modified)+'</td><td class="text-end text-nowrap">'+act+'</td></tr>';
      });
      $(".oc-body").innerHTML = rows.length ? rows.join("") : '<tr><td colspan="4" class="text-muted">Ordner ist leer</td></tr>';
    });
  }
  function download(path, inline){
    var f = document.createElement("form");
    f.method = "POST";
    f.action = "/view/" + encodeURIComponent(O.viewname) + "/download";
    f.target = inline ? "_blank" : "_self";
    var add = function(k,v){ var i=document.createElement("input"); i.type="hidden"; i.name=k; i.value=v; f.appendChild(i); };
    add("_csrf", window._sc_globalCsrf || "");
    add("id", O.id); add("path", path); add("inline", inline ? "1" : "0");
    document.body.appendChild(f); f.submit(); f.remove();
  }
  function upload(fileList){
    if (!fileList || !fileList.length) return;
    var fd = new FormData();
    for (var i=0;i<fileList.length;i++){
      if (fileList[i].size > O.maxBytes) { msg(fileList[i].name+": Datei zu groß"); return; }
      fd.append("file", fileList[i], fileList[i].name);
    }
    fd.append("id", O.id); fd.append("sub", sub);
    msg("Lade hoch …", "info");
    post("upload", fd, function(){ msg(""); load(); });
  }
  root.addEventListener("click", function(e){
    var a = e.target.closest("[data-sub],.oc-dl,.oc-share,.oc-del,.oc-reload,.oc-mkdir");
    if (!a || !root.contains(a)) return;
    e.preventDefault();
    if (a.hasAttribute("data-sub")) { sub = a.getAttribute("data-sub"); load(); }
    else if (a.classList.contains("oc-dl")) download(a.getAttribute("data-path"), a.getAttribute("data-inline")==="1");
    else if (a.classList.contains("oc-reload")) load();
    else if (a.classList.contains("oc-mkdir")) {
      var n = prompt("Name des neuen Ordners:");
      if (n) post("mkdir", {id:O.id, sub:sub, name:n}, load);
    }
    else if (a.classList.contains("oc-del")) {
      if (confirm('"'+a.getAttribute("data-name")+'" wirklich löschen? (landet im ownCloud-Papierkorb)'))
        post("remove", {id:O.id, path:a.getAttribute("data-path")}, load);
    }
    else if (a.classList.contains("oc-share")) {
      post("share", {id:O.id, path:a.getAttribute("data-path")}, function(res){
        if (navigator.clipboard) navigator.clipboard.writeText(res.url).catch(function(){});
        msg("Öffentlicher Link"+(res.reused?" (bestehend)":"")+": "+res.url+"  – in die Zwischenablage kopiert", "success");
      });
    }
  });
  var fi = $(".oc-file");
  if (fi) fi.addEventListener("change", function(){ upload(fi.files); fi.value=""; });
  var dz = $(".oc-drop");
  if (dz) {
    ["dragenter","dragover"].forEach(function(ev){ dz.addEventListener(ev,function(e){e.preventDefault(); dz.classList.add("bg-light");}); });
    ["dragleave","drop"].forEach(function(ev){ dz.addEventListener(ev,function(e){e.preventDefault(); dz.classList.remove("bg-light");}); });
    dz.addEventListener("drop", function(e){ upload(e.dataTransfer.files); });
  }
  load();
})();`;
}

// ----------------------------------------------------------------------------
// Aktionen (für Trigger, Buttons, Workflows)
// ----------------------------------------------------------------------------
const makeActions = (pluginCfg) => ({
  owncloud_ordner_anlegen: {
    description:
      "Legt in ownCloud einen Ordner für den Datensatz an und speichert den Pfad optional in einem Feld",
    requireRow: true,
    configFields: async ({ table }) => {
      const strFields = table
        ? (await table.getFields())
            .filter((f) => f.type && f.type.name === "String")
            .map((f) => f.name)
        : [];
      return [
        {
          name: "path_template",
          label: "Pfadvorlage",
          sublabel: "z.B. Zertifizierungen/{fallnummer}",
          type: "String",
          required: true,
        },
        {
          name: "subfolders",
          label: "Unterordner (kommagetrennt, optional)",
          sublabel: "z.B. Antrag, Audit, Zertifikat",
          type: "String",
        },
        {
          name: "save_field",
          label: "Pfad speichern in Feld (optional)",
          type: "String",
          attributes: { options: strFields },
        },
      ];
    },
    run: async ({ row, table, configuration, user }) => {
      const c = new OwnCloudClient(pluginCfg || {});
      const folder = joinPath(fillTemplate(configuration.path_template, row));
      if (!folder) throw new Error("Pfadvorlage ergibt leeren Pfad");
      await c.mkdirp(folder);
      for (const s of String(configuration.subfolders || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean))
        await c.mkdirp(joinPath(folder, s));
      if (configuration.save_field && table && row[configuration.save_field] !== folder)
        await table.updateRow(
          { [configuration.save_field]: folder },
          row[table.pk_name],
          undefined,
          true // keine weiteren Trigger auslösen
        );
      return { notify: `ownCloud-Ordner bereit: ${folder}` };
    },
  },

  owncloud_link_erzeugen: {
    description:
      "Erzeugt einen öffentlichen ownCloud-Link für den Datensatz-Ordner und schreibt ihn in ein Feld",
    requireRow: true,
    configFields: async ({ table }) => {
      const strFields = table
        ? (await table.getFields())
            .filter((f) => f.type && f.type.name === "String")
            .map((f) => f.name)
        : [];
      return [
        { name: "path_template", label: "Pfadvorlage", type: "String", required: true },
        { name: "expire_days", label: "Ablauf (Tage, 0 = nie)", type: "Integer", default: 30 },
        {
          name: "link_field",
          label: "Link speichern in Feld",
          type: "String",
          required: true,
          attributes: { options: strFields },
        },
      ];
    },
    run: async ({ row, table, configuration }) => {
      const c = new OwnCloudClient(pluginCfg || {});
      const folder = joinPath(fillTemplate(configuration.path_template, row));
      await c.mkdirp(folder);
      const link = await c.publicLink(folder, {
        expireDays: Number(configuration.expire_days || 0),
      });
      await table.updateRow(
        { [configuration.link_field]: link.url },
        row[table.pk_name],
        undefined,
        true
      );
      return { notify: `Link: ${link.url}` };
    },
  },
});

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "saltcorn-owncloud",
  configuration_workflow,
  viewtemplates: (cfg) => [makeViewTemplate(cfg)],
  actions: (cfg) => makeActions(cfg),
};
