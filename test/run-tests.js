// Testet Client + Plugin-Routen gegen den ownCloud-Nachbau
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { start } = require("./mock-owncloud");
const { OwnCloudClient, safeSegments, fillTemplate } = require("../lib/owncloud");

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log("  ok -", name); };

(async () => {
  const PORT = Number(process.env.OC_TEST_PORT || 18180);
  const mock = await start(PORT);
  const cfg = { base_url: `http://localhost:${PORT}`, username: "svc", password: "app-pw", root_folder: "Saltcorn" };
  const c = new OwnCloudClient(cfg);

  console.log("Client:");
  await t("Pfad-Sicherheit", () => {
    assert.throws(() => safeSegments("a/../b"));
    assert.throws(() => safeSegments(".."));
    assert.deepStrictEqual(safeSegments("/a//b/ c /"), ["a", "b", "c"]);
    assert.strictEqual(fillTemplate("Zert/{nr}-{name}", { nr: 7, name: "A/B" }), "Zert/7-A-B");
  });
  await t("falsches Passwort -> 401", async () => {
    const bad = new OwnCloudClient({ ...cfg, password: "x" });
    await assert.rejects(bad.list(""), (e) => e.status === 401);
  });
  await t("mkdirp idempotent", async () => {
    await c.mkdirp("Zertifizierungen/Fall 1/Audit");
    await c.mkdirp("Zertifizierungen/Fall 1/Audit");
    assert(mock.dirs.has("Saltcorn/Zertifizierungen/Fall 1/Audit"));
  });
  await t("Upload Stream mit Umlauten + Content-Length", async () => {
    const tmp = path.join(os.tmpdir(), "oc-test.txt");
    fs.writeFileSync(tmp, "Prüfbericht äöü".repeat(1000));
    await c.uploadFile("Zertifizierungen/Fall 1", "Prüfbericht 2026.txt", tmp, "text/plain");
    const put = mock.log.filter((l) => l.method === "PUT").pop();
    assert.strictEqual(put.headers["content-length"], String(fs.statSync(tmp).size));
    assert.strictEqual(put.headers["transfer-encoding"], undefined);
    assert.strictEqual(mock.files.get("Saltcorn/Zertifizierungen/Fall 1/Prüfbericht 2026.txt").data.length, fs.statSync(tmp).size);
  });
  await t("Liste: Ordner zuerst, Größen, ohne Ordner selbst", async () => {
    const items = await c.list("Zertifizierungen/Fall 1");
    assert.deepStrictEqual(items.map((i) => [i.name, i.is_dir]), [["Audit", true], ["Prüfbericht 2026.txt", false]]);
    assert(items[1].size > 1000 && items[1].content_type === "text/plain" && items[1].last_modified);
  });
  await t("Liste nicht vorhandener Ordner -> null", async () => {
    assert.strictEqual(await c.list("gibtsnicht"), null);
  });
  await t("Download", async () => {
    const r = await c.download("Zertifizierungen/Fall 1/Prüfbericht 2026.txt");
    assert((await r.text()).startsWith("Prüfbericht"));
  });
  await t("Öffentlicher Link + Wiederverwendung", async () => {
    const a = await c.publicLink("Zertifizierungen/Fall 1", { expireDays: 30 });
    const b = await c.publicLink("Zertifizierungen/Fall 1", { expireDays: 30 });
    assert(a.url.includes("/index.php/s/") && !a.reused && b.reused && a.url === b.url);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(mock.shares[0].expiration));
  });
  await t("Link auf nicht vorhandene Datei -> Fehler", async () => {
    await assert.rejects(c.publicLink("nix.pdf"), (e) => e.status === 404);
  });
  await t("Löschen", async () => {
    await c.uploadBuffer("Zertifizierungen/Fall 1/weg.txt", "x", "text/plain");
    await c.remove("Zertifizierungen/Fall 1/weg.txt");
    assert(!mock.files.has("Saltcorn/Zertifizierungen/Fall 1/weg.txt"));
  });

  // ---------- Plugin mit Saltcorn-Modellen ----------
  console.log("Plugin:");
  const Table = require("@saltcorn/data/models/table");
  const rows = { 5: { id: 5, fallnummer: "GFA-2026-005", oc_pfad: null, owner: 1 } };
  let updated = null;
  const fakeTable = {
    id: 1, name: "faelle", pk_name: "id",
    getFields: () => [{ name: "fallnummer", type: { name: "String" } }, { name: "oc_pfad", type: { name: "String" } }],
    getRow: async (where, opts) => (opts.forPublic ? null : rows[where.id] || null),
    updateRow: async (v, id) => { updated = { v, id }; Object.assign(rows[id], v); },
  };
  Table.findOne = async () => fakeTable;
  const plugin = require("../index.js");
  const vt = plugin.viewtemplates(cfg)[0];
  const actions = plugin.actions(cfg);
  const viewCfg = { path_mode: "template", path_template: "Zertifizierungen/{fallnummer}", auto_create: true, min_role_write: "40", min_role_delete: "1", min_role_share: "40", share_expire_days: 14, max_upload_mb: 1 };
  const reqAdmin = { user: { id: 1, role_id: 1 } };
  const reqStaff = { user: { id: 2, role_id: 40 } };
  const reqPublic = { user: undefined };

  await t("Plugin-Struktur", () => {
    assert.strictEqual(plugin.sc_plugin_api_version, 1);
    assert.strictEqual(vt.name, "ownCloudDateien");
    assert(["list", "download", "upload", "mkdir", "remove", "share"].every((r) => typeof vt.routes[r] === "function"));
  });
  await t("Konfigurations-Workflows bauen", async () => {
    const wf = plugin.configuration_workflow();
    const form = await wf.steps[0].form({});
    assert(form.fields.find((f) => f.name === "password").input_type === "password");
    const Role = require("@saltcorn/data/models/role");
    Role.find = async () => [{ id: 1, role: "admin" }, { id: 40, role: "staff" }, { id: 80, role: "user" }, { id: 100, role: "public" }];
    const vf = await vt.configuration_workflow().steps[0].form({ table_id: 1 });
    assert(vf.fields.find((f) => f.name === "path_field").attributes.options.includes("oc_pfad"));
  });
  await t("run() rendert HTML mit Skript", async () => {
    const html = await vt.run(1, "faelle_dateien", viewCfg, { id: 5 }, { req: reqStaff });
    assert(html.includes("owncloud-files") && html.includes("view_post") && html.includes('"del":false'));
  });
  await t("list legt Ordner automatisch an", async () => {
    const r = await vt.routes.list(1, "v", viewCfg, { id: 5 }, { req: reqStaff });
    assert(r.json.success && Array.isArray(r.json.items));
    assert(mock.dirs.has("Saltcorn/Zertifizierungen/GFA-2026-005"));
  });
  await t("Öffentlicher Zugriff ohne Rechte wird abgewiesen", async () => {
    const r = await vt.routes.list(1, "v", viewCfg, { id: 5 }, { req: reqPublic });
    assert.strictEqual(r.json.status, 403);
  });
  await t("Path-Traversal wird abgewiesen", async () => {
    const r = await vt.routes.list(1, "v", viewCfg, { id: 5, sub: "../Fall 1" }, { req: reqStaff });
    assert.strictEqual(r.json.status, 400);
  });
  await t("Upload (express-fileupload-Format, mehrere Dateien)", async () => {
    const tmp = path.join(os.tmpdir(), "up1.pdf");
    fs.writeFileSync(tmp, "%PDF-1.4 test");
    const files = { file: [{ name: "Antrag.pdf", size: 13, mimetype: "application/pdf", tempFilePath: tmp }, { name: "Notiz.txt", size: 3, mimetype: "text/plain", data: Buffer.from("abc") }] };
    const r = await vt.routes.upload(1, "v", viewCfg, { id: 5, sub: "Antrag" }, { req: { ...reqStaff, files } });
    assert.deepStrictEqual(r.json.uploaded, ["Antrag.pdf", "Notiz.txt"]);
    assert(mock.files.has("Saltcorn/Zertifizierungen/GFA-2026-005/Antrag/Antrag.pdf"));
  });
  await t("Upload zu groß -> 413", async () => {
    const files = { file: { name: "gross.bin", size: 5 * 1024 * 1024, data: Buffer.alloc(1) } };
    const r = await vt.routes.upload(1, "v", viewCfg, { id: 5 }, { req: { ...reqStaff, files } });
    assert.strictEqual(r.json.status, 413);
  });
  await t("Löschen nur für Admin", async () => {
    const r1 = await vt.routes.remove(1, "v", viewCfg, { id: 5, path: "Antrag/Notiz.txt" }, { req: reqStaff });
    assert.strictEqual(r1.json.status, 403);
    const r2 = await vt.routes.remove(1, "v", viewCfg, { id: 5, path: "Antrag/Notiz.txt" }, { req: reqAdmin });
    assert(r2.json.success);
    const r3 = await vt.routes.remove(1, "v", viewCfg, { id: 5, path: "" }, { req: reqAdmin });
    assert.strictEqual(r3.json.status, 400);
  });
  await t("Share-Route", async () => {
    const r = await vt.routes.share(1, "v", viewCfg, { id: 5, path: "Antrag/Antrag.pdf" }, { req: reqStaff });
    assert(r.json.url.includes("/s/"));
  });
  await t("mkdir-Route", async () => {
    const r = await vt.routes.mkdir(1, "v", viewCfg, { id: 5, sub: "", name: "Zertifikat" }, { req: reqStaff });
    assert(r.json.success && mock.dirs.has("Saltcorn/Zertifizierungen/GFA-2026-005/Zertifikat"));
  });
  await t("Download-Route streamt über echte HTTP-Response (inline PDF)", async () => {
    const srv = http.createServer(async (req, res) => {
      await vt.routes.download(1, "v", viewCfg, { id: 5, path: "Antrag/Antrag.pdf", inline: "1" }, { req: reqStaff, res });
      assert(res.headersSent);
    });
    await new Promise((r) => srv.listen(PORT + 1, r));
    const r = await fetch(`http://localhost:${PORT + 1}/`);
    assert.strictEqual(await r.text(), "%PDF-1.4 test");
    assert(r.headers.get("content-disposition").startsWith("inline;"));
    assert.strictEqual(r.headers.get("content-security-policy"), "sandbox");
    srv.close();
  });
  await t("Download-Route: HTML nie inline", async () => {
    await c.uploadBuffer("Zertifizierungen/GFA-2026-005/x.html", "<script>alert(1)</script>", "text/html");
    const srv = http.createServer(async (req, res) => {
      await vt.routes.download(1, "v", viewCfg, { id: 5, path: "x.html", inline: "1" }, { req: reqStaff, res });
    });
    await new Promise((r) => srv.listen(PORT + 2, r));
    const r = await fetch(`http://localhost:${PORT + 2}/`);
    assert(r.headers.get("content-disposition").startsWith("attachment;"));
    srv.close();
  });
  await t("Aktion: Ordner + Unterordner anlegen, Pfad speichern", async () => {
    const res = await actions.owncloud_ordner_anlegen.run({ row: rows[5], table: fakeTable, configuration: { path_template: "Zertifizierungen/{fallnummer}", subfolders: "Antrag, Audit, Zertifikat", save_field: "oc_pfad" } });
    assert(mock.dirs.has("Saltcorn/Zertifizierungen/GFA-2026-005/Audit"));
    assert.strictEqual(rows[5].oc_pfad, "Zertifizierungen/GFA-2026-005");
    assert(res.notify);
  });
  await t("View mit Pfad aus Feld", async () => {
    const r = await vt.routes.list(1, "v", { ...viewCfg, path_mode: "field", path_field: "oc_pfad" }, { id: 5 }, { req: reqStaff });
    assert(r.json.items.some((i) => i.name === "Audit"));
  });
  await t("Aktion: Link erzeugen und speichern", async () => {
    rows[5].oc_link = null;
    await actions.owncloud_link_erzeugen.run({ row: rows[5], table: fakeTable, configuration: { path_template: "Zertifizierungen/{fallnummer}", expire_days: 7, link_field: "oc_link" } });
    assert(rows[5].oc_link.includes("/s/"));
  });

  console.log(`\n${passed} Tests bestanden`);
  mock.srv.close();
  process.exit(0);
})().catch((e) => { console.error("FEHLER:", e); process.exit(1); });
