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
  return new Repo(db);
}

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
    return { name: r.name, state: r.state, autoBreak: !!r.auto_break, employeesCanEdit: !!r.employees_can_edit };
  }
  updateCompany(c) {
    this.s('UPDATE company SET name = ?, state = ?, auto_break = ?, employees_can_edit = ? WHERE id = 1')
      .run(c.name, c.state, c.autoBreak ? 1 : 0, c.employeesCanEdit ? 1 : 0);
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
  }

  // ------------------------------------------------------------- Projekte
  projects() {
    return this.s('SELECT * FROM projects ORDER BY archived, name COLLATE NOCASE').all()
      .map((r) => ({ id: r.id, name: r.name, client: r.client, color: r.color, archived: !!r.archived }));
  }
  project(id) { return this.projects().find((p) => p.id === id) || null; }
  upsertProject(p) {
    this.s(`INSERT INTO projects (id, name, client, color, archived) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET name = excluded.name, client = excluded.client,
            color = excluded.color, archived = excluded.archived`)
      .run(p.id, p.name, p.client, p.color, p.archived ? 1 : 0);
  }
  projectInUse(id) { return !!this.s('SELECT 1 FROM entries WHERE project_id = ? LIMIT 1').get(id); }
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

  /** Konsistente Kopie der Datenbank (für Backups) */
  backupTo(file) {
    this.db.prepare('VACUUM INTO ?').run(file);
  }
}

module.exports = { openDb };
