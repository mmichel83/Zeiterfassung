/*
 * Zeiterfassung – Server
 *
 * Start:  npm start
 * Umgebungsvariablen (alle optional):
 *   PORT=3000              Port
 *   HOST=0.0.0.0           Adresse
 *   DB_FILE=data/zeiterfassung.db
 *   PUBLIC_URL=https://zeit.example.de   Basis für Einladungslinks
 *   TRUST_PROXY=1          hinter einem Reverse Proxy (Caddy, nginx) mit HTTPS
 *   SETUP_CODE=...         fester Code für die Ersteinrichtung
 *   TZ=Europe/Berlin       Zeitzone für Tagesgrenzen
 */
'use strict';
if (!process.env.TZ) process.env.TZ = 'Europe/Berlin';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const ZE = require('../public/js/logic.js');
const { openDb } = require('./db.js');

const scrypt = promisify(crypto.scrypt);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DAY = 864e5;
const SESSION_DAYS = 180;
const INVITE_DAYS = 7;
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/i;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    + "connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; "
    + "frame-ancestors 'none'; form-action 'self'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// ---------------------------------------------------------------- Hilfen
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  const valid = parts[0] === 'scrypt' && parts.length === 3;
  // auch ohne Benutzer rechnen, damit die Antwortzeit nichts verrät
  const key = await scrypt(String(pw || ''), valid ? Buffer.from(parts[1], 'base64') : crypto.randomBytes(16), 64, SCRYPT);
  if (!valid) return false;
  const expected = Buffer.from(parts[2], 'base64');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}
const newToken = () => crypto.randomBytes(32).toString('base64url');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
function randomCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += abc[b[i] % abc.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** Freitext: Steuerzeichen raus, kürzen */
const text = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const clone = (v) => JSON.parse(JSON.stringify(v));

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').includes('application/json')) fail(415, 'Bitte JSON senden.');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1e6) fail(413, 'Die Anfrage ist zu groß.');
    chunks.push(c);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : fail(400, 'Ungültige Anfrage.');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return fail(400, 'Ungültiges JSON.');
  }
}

function describeEntry(e, projects) {
  const k = ZE.dateKey(e.start);
  const p = e.projectId && projects.find((x) => x.id === e.projectId);
  const brk = Math.round(ZE.entryMs(e, e.end != null ? e.end : e.start).brk / ZE.MIN);
  return `${ZE.WEEKDAYS_SHORT[ZE.weekday(k)]} ${ZE.fmtDate(k)}, ${ZE.timeOfDay(e.start)}–${e.end != null ? ZE.timeOfDay(e.end) : 'läuft'}`
    + (brk ? `, Pause ${brk} Min.` : '') + (p ? `, ${p.name}` : '');
}
function describeAbsence(a) {
  return `${ZE.absenceLabel(a)} ${ZE.fmtDate(a.from)}${a.to !== a.from ? '–' + ZE.fmtDate(a.to) : ''}`;
}
const STAMP_LABELS = { in: 'Kommen', out: 'Gehen', breakStart: 'Pause', breakEnd: 'Pause beendet', project: 'Projektwechsel', note: 'Notiz' };

