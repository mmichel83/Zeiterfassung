# Zeiterfassung

Arbeitszeiterfassung für kleine Firmen. Jeder Mitarbeiter stempelt vom eigenen Handy, das Büro sieht alle Zeiten an einem Ort, korrigiert bei Bedarf und exportiert den Monat für die Lohnabrechnung.

Läuft auf dem eigenen Server, ohne externe Dienste und ohne npm-Pakete. Alle Daten liegen in einer SQLite-Datei.

## Was sie kann

### Für Mitarbeiter (Handy)

- Kommen, Pause, Gehen mit einem Tipp. Es zählt die Uhrzeit des Servers, nicht die des Handys.
- Ohne Netz stempeln (Baustelle, Keller): Die Stempelung wird auf dem Handy gespeichert und automatisch übertragen.
- Projekt wählen, Notiz zur laufenden Zeit
- Aufgaben vom Büro auf „Heute“ sehen und abhaken, auf Wunsch mit Notiz. Die Aufgaben für morgen stehen darunter.
- Zeiten nachtragen, Urlaub, Krankheit und Gleittage eintragen (wenn das Büro das erlaubt)
- Zeitkonto, Wochenstand, voraussichtlicher Feierabend, Resturlaub
- Eigener Monatsbericht als PDF oder CSV
- Lässt sich wie eine App auf den Startbildschirm legen

### Für das Büro (Admin)

- Team-Übersicht: wer ist da, seit wann, auf welchem Projekt, Zeitkonto und erledigte Aufgaben je Person
- Aufgaben planen: was zu tun ist, mit Details (Farbe, Material, Schlüssel …), Baustelle, Tag und für wen. Offene Aufgaben wandern automatisch in den nächsten Tag. Export als CSV.
- Mitarbeiter anlegen und per Link einladen (WhatsApp, E-Mail, Teilen). Der Link setzt auch vergessene Passwörter zurück.
- Sollzeit pro Wochentag, Urlaubstage, Startdatum und Übertrag je Person
- Zeiten aller Mitarbeiter ansehen und korrigieren
- Änderungsprotokoll: wer hat wann was nachgetragen, geändert oder gelöscht, und welche Stempelungen ohne Netz kamen
- Monatsexport als CSV: eine Übersicht pro Person (Ist, Soll, Saldo, Zeitkonto, Urlaub, Krank) und alle Einträge
- Arbeitszeitnachweis pro Person zum Ausdrucken mit Unterschriftszeilen
- Projekte, Firmeneinstellungen, Backup

### Rechnet automatisch

- Gesetzliche Feiertage je Bundesland
- Hinweise nach Arbeitszeitgesetz: mehr als 10 Stunden, zu kurze Pausen (30 Min. ab 6 Std., 45 Min. ab 9 Std., Pausenblöcke ab 15 Min.), weniger als 11 Stunden Ruhezeit, Arbeit an Sonn- und Feiertagen
- Auf Wunsch: fehlende Mindestpause automatisch abziehen

## In Betrieb nehmen

Die Zeiterfassung braucht einen Server, der aus dem Internet erreichbar ist, und eine eigene Adresse mit HTTPS, zum Beispiel `zeit.deine-firma.de`. Ohne HTTPS lassen sich Passwörter nicht sicher übertragen und die App nicht auf dem Handy installieren.

### Variante A: Railway (alles im Browser, auch vom Handy)

Railway baut die App direkt aus diesem GitHub-Repo und kümmert sich um HTTPS. Kosten: Hobby-Tarif ab 5 $ im Monat.

