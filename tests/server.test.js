// Integrationstests für den Server (echte HTTP-Anfragen, Datenbank im Speicher)
'use strict';
process.env.TZ = process.env.TZ || 'Europe/Berlin';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/server.js');
const ZE = require('../public/js/logic.js');

const at = (day, hhmm) => ZE.combine(day, hhmm);

const open = new Set();
// Server auch dann schließen, wenn ein Test scheitert (sonst hängt der Testlauf)
test.afterEach(() => {
  for (const close of open) close();
  open.clear();
});

async function start(opts = {}) {
  const clock = { t: at('2026-11-16', '07:00') };
  const app = createApp({ setupCode: 'ABCD-EFGH', now: () => clock.t, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const close = () => new Promise((r) => {
    open.delete(close);
    app.server.close(r);
    app.server.closeAllConnections();
  });
  open.add(close);
  return { app, base, clock, close };
}

function client(base) {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : ct.includes('sqlite') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

async function setupCompany(s) {
  const admin = client(s.base);
  const r = await admin('POST', '/api/setup', {
    code: 'abcd efgh', company: 'Muster GmbH', state: 'BY', name: 'Chefin', username: 'chefin', password: 'geheim123',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return admin;
}

async function addEmployee(s, admin, name, username) {
  const r = await admin('POST', '/api/users', { name, username, settings: { targets: [0, 480, 480, 480, 480, 480, 0], startDate: '2026-11-16' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const token = r.data.invite.url.split('#einladung/')[1];
  const emp = client(s.base);
  const info = await emp('GET', '/api/invite/' + token);
  assert.equal(info.data.name, name);
  const set = await emp('POST', '/api/invite/' + token, { password: 'passwort1' });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  return { emp, id: r.data.user.id, token };
}

test('Ersteinrichtung mit Code', async () => {
  const s = await start();
  const anon = client(s.base);
  assert.equal((await anon('GET', '/api/session')).data.needsSetup, true);
  const bad = await anon('POST', '/api/setup', { code: 'XXXX-XXXX', name: 'A', username: 'aa', password: 'geheim123' });
  assert.equal(bad.status, 403);
  const admin = await setupCompany(s);
  const sess = await admin('GET', '/api/session');
  assert.equal(sess.data.user.role, 'admin');
  assert.equal(sess.data.company.state, 'BY');
  const again = await anon('POST', '/api/setup', { code: 'ABCD-EFGH', name: 'B', username: 'bb', password: 'geheim123' });
  assert.equal(again.status, 409);
  await s.close();
});

test('Anmeldung, Fehlversuche, Abmeldung', async () => {
  const s = await start();
  await setupCompany(s);
  const c = client(s.base);
  assert.equal((await c('POST', '/api/login', { username: 'chefin', password: 'falsch' })).status, 401);
  assert.equal((await c('POST', '/api/login', { username: 'CHEFIN', password: 'geheim123' })).status, 200);
  assert.equal((await c('GET', '/api/state')).status, 200);
  await c('POST', '/api/logout', {});
  assert.equal((await c('GET', '/api/state')).status, 401);
  const x = client(s.base);
  for (let i = 0; i < 8; i++) await x('POST', '/api/login', { username: 'chefin', password: 'falsch' });
  assert.equal((await x('POST', '/api/login', { username: 'chefin', password: 'geheim123' })).status, 429);
  await s.close();
});

test('Einladung, Stempeln mit Serverzeit, Team-Übersicht', async () => {
  const s = await start();
  const admin = await setupCompany(s);
  const { emp, id, token } = await addEmployee(s, admin, 'Anna Schmidt', 'anna');

  // Einladungslink ist nur einmal gültig
  assert.equal((await client(s.base)('GET', '/api/invite/' + token)).status, 404);

  s.clock.t = at('2026-11-16', '07:55');
  let r = await emp('POST', '/api/stamp', { action: 'in', at: 0 }); // at wird ohne offline ignoriert
  assert.equal(r.status, 200);
  assert.equal(ZE.timeOfDay(r.data.state.entries[0].start), '07:55');
  assert.equal((await emp('POST', '/api/stamp', { action: 'in' })).status, 409);

  s.clock.t = at('2026-11-16', '12:00');
  await emp('POST', '/api/stamp', { action: 'breakStart' });
  let team = await admin('GET', '/api/team');
  const anna = () => team.data.users.find((u) => u.id === id);
  assert.equal(anna().status, 'break');

  s.clock.t = at('2026-11-16', '12:30');
  await emp('POST', '/api/stamp', { action: 'breakEnd' });
  s.clock.t = at('2026-11-16', '16:30');
  r = await emp('POST', '/api/stamp', { action: 'out' });
  const e = r.data.state.entries[0];
  assert.equal(ZE.entryNetMin(e, s.clock.t), 485);
  assert.equal(r.data.state.settings.state, 'BY'); // Bundesland kommt von der Firma

  team = await admin('GET', '/api/team');
  assert.equal(anna().status, 'off');
  assert.equal(anna().todayMin, 485);
  assert.equal(anna().invitePending, false);

  // Mitarbeiter darf nichts vom Team sehen
  assert.equal((await emp('GET', '/api/team')).status, 403);
  const adminId = (await admin('GET', '/api/session')).data.user.id;
  assert.equal((await emp('GET', '/api/state?user=' + adminId)).status, 403);
  // Admin darf Annas Daten sehen
  assert.equal((await admin('GET', '/api/state?user=' + id)).data.state.entries.length, 1);
  await s.close();
});

test('Offline-Stempelungen: übernehmen, nicht doppelt, nicht zu alt', async () => {
  const s = await start();
  const admin = await setupCompany(s);
  const { emp } = await addEmployee(s, admin, 'Ben', 'ben');
  s.clock.t = at('2026-11-16', '09:00');
  const op = { opId: 'op-1', action: 'in', offline: true, at: at('2026-11-16', '07:30') };
  let r = await emp('POST', '/api/stamp', op);
  assert.equal(ZE.timeOfDay(r.data.state.entries[0].start), '07:30');
  r = await emp('POST', '/api/stamp', op);
  assert.equal(r.data.duplicate, true);
  assert.equal(r.data.state.entries.length, 1);
  r = await emp('POST', '/api/stamp', { opId: 'op-2', action: 'out', offline: true, at: at('2026-11-12', '17:00') });
  assert.equal(r.status, 422);
  const audit = await admin('GET', `/api/users/${(await emp('GET', '/api/session')).data.user.id}/audit`);
  assert.match(audit.data.items[0].text, /Ohne Netz gestempelt: Kommen um 07:30/);
  await s.close();
});

test('Nachtragen, Überschneidung, Protokoll, Rechte', async () => {
  const s = await start();
  const admin = await setupCompany(s);
  const { emp, id } = await addEmployee(s, admin, 'Cem', 'cem');
  s.clock.t = at('2026-11-17', '10:00');
  let r = await emp('POST', '/api/entries', { start: at('2026-11-16', '08:00'), end: at('2026-11-16', '16:30'), pauseMin: 30 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.state.entries[0].manual, true);
  r = await emp('POST', '/api/entries', { start: at('2026-11-16', '16:00'), end: at('2026-11-16', '17:00') });
  assert.equal(r.status, 409);
  const entryId = (await emp('GET', '/api/state')).data.state.entries[0].id;
  r = await admin('PUT', '/api/entries/' + entryId, { start: at('2026-11-16', '08:15'), end: at('2026-11-16', '16:30'), pauseMin: 30 });
  assert.equal(r.status, 200);
  const audit = await admin('GET', `/api/users/${id}/audit`);
  assert.match(audit.data.items[0].text, /^Eintrag geändert: vorher Mo 16\.11\.2026, 08:00–16:30, Pause 30 Min\.; jetzt Mo 16\.11\.2026, 08:15/);
  assert.equal(audit.data.items[0].actorName, 'Chefin');

  // Firma verbietet Änderungen durch Mitarbeiter
  await admin('PUT', '/api/company', { employeesCanEdit: false });
  assert.equal((await emp('DELETE', '/api/entries/' + entryId)).status, 403);
  assert.equal((await admin('DELETE', '/api/entries/' + entryId)).status, 200);

  // Abwesenheiten
  await admin('PUT', '/api/company', { employeesCanEdit: true });
  r = await emp('POST', '/api/absences', { type: 'urlaub', from: '2026-12-21', to: '2026-12-31' });
  assert.equal(r.status, 200);
  r = await emp('POST', '/api/absences', { type: 'krank', from: '2026-12-30', to: '2026-12-30' });
  assert.equal(r.status, 409);
  await s.close();
});

test('Sicherheit: fremde Herkunft, Pfade, letzter Admin', async () => {
  const s = await start();
  const admin = await setupCompany(s);
  const r = await admin('POST', '/api/stamp', { action: 'in' }, { origin: 'https://boese.example' });
  assert.equal(r.status, 403);
  assert.equal((await admin('GET', '/%2e%2e/server/server.js')).status, 404);
  assert.equal((await admin('GET', '/')).status, 200);
  assert.match((await admin('GET', '/')).headers.get('content-security-policy'), /default-src 'self'/);
  const me = (await admin('GET', '/api/session')).data.user.id;
  assert.equal((await admin('PUT', '/api/users/' + me, { role: 'employee' })).status, 409);
  assert.equal((await admin('POST', '/api/users', { name: 'X', username: 'Jürgen' })).status, 422);
  await s.close();
});

test('Exporte und Backup', async () => {
  const s = await start();
  const admin = await setupCompany(s);
  const { emp } = await addEmployee(s, admin, 'Dora; Müller', 'dora');
  s.clock.t = at('2026-11-16', '08:00');
  await emp('POST', '/api/stamp', { action: 'in' });
  s.clock.t = at('2026-11-16', '12:00');
  await emp('POST', '/api/stamp', { action: 'out' });
  s.clock.t = at('2026-11-17', '09:00');
  const ov = await admin('GET', '/api/export/overview.csv?month=2026-11');
  assert.equal(ov.status, 200);
  const line = ov.data.split('\r\n').find((l) => l.startsWith('"Dora; Müller"'));
  assert.ok(line, ov.data);
  assert.match(line, /;dora;4:00;16:00;-12:00;/); // 16.11. 4 von 8 h, heute (17.11.) zählt mit vollem Soll
  const all = await admin('GET', '/api/export/entries.csv?month=2026-11');
  assert.match(all.data, /"Dora; Müller";16\.11\.2026;Mo;08:00;12:00/);
  assert.equal((await emp('GET', '/api/export/overview.csv?month=2026-11')).status, 403);
  const bk = await admin('GET', '/api/backup');
  assert.equal(bk.status, 200);
  assert.equal(bk.data.subarray(0, 15).toString(), 'SQLite format 3');
  await s.close();
});

test('Aufgaben: anlegen, sichtbar nur für Zugewiesene, abhaken, Übertrag, Export', async () => {
  const s = await start();
  const admin = await setupCompany(s);
  const anna = await addEmployee(s, admin, 'Anna', 'anna');
  const ben = await addEmployee(s, admin, 'Ben', 'ben');
  s.clock.t = at('2026-11-16', '07:00');

  // Mitarbeiter dürfen keine Aufgaben anlegen
  assert.equal((await anna.emp('POST', '/api/tasks', { title: 'X', day: '2026-11-16' })).status, 403);
  assert.equal((await admin('POST', '/api/tasks', { title: '', day: '2026-11-16' })).status, 422);

  const r1 = await admin('POST', '/api/tasks', {
    title: 'Fassade grundieren', details: 'Farbe: Sto Weiß\nGerüst steht', day: '2026-11-16', assignees: [anna.id],
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.task.details, 'Farbe: Sto Weiß\nGerüst steht');
  await admin('POST', '/api/tasks', { title: 'Baustelle aufräumen', day: '2026-11-16', assignees: [] });
  await admin('POST', '/api/tasks', { title: 'Flur spachteln', day: '2026-11-17', assignees: [ben.id] });

  let a = await anna.emp('GET', '/api/tasks?from=2026-11-16&to=2026-11-17');
  assert.deepEqual(a.data.tasks.map((x) => x.title), ['Fassade grundieren', 'Baustelle aufräumen']);
  let b = await ben.emp('GET', '/api/tasks?from=2026-11-16&to=2026-11-17');
  assert.deepEqual(b.data.tasks.map((x) => x.title).sort(), ['Baustelle aufräumen', 'Flur spachteln']);
  assert.equal((await admin('GET', '/api/tasks?from=2026-11-16&to=2026-11-17')).data.tasks.length, 3);
  assert.equal((await admin('GET', '/api/tasks?from=2026-11-16&to=2026-11-17&mine=1')).data.tasks.length, 1);

  // Ben darf Annas Aufgabe nicht abhaken
  const t1 = r1.data.task.id;
  assert.equal((await ben.emp('POST', `/api/tasks/${t1}/done`, { note: 'x' })).status, 404);

  s.clock.t = at('2026-11-16', '14:20');
  const done = await anna.emp('POST', `/api/tasks/${t1}/done`, { note: 'zwei Anstriche' });
  assert.equal(done.data.task.doneByName, 'Anna');
  assert.equal(done.data.task.doneNote, 'zwei Anstriche');
  assert.equal((await anna.emp('POST', `/api/tasks/${t1}/done`, {})).status, 409);

  // Offene Aufgaben wandern in den nächsten Tag, erledigte nicht
  s.clock.t = at('2026-11-17', '07:00');
  a = await anna.emp('GET', '/api/tasks?from=2026-11-17&to=2026-11-17');
  assert.deepEqual(a.data.tasks.map((x) => x.title), ['Baustelle aufräumen']);

  // Zähler in der Team-Übersicht
  const team = (await admin('GET', '/api/team')).data.users;
  const annaRow = team.find((u) => u.id === anna.id);
  assert.equal(annaRow.tasksOpen, 1);

  // Wieder öffnen: nur wer es erledigt hat oder das Büro
  const all = (await admin('GET', '/api/tasks?from=2026-11-16&to=2026-11-16')).data.tasks;
  const common = all.find((x) => x.title === 'Baustelle aufräumen').id;
  await ben.emp('POST', `/api/tasks/${common}/done`, {});
  assert.equal((await anna.emp('POST', `/api/tasks/${common}/reopen`, {})).status, 403);
  assert.equal((await ben.emp('POST', `/api/tasks/${common}/reopen`, {})).data.task.doneAt, null);

  // Bearbeiten und löschen nur durchs Büro
  assert.equal((await anna.emp('PUT', `/api/tasks/${t1}`, { title: 'Y' })).status, 403);
  const moved = await admin('PUT', `/api/tasks/${t1}`, { day: '2026-11-18' });
  assert.equal(moved.data.task.day, '2026-11-18');
  assert.equal(moved.data.task.title, 'Fassade grundieren');

  const csv = await admin('GET', '/api/export/tasks.csv?month=2026-11');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Mi;18\.11\.2026;Fassade grundieren;Farbe: Sto Weiß \/ Gerüst steht;;;Anna;ja;Anna;16\.11\.2026 14:20;zwei Anstriche/);
  assert.equal((await admin('DELETE', `/api/tasks/${t1}`)).status, 200);
  // am 18.11. bleiben nur die beiden offenen Aufgaben vom 16. und 17.
  const left = (await admin('GET', `/api/tasks?from=2026-11-18&to=2026-11-18`)).data.tasks;
  assert.deepEqual(left.map((x) => x.title), ['Baustelle aufräumen', 'Flur spachteln']);
  await s.close();
});

test('Datenbank von Version 1 wird ohne Datenverlust erweitert', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const { openDb, SCHEMA_V1 } = require('../server/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ze-mig-'));
  const file = path.join(dir, 'z.db');
  // echte Version-1-Datenbank mit Inhalt anlegen
  const raw = new DatabaseSync(file);
  raw.exec(SCHEMA_V1);
  raw.exec('PRAGMA user_version = 1');
  raw.prepare("INSERT INTO users (id, name, username, role, settings, created_at) VALUES ('u1', 'Alt', 'alt', 'admin', '{}', 1)").run();
  raw.prepare("INSERT INTO projects (id, name, client, color) VALUES ('p1', 'Huber', 'Fam. Huber', '#0f766e')").run();
  raw.prepare("INSERT INTO entries (id, user_id, project_id, start_at, end_at) VALUES ('e1', 'u1', 'p1', 1000, 2000)").run();
  raw.close();

  const repo = openDb(file);
  assert.equal(repo.db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(repo.user('u1').name, 'Alt');
  const p = repo.project('p1');
  assert.equal(p.name, 'Huber');
  assert.equal(p.address, '');
  assert.equal(p.budgetMin, null);
  assert.equal(repo.entries('u1').length, 1);
  assert.equal(repo.company().reminderTime, '20:00');
  assert.deepEqual(repo.tasksInRange('2026-01-01', '2026-12-31'), []);
  repo.close();
  // zweites Öffnen ändert nichts mehr
  const again = openDb(file);
  assert.equal(again.db.prepare('PRAGMA user_version').get().user_version, 4);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ Baustellen, Material, Erinnerungen
const crypto = require('node:crypto');
const push = require('../server/push.js');

function fakeSubscription(name) {
  const ua = crypto.createECDH('prime256v1');
  return {
    ua,
    auth: crypto.randomBytes(16),
    body: { endpoint: `https://web.push.apple.com/${name}`, keys: { p256dh: ua.generateKeys().toString('base64url'), auth: '' } },
  };
}

test('Push: Nachricht ist nach RFC 8291 entschlüsselbar, VAPID-Signatur gültig', () => {
  const ua = crypto.createECDH('prime256v1');
  const uaPub = ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const body = push.encrypt('{"title":"Hallo"}', uaPub.toString('base64url'), auth.toString('base64url'));
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const secret = ua.computeSecret(asPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  assert.equal(plain.subarray(0, -1).toString(), '{"title":"Hallo"}');

  const keys = push.generateVapidKeys();
  const hdr = push.vapidHeader('https://web.push.apple.com/abc', keys, 'https://zeit.example.de', Date.now());
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(hdr);
  assert.equal(k, keys.publicKey);
  const [h, pl, sig] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(pl, 'base64url')).aud, 'https://web.push.apple.com');
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${pl}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));

  assert.equal(push.allowedEndpoint('https://fcm.googleapis.com/fcm/send/x'), true);
  assert.equal(push.allowedEndpoint('https://evil.example/push.apple.com'), false);
  assert.equal(push.allowedEndpoint('http://web.push.apple.com/x'), false);
  assert.equal(push.allowedEndpoint('https://169.254.169.254/latest'), false);
});

test('Baustellen: Infos, Angebot nur fürs Büro, Material, Auswertung, Warnung', async () => {
  const sent = [];
  const s = await start({ manualChecks: true, pushSender: async (sub, data) => { sent.push({ to: sub.userId, ...data }); return 201; } });
  const admin = await setupCompany(s);
  const anna = await addEmployee(s, admin, 'Anna', 'anna');
  await admin('PUT', '/api/company', { hourlyRate: 5200 });

  // Baustelle mit Infos und Angebot in m²
  let r = await admin('POST', '/api/projects', {
    name: 'Wohnung Huber', client: 'Familie Huber', address: 'Hauptstraße 5\n79098 Freiburg', contact: 'Frau Huber',
    phone: '0761 123456', access: 'Schlüssel beim Hausmeister', offerArea: 120, offerUnitPrice: 900,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const pid = r.data.project.id;
  assert.equal(r.data.project.offerUnitPrice, 900);
  assert.equal((await admin('POST', '/api/projects', { name: 'X', phone: 'abc' })).status, 422);

  // Mitarbeiter sieht Adresse, aber keine Angebotszahlen und keinen Stundensatz
  const st = (await anna.emp('GET', '/api/state')).data.state;
  const ap = st.projects.find((p) => p.id === pid);
  assert.equal(ap.address, 'Hauptstraße 5\n79098 Freiburg');
  assert.equal(ap.offerUnitPrice, null);
  assert.equal((await anna.emp('GET', '/api/session')).data.company.hourlyRate, undefined);
  assert.equal((await admin('GET', '/api/session')).data.company.hourlyRate, 5200);
  assert.equal((await anna.emp('GET', '/api/projects/summary')).status, 403);

  // Admin abonniert Mitteilungen
  const sub = fakeSubscription('admin');
  sub.body.keys.auth = crypto.randomBytes(16).toString('base64url');
  assert.equal((await admin('POST', '/api/push/subscribe', { endpoint: 'https://evil.example/x', keys: sub.body.keys })).status, 422);
  assert.equal((await admin('POST', '/api/push/subscribe', sub.body)).status, 200);

  // Anna arbeitet 14 h auf der Baustelle (zwei Tage) und trägt Material ein
  s.clock.t = at('2026-11-16', '07:00');
  await anna.emp('POST', '/api/stamp', { action: 'in', projectId: pid });
  s.clock.t = at('2026-11-16', '14:00');
  await anna.emp('POST', '/api/stamp', { action: 'out' });
  s.clock.t = at('2026-11-17', '07:00');
  await anna.emp('POST', '/api/stamp', { action: 'in', projectId: pid });
  s.clock.t = at('2026-11-17', '14:00');
  await anna.emp('POST', '/api/stamp', { action: 'out' });
  r = await anna.emp('POST', '/api/materials', { projectId: pid, item: 'Wandfarbe weiß', quantity: 2, unit: 'Eimer', price: 6500 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const matId = r.data.material.id;
  assert.equal((await anna.emp('POST', '/api/materials', { projectId: pid, item: '', quantity: 1 })).status, 422);
  assert.equal((await anna.emp('GET', '/api/materials')).data.items[0].item, 'Wandfarbe weiß');

  // ohne Fortschritt: 858 € von 1.080 € = 79 % -> noch keine Warnung
  await s.app.runChecks();
  assert.equal(sent.length, 0);

  // Fortschritt 80 von 120 m² -> Hochrechnung 1.287 € = 19 % drüber
  assert.equal((await anna.emp('PUT', `/api/projects/${pid}/progress`, { doneArea: 80 })).status, 403);
  await admin('PUT', `/api/projects/${pid}/progress`, { doneArea: 80 });
  await s.app.runChecks();
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /Wohnung Huber: voraussichtlich 19 % über dem Angebot/);
  assert.match(sent[0].body, /858 € von 1\.080 €, 67 % fertig/);
  await s.app.runChecks();
  assert.equal(sent.length, 1); // nicht doppelt

  const rep = (await admin('GET', `/api/projects/${pid}/report`)).data;
  assert.equal(rep.workedMin, 14 * 60);
  assert.equal(rep.status.level, 'forecast');
  assert.deepEqual(rep.perUser.map((u) => [u.name, u.min]), [['Anna', 840]]);
  assert.deepEqual(rep.materialSums, [{ item: 'Wandfarbe weiß', unit: 'Eimer', quantity: 2, cost: 13000, priced: true }]);
  const sum = (await admin('GET', '/api/projects/summary')).data.projects.find((p) => p.id === pid);
  assert.equal(sum.workedMin, 840);
  assert.equal(sum.materialCost, 13000);

  // Material löschen: nur eigene oder Büro
  const ben = await addEmployee(s, admin, 'Ben', 'ben');
  assert.equal((await ben.emp('DELETE', `/api/materials/${matId}`)).status, 403);
  assert.equal((await anna.emp('DELETE', `/api/materials/${matId}`)).status, 200);

  // Baustelle mit Zeiten lässt sich nicht löschen
  assert.equal((await admin('DELETE', `/api/projects/${pid}`)).status, 409);

  const csv = await admin('GET', `/api/export/project.csv?id=${pid}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /baustelle-wohnung-huber\.csv/);
  assert.match(csv.data, /Stunden gesamt;14,00/);
  await s.close();
});

test('Erinnerung bei vergessenem Ausstempeln und Wochenplan', async () => {
  const sent = [];
  const s = await start({ manualChecks: true, pushSender: async (sub, data) => { sent.push({ to: sub.userId, ...data }); return 201; } });
  const admin = await setupCompany(s);
  const anna = await addEmployee(s, admin, 'Anna', 'anna');
  const sub = fakeSubscription('anna');
  sub.body.keys.auth = crypto.randomBytes(16).toString('base64url');
  await anna.emp('POST', '/api/push/subscribe', sub.body);

  s.clock.t = at('2026-11-16', '07:00');
  await anna.emp('POST', '/api/stamp', { action: 'in' });
  s.clock.t = at('2026-11-16', '19:55');
  await s.app.runChecks();
  assert.equal(sent.length, 0);
  s.clock.t = at('2026-11-16', '20:05');
  await s.app.runChecks();
  await s.app.runChecks();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, anna.id);
  assert.match(sent[0].body, /seit 07:00 Uhr eingestempelt/);

  // Team zeigt „vergessen“, am nächsten Morgen kommt noch eine Erinnerung
  s.clock.t = at('2026-11-17', '06:30');
  let team = (await admin('GET', '/api/team')).data.users;
  assert.equal(team.find((u) => u.id === anna.id).forgotten, true);
  await s.app.runChecks();
  assert.equal(sent.length, 1);
  s.clock.t = at('2026-11-17', '07:05');
  await s.app.runChecks();
  assert.equal(sent.length, 2);
  assert.match(sent[1].body, /seit Montag 07:00 Uhr/);

  // Erinnerung abschaltbar
  await admin('PUT', '/api/company', { reminderTime: '' });
  assert.equal((await admin('PUT', '/api/company', { reminderTime: '25:00' })).status, 422);

  // Wochenplan
  await admin('POST', '/api/tasks', { title: 'Streichen', day: '2026-11-18', assignees: [anna.id] });
  await anna.emp('POST', '/api/absences', { type: 'urlaub', from: '2026-11-19', to: '2026-11-20' });
  const plan = await admin('GET', '/api/plan?from=2026-11-16&to=2026-11-22');
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.data.tasks.map((x) => x.title), ['Streichen']);
  assert.equal(plan.data.absences[0].userId, anna.id);
  assert.equal(plan.data.users.length, 2);
  assert.equal((await anna.emp('GET', '/api/plan?from=2026-11-16&to=2026-11-22')).status, 403);
  assert.equal((await admin('GET', '/api/plan?from=2026-11-01&to=2026-11-30')).status, 400);

  // Test-Mitteilung
  const t = await anna.emp('POST', '/api/push/test', {});
  assert.equal(t.data.sent, 1);
  await anna.emp('POST', '/api/push/unsubscribe', { endpoint: sub.body.endpoint });
  assert.equal((await anna.emp('POST', '/api/push/test', {})).status, 409);
  await s.close();
});

test('Checklisten: Vorlagen, an Aufgaben hängen, gemeinsam abhaken', async () => {
  const s = await start({ manualChecks: true });
  const admin = await setupCompany(s);
  const anna = await addEmployee(s, admin, 'Anna', 'anna');
  const ben = await addEmployee(s, admin, 'Ben', 'ben');

  // Vorlagen einfügen, zweimal fügt nichts doppelt ein
  let r = await admin('POST', '/api/checklists/vorlagen', {});
  assert.equal(r.status, 200);
  assert.ok(r.data.added >= 5);
  assert.equal((await admin('POST', '/api/checklists/vorlagen', {})).data.added, 0);
  assert.equal((await anna.emp('POST', '/api/checklists/vorlagen', {})).status, 403);

  // eigene Liste
  assert.equal((await admin('POST', '/api/checklists', { title: 'Leer', body: '# nur Überschrift' })).status, 422);
  r = await admin('POST', '/api/checklists', { title: 'Wohnzimmer', body: '- Leiter\n- Abdeckmaschine\n- Acrylspritze\n- Acryl' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cl = r.data.checklist;
  assert.equal((await anna.emp('POST', '/api/checklists', { title: 'X', body: 'a' })).status, 403);
  const all = (await anna.emp('GET', '/api/checklists')).data.checklists;
  assert.ok(all.some((x) => x.id === cl.id));

  // Aufgabe für Anna mit Checkliste
  assert.equal((await admin('POST', '/api/tasks', { title: 'Streichen', day: '2026-11-20', assignees: [anna.id], checklists: ['gibtsnicht'] })).status, 422);
  r = await admin('POST', '/api/tasks', { title: 'Streichen', day: '2026-11-20', assignees: [anna.id], checklists: [cl.id] });
  assert.equal(r.status, 200);
  const task = r.data.task;
  assert.deepEqual(task.checklists, [cl.id]);
  assert.deepEqual(task.checks, []);

  const items = ZE.parseChecklist(cl.body, cl.id).sections[0].items;
  assert.deepEqual(items.map((x) => x.text), ['Leiter', 'Abdeckmaschine', 'Acrylspritze', 'Acryl']);
  r = await anna.emp('POST', `/api/tasks/${task.id}/checks`, { key: items[0].key, done: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.task.checks[0].userName, 'Anna');
  await anna.emp('POST', `/api/tasks/${task.id}/checks`, { key: items[0].key, done: true }); // doppelt schadet nicht
  await anna.emp('POST', `/api/tasks/${task.id}/checks`, { key: items[3].key, done: true });
  assert.equal((await anna.emp('POST', `/api/tasks/${task.id}/checks`, { key: 'fremd:abc', done: true })).status, 422);
  assert.equal((await ben.emp('POST', `/api/tasks/${task.id}/checks`, { key: items[1].key, done: true })).status, 404);

  // Büro sieht den Stand, Punkt wieder abwählen
  let mine = (await anna.emp('GET', '/api/tasks?from=2026-11-20&to=2026-11-20&mine=1')).data.tasks;
  assert.equal(ZE.checklistProgress(ZE.parseChecklist(cl.body, cl.id), Object.fromEntries(mine[0].checks.map((c) => [c.key, 1]))).done, 2);
  await anna.emp('POST', `/api/tasks/${task.id}/checks`, { key: items[3].key, done: false });
  mine = (await admin('GET', '/api/tasks?from=2026-11-20&to=2026-11-20')).data.tasks;
  assert.deepEqual(mine[0].checks.map((c) => c.key), [items[0].key]);

  // Text ändern: unveränderte Punkte behalten ihren Haken
  await admin('PUT', `/api/checklists/${cl.id}`, { body: '# Mitnehmen\n- Leiter\n- Abdeckmaschine\n- Kartuschen' });
  const after = ZE.parseChecklist((await admin('GET', '/api/checklists')).data.checklists.find((x) => x.id === cl.id).body, cl.id);
  assert.equal(after.sections[0].title, 'Mitnehmen');
  assert.equal(ZE.checklistProgress(after, new Set(mine[0].checks.map((c) => c.key))).done, 1);

  // eigene Packliste für eine Aufgabe
  r = await admin('POST', '/api/tasks', { title: 'Innenanstrich Whg Silikat', day: '2026-11-20', assignees: [], checklistBody: '- Leiter\n- Fixativ' });
  const own = r.data.task;
  assert.equal(own.checklistBody, '- Leiter\n- Fixativ');
  const ownKey = ZE.parseChecklist(own.checklistBody, 'eigen').sections[0].items[1].key;
  r = await ben.emp('POST', `/api/tasks/${own.id}/checks`, { key: ownKey, done: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.task.checks[0].userName, 'Ben');
  assert.equal((await ben.emp('POST', `/api/tasks/${task.id}/checks`, { key: 'eigen:abc', done: true })).status, 404);
  const plain = (await admin('POST', '/api/tasks', { title: 'Ohne', day: '2026-11-20' })).data.task;
  assert.equal((await admin('POST', `/api/tasks/${plain.id}/checks`, { key: 'eigen:abc', done: true })).status, 422);

  // Liste löschen: Aufgabe bleibt bearbeitbar
  await admin('DELETE', `/api/checklists/${cl.id}`);
  assert.equal((await admin('PUT', `/api/tasks/${task.id}`, { title: 'Streichen, 2. Anstrich' })).status, 200);
  await s.close();
});
