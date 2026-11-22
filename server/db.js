/*
 * Zeiterfassung – Datenbank (SQLite, in Node eingebaut, keine Fremdpakete)
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_V1 = `
CREATE TABLE company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  auto_break INTEGER NOT NULL DEFAULT 0,
  employees_can_edit INTEGER NOT NULL DEFAULT 1
);
INSERT INTO company (id) VALUES (1);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  active INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}',
  active_project_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  breaks TEXT NOT NULL DEFAULT '[]',
  pause_min INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  manual INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX entries_user_start ON entries (user_id, start_at);

CREATE TABLE absences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  from_day TEXT NOT NULL,
  to_day TEXT NOT NULL,
  half INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX absences_user ON absences (user_id, from_day);

-- bereits verarbeitete Offline-Stempelungen (gegen doppelte Übertragung)
CREATE TABLE stamp_ops (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL
);

-- Änderungsprotokoll: wer hat wann was nachgetragen oder geändert
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT,
  subject_id TEXT,
  action TEXT NOT NULL,
  text TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX audit_subject ON audit (subject_id, at);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1) {
    db.exec('BEGIN');
    db.exec(SCHEMA_V1);
    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  }
  if (version < 2) {
    db.exec('BEGIN');
    db.exec(SCHEMA_V2);
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
  }
  if (version < 3) {
    db.exec('BEGIN');
    db.exec(SCHEMA_V3);
    db.exec('PRAGMA user_version = 3');
    db.exec('COMMIT');
  }
  return new Repo(db);
}

// Version 2: Aufgaben, die das Büro vorgibt und Mitarbeiter abhaken
const SCHEMA_V2 = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  day TEXT NOT NULL,
  assignees TEXT NOT NULL DEFAULT '[]',
  done_at INTEGER,
  done_by TEXT,
  done_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  created_by TEXT
);
CREATE INDEX tasks_day ON tasks (day);
CREATE INDEX tasks_open ON tasks (done_at, day);
`;

// Version 3: Baustellen-Infos, Material, Erinnerungen per Push
const SCHEMA_V3 = `
ALTER TABLE projects ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN contact TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN access TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN budget_min INTEGER;
ALTER TABLE projects ADD COLUMN offer_area REAL;
ALTER TABLE projects ADD COLUMN offer_unit_price INTEGER;
ALTER TABLE projects ADD COLUMN offer_sum INTEGER;
ALTER TABLE projects ADD COLUMN done_area REAL;
ALTER TABLE projects ADD COLUMN progress_pct INTEGER;
ALTER TABLE company ADD COLUMN reminder_time TEXT NOT NULL DEFAULT '20:00';
ALTER TABLE company ADD COLUMN hourly_rate INTEGER;
ALTER TABLE company ADD COLUMN vapid_public TEXT;
ALTER TABLE company ADD COLUMN vapid_private TEXT;

CREATE TABLE materials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  item TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  price INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX materials_project ON materials (project_id, day);
CREATE INDEX materials_user ON materials (user_id, day);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- bereits verschickte Erinnerungen (nicht doppelt senden)
CREATE TABLE push_log (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
`;

const json = (v, d) => {
  try { return JSON.parse(v); } catch (_) { return d; }
};

class Repo {
  constructor(db) {
    this.db = db;
    this.q = new Map();
  }
  /** Vorbereitete Abfragen zwischenspeichern */
  s(sql) {
    let st = this.q.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.q.set(sql, st);
    }
    return st;
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  close() { this.db.close(); }

  // ---------------------------------------------------------------- Firma
  company() {
    const r = this.s('SELECT * FROM company WHERE id = 1').get();
    return {
      name: r.name, state: r.state, autoBreak: !!r.auto_break, employeesCanEdit: !!r.employees_can_edit,
      reminderTime: r.reminder_time || '',
      hourlyRate: r.hourly_rate == null ? null : r.hourly_rate,
    };
  }
  updateCompany(c) {
    this.s(`UPDATE company SET name = ?, state = ?, auto_break = ?, employees_can_edit = ?, reminder_time = ?,
            hourly_rate = ? WHERE id = 1`)
      .run(c.name, c.state, c.autoBreak ? 1 : 0, c.employeesCanEdit ? 1 : 0, c.reminderTime || '',
        c.hourlyRate == null ? null : c.hourlyRate);
  }
  vapidKeys() {
    const r = this.s('SELECT vapid_public, vapid_private FROM company WHERE id = 1').get();
    return r.vapid_public ? { publicKey: r.vapid_public, privateJwk: json(r.vapid_private, null) } : null;
  }
  setVapidKeys(k) {
    this.s('UPDATE company SET vapid_public = ?, vapid_private = ? WHERE id = 1').run(k.publicKey, JSON.stringify(k.privateJwk));
  }

  // ------------------------------------------------------------- Benutzer
  static user(r) {
    if (!r) return null;
    return {
      id: r.id, name: r.name, username: r.username, role: r.role, active: !!r.active,
      settings: json(r.settings, {}), activeProjectId: r.active_project_id || null,
      hasPassword: !!r.password_hash, createdAt: r.created_at,
    };
  }
  userCount() { return this.s('SELECT COUNT(*) AS n FROM users').get().n; }
  adminCount() { return this.s("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n; }
  user(id) { return Repo.user(this.s('SELECT * FROM users WHERE id = ?').get(id)); }
  userByName(username) { return this.s('SELECT * FROM users WHERE username = ?').get(username) || null; }
  users() { return this.s('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE').all().map(Repo.user); }
  insertUser(u) {
    this.s(`INSERT INTO users (id, name, username, password_hash, role, active, settings, created_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(u.id, u.name, u.username, u.passwordHash || null, u.role, JSON.stringify(u.settings), u.createdAt || Date.now());
  }
  updateUser(u) {
    this.s('UPDATE users SET name = ?, username = ?, role = ?, active = ?, settings = ? WHERE id = ?')
      .run(u.name, u.username, u.role, u.active ? 1 : 0, JSON.stringify(u.settings), u.id);
  }
  setPassword(id, hash) { this.s('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id); }
  setActiveProject(id, pid) { this.s('UPDATE users SET active_project_id = ? WHERE id = ?').run(pid, id); }

  // ------------------------------------------------- Sitzungen, Einladungen
  insertSession(hash, userId, expires, t) {
    this.s('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hash, userId, t || Date.now(), expires);
  }
  session(hash, t) {
    const r = this.s(`SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(hash, t || Date.now());
    return r ? { expiresAt: r.expires_at, user: Repo.user(r) } : null;
  }
  touchSession(hash, expires) { this.s('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expires, hash); }
  deleteSession(hash) { this.s('DELETE FROM sessions WHERE token_hash = ?').run(hash); }
  deleteSessionsOf(userId, exceptHash) {
    this.s('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptHash || '');
  }
  insertInvite(hash, userId, expires) {
    this.s('DELETE FROM invites WHERE user_id = ?').run(userId);
    this.s('INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hash, userId, expires);
  }
  invite(hash, t) {
    const r = this.s(`SELECT i.expires_at, u.* FROM invites i JOIN users u ON u.id = i.user_id
                   WHERE i.token_hash = ? AND i.expires_at > ? AND u.active = 1`).get(hash, t || Date.now());
    return r ? { expiresAt: r.expires_at, user: Repo.user(r) } : null;
  }
  hasOpenInvite(userId, t) {
    return !!this.s('SELECT 1 FROM invites WHERE user_id = ? AND expires_at > ?').get(userId, t || Date.now());
  }
  deleteInvite(hash) { this.s('DELETE FROM invites WHERE token_hash = ?').run(hash); }
  cleanup(now) {
    const t = now || Date.now();
    this.s('DELETE FROM sessions WHERE expires_at < ?').run(t);
    this.s('DELETE FROM invites WHERE expires_at < ?').run(t);
    this.s('DELETE FROM stamp_ops WHERE at < ?').run(t - 30 * 864e5);
    this.s('DELETE FROM push_log WHERE at < ?').run(t - 30 * 864e5);
  }

  // ------------------------------------------------------------- Projekte
  static project(r) {
    return {
      id: r.id, name: r.name, client: r.client, color: r.color, archived: !!r.archived,
      address: r.address || '', contact: r.contact || '', phone: r.phone || '', access: r.access || '',
      budgetMin: r.budget_min == null ? null : r.budget_min,
      offerArea: r.offer_area == null ? null : r.offer_area,
      offerUnitPrice: r.offer_unit_price == null ? null : r.offer_unit_price,
      offerSum: r.offer_sum == null ? null : r.offer_sum,
      doneArea: r.done_area == null ? null : r.done_area,
      progressPct: r.progress_pct == null ? null : r.progress_pct,
    };
  }
  projects() {
    return this.s('SELECT * FROM projects ORDER BY archived, name COLLATE NOCASE').all().map(Repo.project);
  }
  project(id) {
    const r = this.s('SELECT * FROM projects WHERE id = ?').get(id);
    return r ? Repo.project(r) : null;
  }
  upsertProject(p) {
    const n = (v) => (v == null ? null : v);
    this.s(`INSERT INTO projects (id, name, client, color, archived, address, contact, phone, access, budget_min,
            offer_area, offer_unit_price, offer_sum, done_area, progress_pct)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET name = excluded.name, client = excluded.client,
            color = excluded.color, archived = excluded.archived, address = excluded.address,
            contact = excluded.contact, phone = excluded.phone, access = excluded.access, budget_min = excluded.budget_min,
            offer_area = excluded.offer_area, offer_unit_price = excluded.offer_unit_price, offer_sum = excluded.offer_sum,
            done_area = excluded.done_area, progress_pct = excluded.progress_pct`)
      .run(p.id, p.name, p.client, p.color, p.archived ? 1 : 0, p.address || '', p.contact || '', p.phone || '',
        p.access || '', n(p.budgetMin), n(p.offerArea), n(p.offerUnitPrice), n(p.offerSum), n(p.doneArea), n(p.progressPct));
  }
  projectInUse(id) {
    return !!this.s('SELECT 1 FROM entries WHERE project_id = ? LIMIT 1').get(id)
      || !!this.s('SELECT 1 FROM materials WHERE project_id = ? LIMIT 1').get(id);
  }
  /** Alle Zeiten auf Baustellen, mit Namen (für Auswertungen) */
  projectEntries(projectId) {
    const sql = `SELECT e.*, u.name AS user_name FROM entries e JOIN users u ON u.id = e.user_id
                 WHERE ${projectId ? 'e.project_id = ?' : 'e.project_id IS NOT NULL'} ORDER BY e.start_at DESC`;
    const st = this.s(sql);
    return (projectId ? st.all(projectId) : st.all())
      .map((r) => ({ userId: r.user_id, userName: r.user_name, ...Repo.entry(r) }));
  }
  deleteProject(id) { this.s('DELETE FROM projects WHERE id = ?').run(id); }

  // ------------------------------------------------------------- Einträge
  static entry(r) {
    return {
      id: r.id, projectId: r.project_id || null, start: r.start_at, end: r.end_at == null ? null : r.end_at,
      breaks: json(r.breaks, []), pauseMin: r.pause_min, note: r.note, manual: !!r.manual,
    };
  }
  entries(userId) {
    return this.s('SELECT * FROM entries WHERE user_id = ? ORDER BY start_at').all(userId).map(Repo.entry);
  }
  runningEntries() {
    return this.s('SELECT * FROM entries WHERE end_at IS NULL').all().map((r) => ({ userId: r.user_id, ...Repo.entry(r) }));
  }
  entry(id) {
    const r = this.s('SELECT * FROM entries WHERE id = ?').get(id);
    return r ? { userId: r.user_id, ...Repo.entry(r) } : null;
  }
  upsertEntry(userId, e) {
    this.s(`INSERT INTO entries (id, user_id, project_id, start_at, end_at, breaks, pause_min, note, manual)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, start_at = excluded.start_at,
            end_at = excluded.end_at, breaks = excluded.breaks, pause_min = excluded.pause_min,
            note = excluded.note, manual = excluded.manual
            WHERE entries.user_id = excluded.user_id`)
      .run(e.id, userId, e.projectId || null, e.start, e.end == null ? null : e.end,
        JSON.stringify(e.breaks || []), e.pauseMin || 0, e.note || '', e.manual ? 1 : 0);
  }
  deleteEntry(userId, id) { this.s('DELETE FROM entries WHERE id = ? AND user_id = ?').run(id, userId); }

  // ------------------------------------------------------- Abwesenheiten
  static absence(r) {
    return { id: r.id, type: r.type, from: r.from_day, to: r.to_day, half: !!r.half, note: r.note };
  }
  absences(userId) {
    return this.s('SELECT * FROM absences WHERE user_id = ? ORDER BY from_day').all(userId).map(Repo.absence);
  }
  absence(id) {
    const r = this.s('SELECT * FROM absences WHERE id = ?').get(id);
    return r ? { userId: r.user_id, ...Repo.absence(r) } : null;
  }
  upsertAbsence(userId, a) {
    this.s(`INSERT INTO absences (id, user_id, type, from_day, to_day, half, note) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET type = excluded.type, from_day = excluded.from_day,
            to_day = excluded.to_day, half = excluded.half, note = excluded.note
            WHERE absences.user_id = excluded.user_id`)
      .run(a.id, userId, a.type, a.from, a.to, a.half ? 1 : 0, a.note || '');
  }
  deleteAbsence(userId, id) { this.s('DELETE FROM absences WHERE id = ? AND user_id = ?').run(id, userId); }

  // --------------------------------------------------- Offline-Stempelungen
  opSeen(id) { return !!this.s('SELECT 1 FROM stamp_ops WHERE id = ?').get(id); }
  markOp(id, userId, t) { this.s('INSERT OR IGNORE INTO stamp_ops (id, user_id, at) VALUES (?, ?, ?)').run(id, userId, t || Date.now()); }

  // ------------------------------------------------------------ Protokoll
  log(actorId, subjectId, action, text, detail, t) {
    this.s('INSERT INTO audit (at, actor_id, subject_id, action, text, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(t || Date.now(), actorId, subjectId, action, text, detail ? JSON.stringify(detail) : null);
  }
  auditOf(subjectId, limit) {
    return this.s(`SELECT a.at, a.action, a.text, a.actor_id, u.name AS actor_name FROM audit a
                   LEFT JOIN users u ON u.id = a.actor_id WHERE a.subject_id = ? ORDER BY a.at DESC, a.id DESC LIMIT ?`)
      .all(subjectId, limit || 200)
      .map((r) => ({ at: r.at, action: r.action, text: r.text, actorId: r.actor_id, actorName: r.actor_name || '' }));
  }

  // ------------------------------------------------------------ Aufgaben
  static task(r) {
    return {
      id: r.id, title: r.title, details: r.details, projectId: r.project_id || null, day: r.day,
      assignees: json(r.assignees, []), doneAt: r.done_at == null ? null : r.done_at,
      doneBy: r.done_by || null, doneNote: r.done_note, createdAt: r.created_at,
    };
  }
  task(id) {
    const r = this.s('SELECT * FROM tasks WHERE id = ?').get(id);
    return r ? Repo.task(r) : null;
  }
  /** Aufgaben im Zeitraum plus alles, was davor noch offen ist */
  tasksInRange(from, to) {
    return this.s(`SELECT * FROM tasks WHERE (day BETWEEN ? AND ?) OR (day < ? AND done_at IS NULL)
                   ORDER BY day, created_at`).all(from, to, from).map(Repo.task);
  }
  tasksOfMonth(from, to) {
    return this.s('SELECT * FROM tasks WHERE day BETWEEN ? AND ? ORDER BY day, created_at').all(from, to).map(Repo.task);
  }
  upsertTask(t) {
    this.s(`INSERT INTO tasks (id, title, details, project_id, day, assignees, done_at, done_by, done_note, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET title = excluded.title, details = excluded.details,
            project_id = excluded.project_id, day = excluded.day, assignees = excluded.assignees,
            done_at = excluded.done_at, done_by = excluded.done_by, done_note = excluded.done_note`)
      .run(t.id, t.title, t.details || '', t.projectId || null, t.day, JSON.stringify(t.assignees || []),
        t.doneAt == null ? null : t.doneAt, t.doneBy || null, t.doneNote || '', t.createdAt, t.createdBy || null);
  }
  deleteTask(id) { this.s('DELETE FROM tasks WHERE id = ?').run(id); }
  tasksOfProject(projectId) {
    return this.s('SELECT * FROM tasks WHERE project_id = ? ORDER BY day DESC, created_at DESC LIMIT 300').all(projectId).map(Repo.task);
  }
  openTasksByProject() {
    const out = {};
    for (const r of this.s('SELECT project_id, COUNT(*) AS n FROM tasks WHERE done_at IS NULL AND project_id IS NOT NULL GROUP BY project_id').all()) out[r.project_id] = r.n;
    return out;
  }
  absencesBetween(from, to) {
    return this.s('SELECT * FROM absences WHERE from_day <= ? AND to_day >= ? ORDER BY from_day').all(to, from)
      .map((r) => ({ userId: r.user_id, ...Repo.absence(r) }));
  }

  // ------------------------------------------------------------- Material
  static material(r) {
    return {
      id: r.id, projectId: r.project_id, userId: r.user_id, day: r.day, item: r.item,
      quantity: r.quantity, unit: r.unit, price: r.price == null ? null : r.price, note: r.note, createdAt: r.created_at,
    };
  }
  material(id) {
    const r = this.s('SELECT * FROM materials WHERE id = ?').get(id);
    return r ? Repo.material(r) : null;
  }
  insertMaterial(m) {
    this.s(`INSERT INTO materials (id, project_id, user_id, day, item, quantity, unit, price, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.id, m.projectId, m.userId, m.day, m.item, m.quantity, m.unit, m.price == null ? null : m.price, m.note, m.createdAt);
  }
  deleteMaterial(id) { this.s('DELETE FROM materials WHERE id = ?').run(id); }
  materials({ projectId, userId, from, to }) {
    const where = [];
    const args = [];
    if (projectId) { where.push('m.project_id = ?'); args.push(projectId); }
    if (userId) { where.push('m.user_id = ?'); args.push(userId); }
    if (from) { where.push('m.day >= ?'); args.push(from); }
    if (to) { where.push('m.day <= ?'); args.push(to); }
    return this.s(`SELECT m.*, u.name AS user_name FROM materials m LEFT JOIN users u ON u.id = m.user_id
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.day DESC, m.created_at DESC LIMIT 2000`)
      .all(...args).map((r) => ({ ...Repo.material(r), userName: r.user_name || '' }));
  }
  /** zuletzt verwendete Materialbezeichnungen, für Vorschläge */
  materialItems() {
    return this.s(`SELECT item, unit, MAX(created_at) AS t,
                   (SELECT price FROM materials m2 WHERE m2.item = m.item AND m2.unit = m.unit AND m2.price IS NOT NULL
                    ORDER BY m2.created_at DESC LIMIT 1) AS price
                   FROM materials m GROUP BY item, unit ORDER BY t DESC LIMIT 60`).all()
      .map((r) => ({ item: r.item, unit: r.unit, price: r.price == null ? null : r.price }));
  }

  // ----------------------------------------------------------- Push-Abos
  subscriptionsOf(userId) {
    return this.s('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId)
      .map((r) => ({ endpoint: r.endpoint, userId: r.user_id, p256dh: r.p256dh, auth: r.auth, origin: r.origin }));
  }
  saveSubscription(sub) {
    this.s(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
            auth = excluded.auth, origin = excluded.origin`)
      .run(sub.endpoint, sub.userId, sub.p256dh, sub.auth, sub.origin, sub.createdAt);
  }
  deleteSubscription(endpoint, userId) {
    if (userId) this.s('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
    else this.s('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }
  pushLogged(key) { return !!this.s('SELECT 1 FROM push_log WHERE key = ?').get(key); }
  logPush(key, t) { this.s('INSERT OR IGNORE INTO push_log (key, at) VALUES (?, ?)').run(key, t); }

  /** Konsistente Kopie der Datenbank (für Backups) */
  backupTo(file) {
    this.db.prepare('VACUUM INTO ?').run(file);
  }
}

module.exports = { openDb, SCHEMA_V1 };
