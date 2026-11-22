/*
 * Zeiterfassung – Backup der Datenbank, auch im laufenden Betrieb.
 *   node server/backup.js                 schreibt die Kopie nach stdout
 *   node server/backup.js datei.db        schreibt die Kopie in datei.db
 * Datenbank über DB_FILE, sonst data/zeiterfassung.db
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const src = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'zeiterfassung.db');
if (!fs.existsSync(src)) {
  console.error(`Keine Datenbank gefunden: ${src}`);
  process.exit(1);
}
const target = process.argv[2];
if (target && fs.existsSync(target)) {
  console.error(`Die Zieldatei gibt es schon: ${target}`);
  process.exit(1);
}
const out = target || path.join(os.tmpdir(), `zeiterfassung-backup-${process.pid}.db`);
const db = new DatabaseSync(src);
db.exec('PRAGMA busy_timeout = 5000');
db.prepare('VACUUM INTO ?').run(out);
db.close();
if (!target) {
  process.stdout.write(fs.readFileSync(out));
  fs.unlinkSync(out);
}