1. Auf [railway.com](https://railway.com) mit dem GitHub-Konto anmelden und den Hobby-Tarif wählen.
2. **New Project** → **Deploy from GitHub repo** → `Zeiterfassung` wählen. Railway erkennt das Dockerfile und baut los.
3. Im Dienst unter **Settings** als Region **EU West** wählen, damit die Daten in der EU liegen.
4. Ein **Volume** anlegen, an den Dienst hängen und als Einhängepfad `/app/data` eintragen. Ohne Volume gehen die Daten bei jedem Update verloren.
5. Unter **Variables** drei Einträge anlegen:
   - `TRUST_PROXY` = `1`
   - `RAILWAY_RUN_UID` = `0` (sonst darf die App nicht ins Volume schreiben)
   - `SETUP_CODE` = ein selbst ausgedachter Code aus 8 bis 12 Buchstaben und Ziffern, nur für die Ersteinrichtung
6. Unter **Settings → Networking** auf **Generate Domain** tippen. Fragt Railway nach dem Port, steht er in den Deploy-Logs in der Zeile, die mit `Zeiterfassung läuft:` beginnt.
7. Die Adresse (`….up.railway.app`) öffnen und mit deinem `SETUP_CODE` einrichten. Am besten gleich, bevor jemand anderes die Adresse kennt.

Eigene Adresse wie `zeit.deine-firma.de`: Unter Networking eine Custom Domain eintragen und beim Domain-Anbieter den angezeigten CNAME-Eintrag anlegen. Danach die Variable `PUBLIC_URL` auf diese Adresse setzen.

Updates: Jede Änderung im Zweig `main` baut Railway automatisch neu. Die Daten im Volume bleiben erhalten.

Railway ist ein US-Anbieter. Für die Arbeitszeitdaten der Mitarbeiter brauchst du einen Auftragsverarbeitungsvertrag mit dem Anbieter. Wer Daten lieber bei einem deutschen Anbieter hält, nimmt Variante B.

### Variante B: eigener Server mit Docker

Ein kleiner virtueller Server reicht völlig (1 CPU, 1–2 GB RAM, zum Beispiel bei Hetzner, IONOS oder Strato).

1. Server mit Ubuntu anlegen und [Docker installieren](https://docs.docker.com/engine/install/ubuntu/).
2. Beim Domain-Anbieter eine Subdomain (z. B. `zeit.deine-firma.de`) per A-Eintrag auf die IP des Servers zeigen lassen.
3. Auf dem Server:

   ```sh
   git clone https://github.com/mmichel83/Zeiterfassung.git
   cd Zeiterfassung
   cp .env.example .env
   nano .env          # DOMAIN=zeit.deine-firma.de eintragen
   docker compose up -d --build
   ```

4. Den Einrichtungscode anzeigen:

   ```sh
   docker compose logs app
   ```

Caddy besorgt das HTTPS-Zertifikat automatisch. Die Daten liegen im Docker-Volume `zeitdaten`.

Updates einspielen: `git pull && docker compose up -d --build`

### Variante C: Node-Hosting ohne Docker

Voraussetzung: Node.js ab Version 22.13 und ein Reverse Proxy mit HTTPS (Caddy, nginx, Apache) vor dem Port.

```sh
PORT=3000 PUBLIC_URL=https://zeit.deine-firma.de TRUST_PROXY=1 npm start
```

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `PORT` | Port des Servers | `3000` |
| `HOST` | Adresse | `0.0.0.0` |
| `DB_FILE` | Pfad der Datenbank | `data/zeiterfassung.db` |
| `PUBLIC_URL` | Adresse für Einladungslinks | wird aus der Anfrage gebildet |
| `TRUST_PROXY` | `1`, wenn ein Reverse Proxy davor sitzt | aus |
| `SETUP_CODE` | fester Code für die Ersteinrichtung | zufällig, steht im Log |
| `TZ` | Zeitzone für Tagesgrenzen | `Europe/Berlin` |

Die App muss direkt auf einer (Sub-)Domain laufen, nicht in einem Unterordner wie `/zeit/`.

### Nur ausprobieren

```sh
npm start
```

Dann <http://localhost:3000> öffnen. Der Einrichtungscode steht in der Ausgabe.

## Erste Schritte im Büro

1. **Einrichten:** Adresse öffnen, Einrichtungscode, Firmenname, Bundesland und den eigenen Admin-Zugang eingeben.
2. **Mitarbeiter anlegen:** Team → „Mitarbeiter anlegen“. Name, Wochenstunden, Arbeitstage, Urlaubstage und das Datum eintragen, ab dem das Zeitkonto zählt.
3. **Einladen:** Den Link per WhatsApp, E-Mail oder „Teilen“ aufs Handy schicken. Er gilt 7 Tage und nur einmal.
4. **Optional:** Unter Einstellungen Projekte anlegen und festlegen, ob Mitarbeiter selbst nachtragen dürfen.

Wechselt jemand von einer anderen Zeiterfassung, trägst du unter Team → Person → Vertrag den bisherigen Stand als Übertrag ein (z. B. `+12:30`).

## Für Mitarbeiter

1. Link aus der Einladung öffnen, Passwort festlegen. Fertig, die Stempeluhr ist offen.
2. Auf den Startbildschirm legen:
   - **iPhone:** In Safari unten auf das Teilen-Symbol, dann „Zum Home-Bildschirm“.
   - **Android:** In Chrome oben rechts auf ⋮, dann „App installieren“ oder „Zum Startbildschirm hinzufügen“.
3. Passwort vergessen? Das Büro schickt einen neuen Link.

## Monatsabschluss

- **Lohnabrechnung:** Team → Monatsexport → „Übersicht als CSV“. Öffnet sich direkt in Excel oder LibreOffice (Semikolon, deutsches Dezimalkomma).
- **Nachweis zum Unterschreiben:** Team → Person → Bericht → „Drucken oder PDF“.
- **Abrechnung nach Projekt:** Im Bericht unter „Inhalt“ ein Projekt wählen, dann drucken oder als CSV laden.
- **Erledigte Aufgaben:** Aufgaben → „Aufgaben im … als CSV“, mit Tag, Baustelle, wer es erledigt hat, wann und mit welcher Notiz.

Im Büro stehen unten die Bereiche Heute, Aufgaben, Team und Einstellungen. Die eigenen Einträge und Berichte findest du unter Team bei deinem Namen.

## Datensicherung

Alle Daten stecken in einer Datei. Sichere sie regelmäßig:

- **Von Hand:** Einstellungen → Datensicherung → „Backup herunterladen“
- **Automatisch jede Nacht** (Docker, per `crontab -e` auf dem Server, vorher `mkdir -p /root/backups`):

  ```sh
  30 2 * * * cd /root/Zeiterfassung && docker compose exec -T app node --disable-warning=ExperimentalWarning server/backup.js > /root/backups/zeit-$(date +\%F).db
  ```

- **Ohne Docker:** `node server/backup.js /pfad/backup.db`

Wiederherstellen: Server stoppen, die Backup-Datei als `zeiterfassung.db` an den Platz der Datenbank legen, Server starten.

## Datenschutz und Recht

Hinweise zur Orientierung, keine Rechtsberatung:

- Arbeitgeber in Deutschland müssen die Arbeitszeit ihrer Beschäftigten erfassen (Bundesarbeitsgericht, Beschluss vom 13.09.2022). Diese App liefert die Aufzeichnung, die Verantwortung bleibt beim Betrieb.
- Gibt es einen Betriebsrat, hat er bei der Einführung mitzubestimmen (§ 87 Abs. 1 Nr. 6 BetrVG).
- Gespeichert werden Name, Benutzername, Arbeitszeiten, Projekte, Notizen und Abwesenheiten (bei Krankheit nur „krank“, keine Diagnose). Informiere die Mitarbeiter darüber und nimm die Verarbeitung in dein Verzeichnis der Verarbeitungstätigkeiten auf.
- Aufzeichnungen nach § 16 Abs. 2 ArbZG sind mindestens zwei Jahre aufzubewahren. Deaktivierte Zugänge behalten deshalb ihre Daten, gelöscht wird nichts automatisch.
- Die App lädt nichts von fremden Servern (keine Google Fonts, kein Tracking). Passwörter werden mit scrypt gespeichert, Anmeldungen sind gegen Durchprobieren gebremst.

## Entwicklung

```sh
npm test
```

Keine Abhängigkeiten, nur Node.js ab 22.13 (für das eingebaute `node:sqlite`).

```
public/            Oberfläche (läuft im Browser)
  js/logic.js      Rechenkern: Feiertage, Soll/Ist, ArbZG, Stempeln, CSV
                   (dieselbe Datei nutzt auch der Server)
  js/api.js        Verbindung zum Server
  js/app.js        Ansichten und Bedienung
  sw.js            Offline-Start der App
server/
  server.js        HTTP-Server, Anmeldung, Rechte, API
  db.js            Datenbank (SQLite)
  backup.js        Backup über die Kommandozeile
tests/             Tests für Rechenkern und Server
```

## Noch nicht enthalten

- Urlaubsanträge mit Genehmigung: Mitarbeiter tragen Abwesenheiten direkt ein, das Büro sieht jede Änderung im Protokoll und kann das Selbsteintragen abschalten.
- Mehrere Firmen oder Standorte in einer Installation
- Fotos zu Aufgaben (vorher/nachher)
- Aufgaben ohne Netz abhaken: Die Liste ist offline sichtbar, das Abhaken braucht Verbindung.
- Feiertage, die nur in einzelnen Gemeinden gelten: als „Sonderurlaub / bezahlt frei“ eintragen
