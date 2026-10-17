# Changelog

## 0.1.1 – 2026-10-17

- Behoben: „Unknown type String in field base_url“ beim Konfigurieren. `@saltcorn/data` und `@saltcorn/markup` stehen jetzt unter `devDependencies` statt unter `peerDependencies`, damit npm keine zweite Saltcorn-Kopie in das Plugin installiert.
- Pfadleiste ohne grauen Theme-Hintergrund, die Buttons bleiben auf schmalen Bildschirmen in einer Zeile, Ablagefläche gestrichelt.
- Spalte „Geändert“ auf schmalen Bildschirmen ausgeblendet.
- package.json: repository, homepage, bugs, author, keywords, files; LICENSE ergänzt.
- Tests: Port des Mock-Servers konfigurierbar (`OC_TEST_PORT`).

## 0.1.0 – 2026-10-12

- Erste Version: View-Typ `ownCloudDateien`, Aktionen `owncloud_ordner_anlegen` und `owncloud_link_erzeugen`.
