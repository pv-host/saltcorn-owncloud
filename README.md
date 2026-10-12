# saltcorn-owncloud – Saltcorn-Plugin für ownCloud 10.x

Zeigt die ownCloud-Dateien eines Datensatzes direkt in Saltcorn an. Ohne iframe, ohne Änderungen an den ownCloud-Headern, nur über WebDAV und die OCS-Share-API.

## Funktionen

| Funktion | Umsetzung |
|---|---|
| Dateiliste je Datensatz, inkl. Unterordner und Brotkrumen-Navigation | `PROPFIND` (Depth 1) |
| Download, Vorschau im Browser (PDF/Bilder/Text) | `GET`, gestreamt über Saltcorn |
| Upload (Mehrfachauswahl, Drag & Drop) | `PUT` (Stream mit Content-Length) |
| Neuer Ordner, Ordner automatisch anlegen | `MKCOL` (rekursiv, idempotent) |
| Löschen (landet im ownCloud-Papierkorb) | `DELETE` |
| Öffentlicher Link mit Ablaufdatum, wird wiederverwendet | OCS `POST /ocs/v1.php/apps/files_sharing/api/v1/shares` |
| Aktion **owncloud_ordner_anlegen**: Ordnerstruktur bei Insert anlegen, Pfad ins Feld schreiben | Trigger/Workflow |
| Aktion **owncloud_link_erzeugen**: öffentlichen Link ins Feld schreiben | Trigger/Button |

Rechte: Lesen über die Rechte des Datensatzes (`getRow` mit `forUser`, also inkl. Ownership und `min_role_read`) und die Rolle der View. Upload, Löschen und Links haben jeweils eine eigene Mindestrolle.

Sicherheit: Die Zugangsdaten bleiben auf dem Server, der Browser spricht nie direkt mit ownCloud. `..` in Pfaden wird abgewiesen, Slashes in Feldwerten werden durch `-` ersetzt. HTML/SVG werden nie inline ausgeliefert, und die Inline-Vorschau läuft mit `CSP: sandbox`.

## 1. ownCloud vorbereiten

1. Technischen Benutzer anlegen, z.B. `saltcorn-svc`. Ein eigenes Kontingent ist sinnvoll.
2. Als dieser Benutzer anmelden: **Einstellungen > Sicherheit > App-Passwörter**, dann ein App-Passwort „Saltcorn“ erzeugen.
3. Basisordner `Saltcorn` anlegen. Wenn Mitarbeitende die Dateien auch in ownCloud direkt sehen sollen, den Ordner mit der entsprechenden Gruppe teilen.
4. Verbindung vom Saltcorn-Server aus testen:

```bash
curl -s -u 'saltcorn-svc:APP-PASSWORT' -X PROPFIND -H 'Depth: 1' \
  https://cloud.pv-host.net/remote.php/dav/files/saltcorn-svc/Saltcorn/ | head -20

curl -s -u 'saltcorn-svc:APP-PASSWORT' -H 'OCS-APIRequest: true' \
  'https://cloud.pv-host.net/ocs/v1.php/apps/files_sharing/api/v1/shares?format=json' | head -c 300
```

Eine Antwort `207 Multi-Status` bzw. `"statuscode":100` bedeutet, dass die Verbindung steht.

## 2. Plugin installieren

```bash
# auf dem Saltcorn-Server, als der Benutzer, unter dem Saltcorn läuft
sudo mkdir -p /opt/saltcorn-plugins
sudo cp -r saltcorn-owncloud /opt/saltcorn-plugins/
cd /opt/saltcorn-plugins/saltcorn-owncloud
npm install --omit=dev        # installiert fast-xml-parser
```

In Saltcorn unter **Einstellungen > Module > Hinzufügen**:

- Name: `saltcorn-owncloud`
- Quelle: `local`
- Ort: `/opt/saltcorn-plugins/saltcorn-owncloud`

Danach beim Modul auf **Konfigurieren** klicken:

| Feld | Beispiel |
|---|---|
| ownCloud-URL | `https://cloud.pv-host.net` (bei Unterordner: `https://host/owncloud`) |
| Technischer Benutzer | `saltcorn-svc` |
| App-Passwort | … |
| Basisordner | `Saltcorn` |

Nach Code-Änderungen am Plugin Saltcorn neu starten (`systemctl restart saltcorn`).

## 3. Beispiel: Zertifizierungsfälle

Tabelle `faelle` mit den Feldern `fallnummer` (String), `oc_pfad` (String) und optional `oc_link` (String).

1. **Trigger** (Einstellungen > Ereignisse > Trigger):
   - Wann: `Insert`, Tabelle `faelle`
   - Aktion: `owncloud_ordner_anlegen`
   - Pfadvorlage: `Zertifizierungen/{fallnummer}`
   - Unterordner: `Antrag, Audit, Zertifikat, Korrespondenz`
   - Pfad speichern in Feld: `oc_pfad`

   Für bestehende Datensätze: dieselbe Aktion einmalig über einen Button oder über `loop_rows` ausführen.

2. **View** anlegen: Typ `ownCloudDateien`, Tabelle `faelle`
   - Ordner bestimmen über: `Feld der Tabelle` → `oc_pfad`. Das ist robust, auch wenn sich die Fallnummer später ändert. Alternativ: `Pfadvorlage` → `Zertifizierungen/{fallnummer}`.
   - Mindestrollen: Upload/Ordner = staff, Löschen = admin, Links = staff
   - Ablauf öffentlicher Links: 30 Tage
3. Diese View in die **Show-View** des Falls einbetten (Element „View“, Beziehung „gleicher Datensatz“). Die View bekommt die `id` aus dem State.

## 4. Grenzen und Hinweise

- **Upload-Größe**: Neben dem Plugin-Limit gelten Saltcorns Upload-Limit (express-fileupload), ein eventuelles `client_max_body_size` im nginx vor Saltcorn sowie PHP-Limits und das Kontingent in ownCloud.
- **Selbst signierte Zertifikate**: CA über `NODE_EXTRA_CA_CERTS=/pfad/ca.pem` in der systemd-Unit von Saltcorn bekannt machen.
- **Protokoll in ownCloud**: Alle Aktionen laufen unter dem technischen Benutzer. Wer in Saltcorn gehandelt hat, steht im Saltcorn-Log (`Route /view/... viewroute ... user=`), nicht in ownCloud.
- **S3 als Saltcorn-Dateispeicher**: Ist S3 aktiv, verarbeitet Saltcorn Uploads anders. Das Plugin erwartet die Standardkonfiguration (lokale Temp-Dateien).
- **Bestehende Fälle mit geänderter Fallnummer**: Bei Pfadvorlage-Modus würde ein neuer Ordner entstehen, deshalb lieber den Feld-Modus nutzen.

## 5. Tests

`test/` enthält einen ownCloud-Nachbau (WebDAV + OCS) und 26 Tests für den Client, die Routen (Rechte, Path-Traversal, Upload, Download-Streaming, Links) und die Aktionen:

```bash
npm install --no-save @saltcorn/data @saltcorn/markup
npm test
```

## Dateien

```
saltcorn-owncloud/
├── index.js            Plugin: Konfiguration, View-Typ, Routen, Aktionen, Browser-Skript
├── lib/owncloud.js     WebDAV/OCS-Client (PROPFIND, MKCOL, PUT, GET, DELETE, MOVE, Shares)
├── package.json
└── test/               Mock-Server + Tests
```
