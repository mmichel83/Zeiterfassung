// Integrationstests für den Server (echte HTTP-Anfragen, Datenbank im Speicher)
'use strict';
process.env.TZ = process.env.TZ || 'Europe/Berlin';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/server.js');
const ZE = require('../public/js/logic.js');

const at = (day, hhmm) => ZE.combine(day, hhmm);

async function start(opts = {}) {
  const clock = { t: at('2026-11-16', '07:00') };
  const app = createApp({ setupCode: 'ABCD-EFGH', now: () => clock.t, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, clock, close: () => new Promise((r) => app.server.close(r)) };
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