// ----------------------------------------------------------------- App
function createApp(opts = {}) {
  const db = openDb(opts.dbFile || ':memory:');
  const now = opts.now || (() => Date.now());
  const trustProxy = !!opts.trustProxy;
  const publicUrl = String(opts.publicUrl || '').replace(/\/+$/, '');
  let setupCode = db.userCount() === 0 ? (opts.setupCode || randomCode()) : null;
  const attempts = new Map();
  const routes = [];

  // -------------------------------------------------- Begrenzung von Fehlversuchen
  const limited = (key, max) => {
    const a = attempts.get(key);
    return !!a && a.until > now() && a.count >= max;
  };
  const hit = (key) => {
    const a = attempts.get(key);
    if (!a || a.until < now()) attempts.set(key, { count: 1, until: now() + 15 * 60e3 });
    else a.count++;
  };

  // ------------------------------------------------------------- Zustand
  const defaultSettings = () => ({
    targets: [0, 480, 480, 480, 480, 480, 0],
    startDate: ZE.dateKey(now()),
    openingBalanceMin: 0,
    vacationDaysPerYear: 30,
  });

  function loadState(u) {
    const c = db.company();
    return ZE.normalizeState({
      settings: { ...u.settings, name: u.name, state: c.state, autoBreak: c.autoBreak },
      projects: db.projects(),
      entries: db.entries(u.id),
      absences: db.absences(u.id),
      activeProjectId: u.activeProjectId,
      ui: { hintDismissed: true },
    }, now());
  }

  function persistEntries(userId, before, after) {
    const old = new Map(before.map((e) => [e.id, JSON.stringify(e)]));
    const ids = new Set();
    for (const e of after) {
      ids.add(e.id);
      if (old.get(e.id) !== JSON.stringify(e)) db.upsertEntry(userId, e);
    }
    for (const id of old.keys()) if (!ids.has(id)) db.deleteEntry(userId, id);
  }

  function publicUser(u) {
    return {
      id: u.id, name: u.name, username: u.username, role: u.role, active: u.active,
      hasPassword: u.hasPassword, invitePending: !u.hasPassword || db.hasOpenInvite(u.id, now()),
      settings: u.settings,
    };
  }

  function validSettings(s, base) {
    const out = { ...base };
    if (!s || typeof s !== 'object') return out;
    if (s.targets !== undefined) {
      if (!Array.isArray(s.targets) || s.targets.length !== 7
        || s.targets.some((v) => !Number.isInteger(v) || v < 0 || v > 1440)) fail(422, 'Die Sollzeiten sind ungültig.');
      out.targets = s.targets;
    }
    if (s.startDate !== undefined) {
      if (!KEY_RE.test(s.startDate)) fail(422, 'Das Startdatum ist ungültig.');
      out.startDate = s.startDate;
    }
    if (s.openingBalanceMin !== undefined) {
      if (!Number.isInteger(s.openingBalanceMin) || Math.abs(s.openingBalanceMin) > 1e6) fail(422, 'Der Übertrag ist ungültig.');
      out.openingBalanceMin = s.openingBalanceMin;
    }
    if (s.vacationDaysPerYear !== undefined) {
      const v = Number(s.vacationDaysPerYear);
      if (!(v >= 0 && v <= 366) || (v * 2) % 1) fail(422, 'Die Urlaubstage sind ungültig.');
      out.vacationDaysPerYear = v;
    }
    return out;
  }

  function validName(v) {
    const name = text(v, 80);
    if (!name) fail(422, 'Bitte einen Namen angeben.');
    return name;
  }
  function validUsername(v) {
    const u = String(v || '').trim().toLowerCase();
    if (!USERNAME_RE.test(u)) fail(422, 'Der Benutzername darf nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich enthalten (2–40 Zeichen, ohne Umlaute).');
    return u;
  }
  function validPassword(v) {
    const pw = String(v || '');
    if (pw.length < 8) fail(422, 'Das Passwort braucht mindestens 8 Zeichen.');
    if (pw.length > 200) fail(422, 'Das Passwort ist zu lang.');
    return pw;
  }

  // ------------------------------------------------------- Sitzungen
  function startSession(c, userId) {
    const token = newToken();
    db.insertSession(sha(token), userId, now() + SESSION_DAYS * DAY, now());
    c.res.setHeader('Set-Cookie', `ze_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${c.secure ? '; Secure' : ''}`);
    c.sessionHash = sha(token);
  }
  function loadSession(c) {
    const tok = cookies(c.req).ze_sid;
    if (!tok) return;
    const h = sha(tok);
    const s = db.session(h, now());
    if (!s) return;
    if (s.expiresAt - now() < (SESSION_DAYS - 7) * DAY) db.touchSession(h, now() + SESSION_DAYS * DAY);
    c.user = s.user;
    c.sessionHash = h;
  }
  function newInvite(c, userId) {
    const token = newToken();
    const expiresAt = now() + INVITE_DAYS * DAY;
    db.insertInvite(sha(token), userId, expiresAt);
    const base = publicUrl || `${c.secure ? 'https' : 'http'}://${c.req.headers.host}`;
    return { url: `${base}/#einladung/${token}`, expiresAt };
  }

  // ---------------------------------------------------- Berechtigungen
  function subjectOf(c, id) {
    if (!id || id === c.user.id) return db.user(c.user.id);
    if (c.user.role !== 'admin') fail(403, 'Dafür fehlt dir die Berechtigung.');
    const u = db.user(String(id));
    if (!u) fail(404, 'Diesen Mitarbeiter gibt es nicht.');
    return u;
  }
  function mayEdit(c, subject) {
    if (c.user.role === 'admin') return;
    if (subject.id !== c.user.id) fail(403, 'Dafür fehlt dir die Berechtigung.');
    if (!db.company().employeesCanEdit) fail(403, 'Nachträgliche Änderungen macht bei euch das Büro. Sag dort Bescheid.');
  }

  // ------------------------------------------------------------ Routen
  function route(method, pattern, handler, auth) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth: auth || 'user' });
  }

  route('GET', '/api/session', (c) => ({
    user: c.user ? publicUser(c.user) : null,
    company: c.user ? db.company() : { name: db.company().name },
    needsSetup: db.userCount() === 0,
  }), 'none');

  route('POST', '/api/setup', async (c) => {
    if (db.userCount() > 0 || !setupCode) fail(409, 'Die Einrichtung ist schon abgeschlossen.');
    const key = 'setup|' + c.ip;
    if (limited(key, 10)) fail(429, 'Zu viele Versuche. Bitte warte 15 Minuten.');
    if (normCode(c.body.code) !== normCode(setupCode)) {
      hit(key);
      fail(403, 'Der Einrichtungscode stimmt nicht. Du findest ihn in der Ausgabe beim Start des Servers.');
    }
    const company = text(c.body.company, 80);
    const state = ZE.STATES[c.body.state] ? c.body.state : '';
    const name = validName(c.body.name);
    const username = validUsername(c.body.username);
    const hash = await hashPassword(validPassword(c.body.password));
    const id = ZE.uid();
    db.tx(() => {
      if (db.userCount() > 0) fail(409, 'Die Einrichtung ist schon abgeschlossen.');
      db.updateCompany({ name: company, state, autoBreak: false, employeesCanEdit: true });
      db.insertUser({ id, name, username, passwordHash: hash, role: 'admin', settings: defaultSettings(), createdAt: now() });
      db.log(id, id, 'setup', 'Zeiterfassung eingerichtet', null, now());
    });
    setupCode = null;
    startSession(c, id);
    return { user: publicUser(db.user(id)), company: db.company() };
  }, 'none');

  route('POST', '/api/login', async (c) => {
    const username = String(c.body.username || '').trim().toLowerCase();
    const key = `login|${c.ip}|${username}`;
    const ipKey = `ip|${c.ip}`;
    if (limited(key, 8) || limited(ipKey, 40)) fail(429, 'Zu viele Versuche. Bitte warte 15 Minuten.');
    const row = username ? db.userByName(username) : null;
    const ok = await verifyPassword(c.body.password, row && row.active ? row.password_hash : null);
    if (!ok) {
      hit(key);
      hit(ipKey);
      fail(401, 'Benutzername oder Passwort stimmt nicht.');
    }
    attempts.delete(key);
    startSession(c, row.id);
    return { user: publicUser(db.user(row.id)), company: db.company() };
  }, 'none');

  route('POST', '/api/logout', (c) => {
    if (c.sessionHash) db.deleteSession(c.sessionHash);
    c.res.setHeader('Set-Cookie', `ze_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${c.secure ? '; Secure' : ''}`);
    return { ok: true };
  }, 'none');

  route('GET', '/api/invite/:token', (c) => {
    const key = 'invite|' + c.ip;
    if (limited(key, 20)) fail(429, 'Zu viele Versuche. Bitte warte 15 Minuten.');
    const inv = db.invite(sha(c.params.token), now());
    if (!inv) {
      hit(key);
      fail(404, 'Dieser Einladungslink ist ungültig oder abgelaufen. Bitte frag im Büro nach einem neuen.');
    }
    return { name: inv.user.name, username: inv.user.username, company: db.company().name };
  }, 'none');

  route('POST', '/api/invite/:token', async (c) => {
    const pw = validPassword(c.body.password);
    const hash = await hashPassword(pw);
    const h = sha(c.params.token);
    const inv = db.invite(h, now());
    if (!inv) fail(404, 'Dieser Einladungslink ist ungültig oder abgelaufen. Bitte frag im Büro nach einem neuen.');
    db.tx(() => {
      db.setPassword(inv.user.id, hash);
      db.deleteInvite(h);
      db.deleteSessionsOf(inv.user.id);
      db.log(inv.user.id, inv.user.id, 'user.password', 'Passwort über Einladungslink festgelegt', null, now());
    });
    startSession(c, inv.user.id);
    return { user: publicUser(db.user(inv.user.id)), company: db.company() };
  }, 'none');

  route('POST', '/api/password', async (c) => {
    const row = db.userByName(c.user.username);
    if (!(await verifyPassword(c.body.current, row.password_hash))) fail(403, 'Das bisherige Passwort stimmt nicht.');
    const hash = await hashPassword(validPassword(c.body.next));
    db.setPassword(c.user.id, hash);
    db.deleteSessionsOf(c.user.id, c.sessionHash);
    db.log(c.user.id, c.user.id, 'user.password', 'Passwort geändert', null, now());
    return { ok: true };
  });

  route('GET', '/api/state', (c) => ({ state: loadState(subjectOf(c, c.url.searchParams.get('user'))) }));

  // --------------------------------------------------------- Stempeln
  route('POST', '/api/stamp', (c) => {
    const b = c.body;
    const opId = b.opId == null ? null : String(b.opId).slice(0, 64);
    if (opId && db.opSeen(opId)) return { state: loadState(db.user(c.user.id)), duplicate: true };
    let t = now();
    if (b.offline) {
      const at = Number(b.at);
      if (!Number.isFinite(at) || at > t + 5 * 60e3 || at < t - 72 * 3600e3) {
        fail(422, 'Diese Offline-Stempelung ist zu alt und wurde nicht übernommen. Bitte trag die Zeit von Hand nach.');
      }
      t = Math.min(Math.round(at), t);
    }
    let projectId;
    if (b.projectId !== undefined) {
      projectId = b.projectId ? String(b.projectId) : null;
      if (projectId) {
        const p = db.project(projectId);
        if (!p || p.archived) fail(422, 'Dieses Projekt gibt es nicht mehr. Bitte wähle ein anderes.');
      }
    }
    let message;
    db.tx(() => {
      const u = db.user(c.user.id);
      const st = loadState(u);
      const before = clone(st.entries);
      const r = ZE.applyStamp(st, { action: String(b.action), projectId, note: b.note }, t);
      if (r.error) fail(409, r.error);
      persistEntries(u.id, before, st.entries);
      if ((st.activeProjectId || null) !== (u.activeProjectId || null)) db.setActiveProject(u.id, st.activeProjectId);
      if (opId) db.markOp(opId, u.id, now());
      if (b.offline) {
        db.log(u.id, u.id, 'stamp.offline',
          `Ohne Netz gestempelt: ${STAMP_LABELS[b.action] || b.action} um ${ZE.timeOfDay(t)} am ${ZE.fmtDate(ZE.dateKey(t))}, übertragen um ${ZE.timeOfDay(now())}`,
          null, now());
      }
      message = r.message;
    });
    return { state: loadState(db.user(c.user.id)), message };
  });

  // -------------------------------------------------------- Einträge
  function entryInput(b, existing, st, t) {
    const start = Number(b.start);
    if (!Number.isInteger(start)) fail(422, 'Bitte eine Kommen-Zeit angeben.');
    const end = b.end == null || b.end === '' ? null : Number(b.end);
    if (end !== null && !Number.isInteger(end)) fail(422, 'Die Gehen-Zeit ist ungültig.');
    if (end !== null && end <= start) fail(422, 'Gehen muss nach Kommen liegen.');
    if (end !== null && end - start > DAY) fail(422, 'Ein Eintrag darf höchstens 24 Stunden lang sein.');
    if (end === null) {
      if (start > t) fail(422, 'Ohne Gehen-Zeit muss Kommen in der Vergangenheit liegen.');
      const run = ZE.runningEntry(st.entries);
      if (run && (!existing || run.id !== existing.id)) fail(409, 'Es läuft bereits eine Zeit. Gib eine Gehen-Zeit an.');
    }
    const pauseMin = Math.round(Number(b.pauseMin || 0));
    if (!(pauseMin >= 0 && pauseMin <= 1440)) fail(422, 'Die Pause ist ungültig.');
    if (end !== null && pauseMin * ZE.MIN >= end - start) fail(422, 'Die Pause ist länger als die ganze Zeit.');
    let breaks = Array.isArray(b.breaks) ? b.breaks.slice(0, 50).map((x) => ({
      start: Number(x && x.start), end: x && x.end != null ? Number(x.end) : null,
    })).filter((x) => Number.isInteger(x.start) && (x.end === null || (Number.isInteger(x.end) && x.end >= x.start))) : [];
    breaks = breaks.map((x, i) => (x.end === null && (end !== null || i < breaks.length - 1) ? { start: x.start, end: end !== null ? Math.max(x.start, end) : x.start } : x));
    let projectId = b.projectId ? String(b.projectId) : null;
    if (projectId) {
      const p = db.project(projectId);
      if (!p) fail(422, 'Dieses Projekt gibt es nicht mehr.');
      if (p.archived && (!existing || existing.projectId !== projectId)) fail(422, 'Dieses Projekt ist archiviert.');
    }
    const cand = {
      id: existing ? existing.id : ZE.uid(), projectId, start, end, breaks, pauseMin,
      note: text(b.note, 300), manual: true,
    };
    const clash = ZE.findOverlap(st.entries, cand, t);
    if (clash) fail(409, `Überschneidet sich mit ${describeEntry(clash, st.projects)}.`);
    return cand;
  }

  route('POST', '/api/entries', (c) => {
    const subject = subjectOf(c, c.body.userId);
    mayEdit(c, subject);
    db.tx(() => {
      const st = loadState(subject);
      const e = entryInput(c.body, null, st, now());
      db.upsertEntry(subject.id, e);
      db.log(c.user.id, subject.id, 'entry.create', `Zeit nachgetragen: ${describeEntry(e, st.projects)}`, { after: e }, now());
    });
    return { state: loadState(subject) };
  });

  route('PUT', '/api/entries/:id', (c) => {
    const old = db.entry(c.params.id);
    if (!old) fail(404, 'Diesen Eintrag gibt es nicht mehr.');
    const subject = subjectOf(c, old.userId);
    mayEdit(c, subject);
    db.tx(() => {
      const st = loadState(subject);
      const e = entryInput(c.body, old, st, now());
      db.upsertEntry(subject.id, e);
      db.log(c.user.id, subject.id, 'entry.update',
        `Eintrag geändert: vorher ${describeEntry(old, st.projects)}; jetzt ${describeEntry(e, st.projects)}`, { before: old, after: e }, now());
    });
    return { state: loadState(subject) };
  }, 'user');

  route('DELETE', '/api/entries/:id', (c) => {
    const old = db.entry(c.params.id);
    if (!old) fail(404, 'Diesen Eintrag gibt es nicht mehr.');
    const subject = subjectOf(c, old.userId);
    mayEdit(c, subject);
    db.tx(() => {
      db.deleteEntry(subject.id, old.id);
      db.log(c.user.id, subject.id, 'entry.delete', `Eintrag gelöscht: ${describeEntry(old, db.projects())}`, { before: old }, now());
    });
    return { state: loadState(subject) };
  });

  // ---------------------------------------------------- Abwesenheiten
  function absenceInput(b, existing, st) {
    const type = String(b.type);
    if (!ZE.ABSENCE_TYPES[type]) fail(422, 'Bitte eine Art der Abwesenheit wählen.');
    const from = String(b.from || '');
    const to = String(b.to || '') || from;
    if (!KEY_RE.test(from) || !KEY_RE.test(to)) fail(422, 'Bitte gültige Daten angeben.');
    if (to < from) fail(422, 'Das Bis-Datum liegt vor dem Von-Datum.');
    if (ZE.daysBetween(from, to).length > 366) fail(422, 'Eine Abwesenheit darf höchstens ein Jahr lang sein.');
    const half = !!b.half;
    if (half && to !== from) fail(422, 'Einen halben Tag kannst du nur für einen einzelnen Tag eintragen.');
    const clash = st.absences.find((x) => (!existing || x.id !== existing.id) && x.from <= to && from <= x.to);
    if (clash) fail(409, `Überschneidet sich mit ${describeAbsence(clash)}.`);
    return { id: existing ? existing.id : ZE.uid(), type, from, to, half, note: text(b.note, 200) };
  }

  route('POST', '/api/absences', (c) => {
    const subject = subjectOf(c, c.body.userId);
    mayEdit(c, subject);
    db.tx(() => {
      const a = absenceInput(c.body, null, loadState(subject));
      db.upsertAbsence(subject.id, a);
      db.log(c.user.id, subject.id, 'absence.create', `Abwesenheit eingetragen: ${describeAbsence(a)}`, { after: a }, now());
    });
    return { state: loadState(subject) };
  });

  route('PUT', '/api/absences/:id', (c) => {
    const old = db.absence(c.params.id);
    if (!old) fail(404, 'Diese Abwesenheit gibt es nicht mehr.');
    const subject = subjectOf(c, old.userId);
    mayEdit(c, subject);
    db.tx(() => {
      const a = absenceInput(c.body, old, loadState(subject));
      db.upsertAbsence(subject.id, a);
      db.log(c.user.id, subject.id, 'absence.update', `Abwesenheit geändert: vorher ${describeAbsence(old)}; jetzt ${describeAbsence(a)}`, { before: old, after: a }, now());
    });
    return { state: loadState(subject) };
  });

  route('DELETE', '/api/absences/:id', (c) => {
    const old = db.absence(c.params.id);
    if (!old) fail(404, 'Diese Abwesenheit gibt es nicht mehr.');
    const subject = subjectOf(c, old.userId);
    mayEdit(c, subject);
    db.tx(() => {
      db.deleteAbsence(subject.id, old.id);
      db.log(c.user.id, subject.id, 'absence.delete', `Abwesenheit gelöscht: ${describeAbsence(old)}`, { before: old }, now());
    });
    return { state: loadState(subject) };
  });

  // ------------------------------------------------------ Team (Admin)
  route('GET', '/api/team', () => {
    const t = now();
    const k = ZE.dateKey(t);
    const [mFrom] = ZE.monthRange(+k.slice(0, 4), +k.slice(5, 7));
    return {
      now: t,
      users: db.users().map((u) => {
        const st = loadState(u);
        const ctx = ZE.makeContext(st, t);
        const d = ZE.daySummary(ctx, k);
        const run = ZE.runningEntry(st.entries);
        const onBreak = ZE.isOnBreak(run);
        const month = ZE.rangeSummary(ctx, mFrom, k);
        return {
          ...publicUser(u),
          status: run ? (onBreak ? 'break' : 'work') : 'off',
          since: run ? (onBreak ? run.breaks[run.breaks.length - 1].start : ZE.presenceStart(st.entries, run)) : d.lastEnd,
          projectId: run ? run.projectId : null,
          todayMin: run && ZE.dateKey(run.start) !== k ? d.workMin + ZE.entryNetMin(run, t) : d.workMin,
          targetTodayMin: d.targetMin,
          absence: d.absence ? ZE.absenceLabel(d.absence) : null,
          holiday: d.holiday,
          balanceMin: ZE.balanceUntil(ctx, ZE.addDays(k, -1)),
          vacationLeft: ZE.vacation(ctx, +k.slice(0, 4), k).left,
          monthMin: month.workMin,
          warnings: month.days.reduce((n, x) => n + x.warnings.filter((w) => w.code !== 'sunday').length, 0),
        };
      }),
    };
  }, 'admin');

  route('POST', '/api/users', (c) => {
    const name = validName(c.body.name);
    const username = validUsername(c.body.username);
    const role = c.body.role === 'admin' ? 'admin' : 'employee';
    const settings = validSettings(c.body.settings, defaultSettings());
    if (db.userByName(username)) fail(409, `Den Benutzernamen „${username}“ gibt es schon.`);
    const id = ZE.uid();
    let invite;
    db.tx(() => {
      db.insertUser({ id, name, username, role, settings, createdAt: now() });
      invite = newInvite(c, id);
      db.log(c.user.id, id, 'user.create', `Zugang angelegt als ${role === 'admin' ? 'Admin' : 'Mitarbeiter/in'}`, null, now());
    });
    return { user: publicUser(db.user(id)), invite };
  }, 'admin');

  route('PUT', '/api/users/:id', (c) => {
    const u = db.user(c.params.id);
    if (!u) fail(404, 'Diesen Mitarbeiter gibt es nicht.');
    const b = c.body;
    const next = {
      ...u,
      name: b.name !== undefined ? validName(b.name) : u.name,
      username: b.username !== undefined ? validUsername(b.username) : u.username,
      role: b.role !== undefined ? (b.role === 'admin' ? 'admin' : 'employee') : u.role,
      active: b.active !== undefined ? !!b.active : u.active,
      settings: validSettings(b.settings, u.settings),
    };
    if (u.id === c.user.id && (!next.active || next.role !== 'admin')) fail(409, 'Du kannst dir selbst die Admin-Rechte nicht entziehen.');
    const other = db.userByName(next.username);
    if (other && other.id !== u.id) fail(409, `Den Benutzernamen „${next.username}“ gibt es schon.`);
    const changes = [];
    const sum = (s) => ZE.fmtHM((s.targets || []).reduce((a, x) => a + x, 0));
    if (next.name !== u.name) changes.push(`Name „${u.name}“ → „${next.name}“`);
    if (next.username !== u.username) changes.push(`Benutzername ${u.username} → ${next.username}`);
    if (next.role !== u.role) changes.push(next.role === 'admin' ? 'jetzt Admin' : 'jetzt Mitarbeiter/in');
    if (next.active !== u.active) changes.push(next.active ? 'wieder aktiviert' : 'deaktiviert');
    if (JSON.stringify(next.settings.targets) !== JSON.stringify(u.settings.targets)) changes.push(`Sollzeit ${sum(u.settings)} → ${sum(next.settings)} pro Woche`);
    if (next.settings.startDate !== u.settings.startDate) changes.push(`Zeitkonto zählt ab ${ZE.fmtDate(next.settings.startDate)}`);
    if (next.settings.openingBalanceMin !== u.settings.openingBalanceMin) changes.push(`Übertrag ${ZE.fmtHM(next.settings.openingBalanceMin, { signed: true })}`);
    if (next.settings.vacationDaysPerYear !== u.settings.vacationDaysPerYear) changes.push(`Urlaub ${u.settings.vacationDaysPerYear} → ${next.settings.vacationDaysPerYear} Tage`);
    db.tx(() => {
      if (u.role === 'admin' && u.active && (next.role !== 'admin' || !next.active) && db.adminCount() <= 1) {
        fail(409, 'Es muss mindestens einen aktiven Admin geben.');
      }
      db.updateUser(next);
      if (!next.active) db.deleteSessionsOf(u.id);
      if (changes.length) db.log(c.user.id, u.id, 'user.update', changes.join(', '), null, now());
    });
    return { user: publicUser(db.user(u.id)) };
  }, 'admin');

  route('POST', '/api/users/:id/invite', (c) => {
    const u = db.user(c.params.id);
    if (!u) fail(404, 'Diesen Mitarbeiter gibt es nicht.');
    if (!u.active) fail(409, 'Der Zugang ist deaktiviert. Aktiviere ihn zuerst wieder.');
    const invite = newInvite(c, u.id);
    db.log(c.user.id, u.id, 'user.invite', 'Neuer Einladungslink erstellt', null, now());
    return { invite };
  }, 'admin');

  route('GET', '/api/users/:id/audit', (c) => {
    if (!db.user(c.params.id)) fail(404, 'Diesen Mitarbeiter gibt es nicht.');
    return { items: db.auditOf(c.params.id, 300) };
  }, 'admin');

  // ------------------------------------------------- Firma & Projekte
  route('PUT', '/api/company', (c) => {
    const old = db.company();
    const next = {
      name: c.body.name !== undefined ? text(c.body.name, 80) : old.name,
      state: c.body.state !== undefined ? (ZE.STATES[c.body.state] ? c.body.state : '') : old.state,
      autoBreak: c.body.autoBreak !== undefined ? !!c.body.autoBreak : old.autoBreak,
      employeesCanEdit: c.body.employeesCanEdit !== undefined ? !!c.body.employeesCanEdit : old.employeesCanEdit,
    };
    db.updateCompany(next);
    db.log(c.user.id, null, 'company', 'Firmeneinstellungen geändert', { before: old, after: next }, now());
    return { company: db.company() };
  }, 'admin');

  function projectInput(b, old) {
    const name = text(b.name !== undefined ? b.name : old && old.name, 80);
    if (!name) fail(422, 'Bitte gib dem Projekt einen Namen.');
    const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : old ? old.color : ZE.COLORS[db.projects().length % ZE.COLORS.length];
    return {
      id: old ? old.id : ZE.uid(), name, color,
      client: text(b.client !== undefined ? b.client : old && old.client, 80),
      archived: b.archived !== undefined ? !!b.archived : !!(old && old.archived),
    };
  }
  route('POST', '/api/projects', (c) => {
    db.upsertProject(projectInput(c.body, null));
    return { projects: db.projects() };
  }, 'admin');
  route('PUT', '/api/projects/:id', (c) => {
    const old = db.project(c.params.id);
    if (!old) fail(404, 'Dieses Projekt gibt es nicht mehr.');
    db.upsertProject(projectInput(c.body, old));
    return { projects: db.projects() };
  }, 'admin');
  route('DELETE', '/api/projects/:id', (c) => {
    if (!db.project(c.params.id)) fail(404, 'Dieses Projekt gibt es nicht mehr.');
    if (db.projectInUse(c.params.id)) fail(409, 'Auf dieses Projekt sind schon Zeiten gebucht. Archiviere es stattdessen, dann bleiben die Zeiten erhalten.');
    db.deleteProject(c.params.id);
    return { projects: db.projects() };
  }, 'admin');

  // ----------------------------------------------------- Export & Backup
  function monthParam(c) {
    const m = MONTH_RE.exec(c.url.searchParams.get('month') || '');
    if (!m || +m[2] < 1 || +m[2] > 12) fail(400, 'Monat bitte als JJJJ-MM angeben.');
    const [from, to] = ZE.monthRange(+m[1], +m[2]);
    const k = ZE.dateKey(now());
    if (from > k) fail(422, 'Dieser Monat hat noch nicht begonnen.');
    return { from, to: to < k ? to : k, tag: m[0] };
  }
  const csvHeaders = (name) => ({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
  });

  route('GET', '/api/export/overview.csv', (c) => {
    const { from, to, tag } = monthParam(c);
    const rows = [['Mitarbeiter', 'Benutzername', 'Ist (h:mm)', 'Soll (h:mm)', 'Saldo Monat (h:mm)', 'Ist (Std.)', 'Soll (Std.)',
      'Saldo Monat (Std.)', 'Zeitkonto am ' + ZE.fmtDate(to) + ' (h:mm)', 'Urlaub (Tage)', 'Krank (Tage)',
      'Sonderurlaub (Tage)', 'Gleittage (Tage)', 'Hinweise ArbZG', 'Nachgetragene Einträge']];
    for (const u of db.users()) {
      const st = loadState(u);
      const ctx = ZE.makeContext(st, now());
      const r = ZE.rangeSummary(ctx, from, to);
      if (!u.active && !r.workMin) continue;
      const abs = { urlaub: 0, krank: 0, frei: 0, abbau: 0 };
      let manual = 0;
      for (const d of r.days) {
        if (d.absence && !d.holiday && st.settings.targets[ZE.weekday(d.key)] > 0) abs[d.absence.type] += d.absence.half ? 0.5 : 1;
        manual += d.entries.filter((e) => e.manual).length;
      }
      const f = (n) => String(n).replace('.', ',');
      rows.push([ZE.csvText(u.name), u.username,
        ZE.fmtHM(r.workMin, { ascii: true }), ZE.fmtHM(r.targetMin, { ascii: true }), ZE.fmtHM(r.balanceMin, { ascii: true }),
        ZE.fmtDec(r.workMin), ZE.fmtDec(r.targetMin), ZE.fmtDec(r.balanceMin),
        ZE.fmtHM(ZE.balanceUntil(ctx, to), { ascii: true }),
        f(abs.urlaub), f(abs.krank), f(abs.frei), f(abs.abbau),
        r.days.reduce((n, d) => n + d.warnings.filter((w) => w.code !== 'sunday').length, 0), manual]);
    }
    return { raw: '﻿' + ZE.toCSV(rows), headers: csvHeaders(`zeiterfassung-${tag}-uebersicht.csv`) };
  }, 'admin');

  route('GET', '/api/export/entries.csv', (c) => {
    const { from, to, tag } = monthParam(c);
    const out = [];
    for (const u of db.users()) {
      const st = loadState(u);
      const lines = ZE.entriesCSV(ZE.makeContext(st, now()), from, to).trimEnd().split('\r\n');
      if (!out.length) out.push('Mitarbeiter;' + lines[0]);
      if (lines.length <= 2) continue; // nur Kopf und Summe
      for (const l of lines.slice(1)) out.push(ZE.csvCell(ZE.csvText(u.name)) + ';' + l);
    }
    return { raw: '﻿' + out.join('\r\n') + '\r\n', headers: csvHeaders(`zeiterfassung-${tag}-alle-eintraege.csv`) };
  }, 'admin');

  route('GET', '/api/backup', async (c) => {
    const tmp = path.join(os.tmpdir(), `zeiterfassung-backup-${process.pid}-${Date.now()}.db`);
    db.backupTo(tmp);
    try {
      const data = await fsp.readFile(tmp);
      return {
        raw: data,
        headers: {
          'Content-Type': 'application/vnd.sqlite3',
          'Content-Disposition': `attachment; filename="zeiterfassung-backup-${ZE.dateKey(now())}.db"`,
        },
      };
    } finally {
      fsp.unlink(tmp).catch(() => {});
    }
  }, 'admin');

  // --------------------------------------------------------- Ausliefern
  function send(c, status, body, headers) {
    const h = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'X-Server-Time': String(now()), ...headers };
    if (c.secure) h['Strict-Transport-Security'] = 'max-age=31536000';
    c.res.writeHead(status, h);
    c.res.end(body);
  }
  const sendJson = (c, status, data) => send(c, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });

  async function serveStatic(c) {
    const { req, res } = c;
    if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Methode nicht erlaubt.');
    let p;
    try {
      p = decodeURIComponent(c.url.pathname);
    } catch (_) {
      return fail(400, 'Ungültige Adresse.');
    }
    if (p === '/') p = '/index.html';
    const file = path.join(PUBLIC_DIR, p);
    const type = TYPES[path.extname(file)];
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !type) fail(404, 'Nicht gefunden.');
    let st;
    try {
      st = await fsp.stat(file);
    } catch (_) {
      return fail(404, 'Nicht gefunden.');
    }
    if (!st.isFile()) fail(404, 'Nicht gefunden.');
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const h = { ...SECURITY_HEADERS, ETag: etag, 'Cache-Control': 'no-cache' };
    if (c.secure) h['Strict-Transport-Security'] = 'max-age=31536000';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, h);
      return res.end();
    }
    res.writeHead(200, { ...h, 'Content-Type': type, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const c = {
      req, res, url: new URL(req.url, 'http://localhost'), params: {}, body: {}, user: null,
      secure: !!req.socket.encrypted || (trustProxy && xfp === 'https'),
      ip: (trustProxy && xff) || req.socket.remoteAddress || '',
    };
    try {
      if (!c.url.pathname.startsWith('/api/')) return await serveStatic(c);

      const method = req.method === 'HEAD' ? 'GET' : req.method;
      let found = null;
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(c.url.pathname);
        if (m) {
          found = r;
          r.keys.forEach((k, i) => { c.params[k] = decodeURIComponent(m[i + 1]); });
          break;
        }
      }
      if (!found) fail(404, 'Unbekannte Adresse.');

      if (method !== 'GET') {
        // Schutz gegen Anfragen von fremden Seiten (CSRF)
        const origin = req.headers.origin;
        if (origin) {
          let host = null;
          try { host = new URL(origin).host; } catch (_) { /* ungültig */ }
          const allowed = [req.headers.host, publicUrl && new URL(publicUrl).host].filter(Boolean);
          if (!allowed.includes(host)) fail(403, 'Anfrage von fremder Herkunft abgelehnt.');
        }
        c.body = method === 'DELETE' && !req.headers['content-type'] ? {} : await readJson(req);
      }

      loadSession(c);
      if (found.auth !== 'none' && !c.user) fail(401, 'Bitte melde dich an.');
      if (found.auth === 'admin' && c.user.role !== 'admin') fail(403, 'Das darf nur das Büro (Admin).');

      const out = await found.handler(c);
      if (out && out.raw !== undefined) return send(c, 200, out.raw, out.headers);
      return sendJson(c, 200, out || {});
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) {
        if (c.url.pathname.startsWith('/api/')) return sendJson(c, err.status, { error: err.message });
        return send(c, err.status, err.message, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      console.error(err);
      return sendJson(c, 500, { error: 'Auf dem Server ist ein Fehler passiert. Bitte versuch es noch einmal.' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  const timer = setInterval(() => {
    db.cleanup(now());
    for (const [k, a] of attempts) if (a.until < now()) attempts.delete(k);
  }, 3600e3);
  timer.unref();
  server.on('close', () => clearInterval(timer));

  return {
    server,
    db,
    get setupCode() { return setupCode; },
  };
}

module.exports = { createApp };

// ------------------------------------------------------------ Starten
if (require.main === module) {
  const app = createApp({
    dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'zeiterfassung.db'),
    publicUrl: process.env.PUBLIC_URL,
    trustProxy: process.env.TRUST_PROXY === '1',
    setupCode: process.env.SETUP_CODE,
  });
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  app.server.listen(port, host, () => {
    console.log(`Zeiterfassung läuft: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}  (Zeitzone ${process.env.TZ})`);
    if (app.setupCode) {
      console.log('');
      console.log('  Ersteinrichtung: Öffne die Seite im Browser und gib diesen Code ein:');
      console.log(`  ${app.setupCode}`);
      console.log('');
    }
  });
  const stop = () => {
    app.server.close(() => {
      app.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
