/*
 * Zeiterfassung – Rechenlogik
 * Reine Funktionen ohne DOM-Zugriff. Läuft im Browser (global `ZE`)
 * und in Node (require), damit sie mit `node --test` geprüft werden kann.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZE = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60000;
  const HOUR = 60 * MIN;
  const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

  // ------------------------------------------------------------------
  // Datum & Zeit (alles in lokaler Zeit, Tage als "YYYY-MM-DD")
  // ------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, '0');

  function dateKey(t) {
    const d = t instanceof Date ? t : new Date(t);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(key, n) {
    const d = parseKey(key);
    d.setDate(d.getDate() + n);
    return dateKey(d);
  }
  function weekday(key) {
    return parseKey(key).getDay(); // 0 = Sonntag
  }
  function startOfWeek(key) {
    return addDays(key, -((weekday(key) + 6) % 7)); // Montag
  }
  function isoWeek(key) {
    const d = parseKey(key);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); // Donnerstag derselben Woche
    const jan4 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  }
  function daysBetween(from, to) {
    const out = [];
    if (!from || !to || from > to) return out;
    for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
    return out;
  }
  function monthRange(year, month) {
    const last = new Date(year, month, 0).getDate();
    return [`${year}-${pad(month)}-01`, `${year}-${pad(month)}-${pad(last)}`];
  }
  function timeOfDay(t) {
    const d = new Date(t);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  /** Datum + "HH:MM" -> Zeitstempel (ms) */
  function combine(key, hhmm) {
    const d = parseKey(key);
    const [h, m] = hhmm.split(':').map(Number);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  const WEEKDAYS_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const WEEKDAYS_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August',
    'September', 'Oktober', 'November', 'Dezember'];

  // ------------------------------------------------------------------
  // Formatierung
  // ------------------------------------------------------------------
  /** Minuten -> "7:30"; signed => "+0:15"; ascii => "-" statt "−" */
  function fmtHM(min, opts) {
    const o = opts || {};
    const m = Math.round(min);
    const a = Math.abs(m);
    const s = Math.floor(a / 60) + ':' + pad(a % 60);
    if (m < 0) return (o.ascii ? '-' : '−') + s;
    return (o.signed && m > 0 ? '+' : '') + s;
  }
  /** Minuten -> Dezimalstunden mit Komma, z. B. "7,50" */
  function fmtDec(min) {
    return (Math.round(min) / 60).toFixed(2).replace('.', ',');
  }
  /** Sekundengenaue Anzeige "7:30:05" */
  function fmtHMS(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }
  function fmtDate(key, withYear) {
    const [y, m, d] = key.split('-');
    return `${d}.${m}.` + (withYear === false ? '' : y);
  }
  /**
   * "8", "8:30", "8,5", "8.5", "-1:15", "+0:30" -> Minuten. Ungültig -> null.
   */
  function parseDuration(str) {
    if (str == null) return null;
    let s = String(str).trim().replace('−', '-');
    if (!s) return null;
    let sign = 1;
    if (s[0] === '-' || s[0] === '+') {
      if (s[0] === '-') sign = -1;
      s = s.slice(1).trim();
    }
    let m;
    if ((m = /^(\d{1,4}):([0-5]?\d)$/.exec(s))) return sign * (+m[1] * 60 + +m[2]);
    if ((m = /^(\d{1,4})(?:[.,](\d+))?$/.exec(s))) {
      const h = parseFloat(m[1] + '.' + (m[2] || '0'));
      return sign * Math.round(h * 60);
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Feiertage
  // ------------------------------------------------------------------
  const STATES = {
    BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen',
    HH: 'Hamburg', HE: 'Hessen', MV: 'Mecklenburg-Vorpommern', NI: 'Niedersachsen',
    NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz', SL: 'Saarland', SN: 'Sachsen',
    ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen',
  };

  /** Ostersonntag (gregorianisch, anonymer Algorithmus) */
  function easterSunday(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  const holidayCache = new Map();
  /**
   * Gesetzliche Feiertage eines Jahres. Ohne Bundesland nur die bundesweiten.
   * Nicht enthalten: Feiertage, die nur in einzelnen Gemeinden gelten
   * (z. B. Mariä Himmelfahrt in Teilen Bayerns, Augsburger Friedensfest).
   * @returns {Map<string,string>} Datum -> Name
   */
  function holidays(year, state) {
    const ck = year + '|' + (state || '');
    if (holidayCache.has(ck)) return holidayCache.get(ck);
    const e = easterSunday(year);
    const map = new Map();
    const f = (m, d) => `${year}-${pad(m)}-${pad(d)}`;
    const add = (key, name, states) => {
      if (!states || states.includes(state)) map.set(key, name);
    };

    add(f(1, 1), 'Neujahr');
    add(f(1, 6), 'Heilige Drei Könige', ['BW', 'BY', 'ST']);
    if (year >= 2019) add(f(3, 8), 'Internationaler Frauentag', year >= 2023 ? ['BE', 'MV'] : ['BE']);
    add(addDays(e, -2), 'Karfreitag');
    add(e, 'Ostersonntag', ['BB']);
    add(addDays(e, 1), 'Ostermontag');
    add(f(5, 1), 'Tag der Arbeit');
    if (year === 2020 || year === 2025) add(f(5, 8), 'Tag der Befreiung', ['BE']);
    add(addDays(e, 39), 'Christi Himmelfahrt');
    add(addDays(e, 49), 'Pfingstsonntag', ['BB']);
    add(addDays(e, 50), 'Pfingstmontag');
    add(addDays(e, 60), 'Fronleichnam', ['BW', 'BY', 'HE', 'NW', 'RP', 'SL']);
    add(f(8, 15), 'Mariä Himmelfahrt', ['SL']);
    if (year >= 2019) add(f(9, 20), 'Weltkindertag', ['TH']);
    add(f(10, 3), 'Tag der Deutschen Einheit');
    if (year === 2017) add(f(10, 31), 'Reformationstag');
    else add(f(10, 31), 'Reformationstag', year >= 2018
      ? ['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH']
      : ['BB', 'MV', 'SN', 'ST', 'TH']);
    add(f(11, 1), 'Allerheiligen', ['BW', 'BY', 'NW', 'RP', 'SL']);
    let bb = f(11, 22);
    while (weekday(bb) !== 3) bb = addDays(bb, -1);
    add(bb, 'Buß- und Bettag', ['SN']);
    add(f(12, 25), '1. Weihnachtstag');
    add(f(12, 26), '2. Weihnachtstag');

    holidayCache.set(ck, map);
    return map;
  }
  function holidayOn(key, state) {
    return holidays(+key.slice(0, 4), state).get(key) || null;
  }

  // ------------------------------------------------------------------
  // Arbeitszeitgesetz
  // ------------------------------------------------------------------
  /** § 4 ArbZG: > 6 h -> 30 min, > 9 h -> 45 min Pause */
  function requiredBreakMin(workMin) {
    return workMin > 540 ? 45 : workMin > 360 ? 30 : 0;
  }
  /**
   * Kleinste zusätzliche Pause, die abgezogen werden muss, damit die
   * Mindestpause eingehalten ist. Die Arbeitszeit wird dabei nie unter
   * 6 h bzw. 9 h gedrückt (z. B. 6:10 ohne Pause -> 10 min Abzug).
   */
  function autoBreakMin(workMin, qualMin) {
    if (qualMin >= requiredBreakMin(workMin)) return 0;
    return Math.max(0, Math.min(
      workMin - 360,
      Math.max(30 - qualMin, workMin - 540),
      45 - qualMin,
    ));
  }

  const ABSENCE_TYPES = {
    urlaub: { label: 'Urlaub', short: 'Urlaub', credit: true },
    krank: { label: 'Krank', short: 'Krank', credit: true },
    frei: { label: 'Sonderurlaub / bezahlt frei', short: 'Frei', credit: true },
    abbau: { label: 'Gleittag (Überstundenabbau)', short: 'Gleittag', credit: false },
  };

  // ------------------------------------------------------------------
  // Auswertung
  // ------------------------------------------------------------------
  /** Brutto, Pause, anrechenbare Pause (Blöcke ≥ 15 min) und Netto eines Eintrags in ms */
  function entryMs(e, now) {
    const end = e.end != null ? e.end : now;
    const gross = Math.max(0, end - e.start);
    const pm = e.pauseMin || 0;
    let brk = pm * MIN;
    let qual = pm >= 15 ? pm * MIN : 0;
    for (const b of e.breaks || []) {
      const be = b.end != null ? b.end : now;
      const d = Math.max(0, Math.min(be, end) - Math.max(b.start, e.start));
      brk += d;
      if (d >= 15 * MIN) qual += d;
    }
    brk = Math.min(brk, gross);
    return { gross, brk, qual: Math.min(qual, gross), net: gross - brk };
  }
  function entryNetMin(e, now) {
    return Math.round(entryMs(e, now).net / MIN);
  }
  function isOnBreak(e) {
    const b = e && e.breaks && e.breaks[e.breaks.length - 1];
    return !!(e && e.end == null && b && b.end == null);
  }
  function runningEntry(entries) {
    return entries.find((e) => e.end == null) || null;
  }
  /** Beginn der aktuellen Anwesenheit über nahtlose Projektwechsel hinweg */
  function presenceStart(entries, run) {
    const list = [...entries].sort((a, b) => a.start - b.start);
    let i = list.findIndex((e) => e.id === run.id);
    let start = run.start;
    while (i > 0 && list[i - 1].end === start) start = list[--i].start;
    return start;
  }

  function buildIndex(entries) {
    const byDay = new Map();
    const sorted = [...entries].sort((a, b) => a.start - b.start);
    for (const e of sorted) {
      const k = dateKey(e.start);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    return { byDay, days: [...byDay.keys()].sort() };
  }

  function absenceOn(absences, key) {
    for (const a of absences) if (a.from <= key && key <= (a.to || a.from)) return a;
    return null;
  }

  /** Kontext für alle Auswertungen: einmal pro Render erstellen. */
  function makeContext(state, now) {
    return {
      settings: state.settings,
      absences: state.absences || [],
      projects: state.projects || [],
      idx: buildIndex(state.entries || []),
      now: now == null ? Date.now() : now,
    };
  }

  /** Sollzeit eines Tages laut Wochenplan, Feiertag, Abwesenheit, Startdatum */
  function targetFor(ctx, key) {
    const s = ctx.settings;
    if (s.startDate && key < s.startDate) return { targetMin: 0, holiday: holidayOn(key, s.state), absence: absenceOn(ctx.absences, key), counted: false };
    const holiday = holidayOn(key, s.state);
    const absence = absenceOn(ctx.absences, key);
    let targetMin = holiday ? 0 : (s.targets[weekday(key)] || 0);
    if (absence && ABSENCE_TYPES[absence.type] && ABSENCE_TYPES[absence.type].credit) {
      targetMin = absence.half ? Math.round(targetMin / 2) : 0;
    }
    return { targetMin, holiday, absence, counted: true };
  }

  function daySummary(ctx, key) {
    const { settings, idx, now } = ctx;
    const list = idx.byDay.get(key) || [];
    let workMs = 0, breakMs = 0, qualMs = 0, running = false, prevEnd = null;
    const perProjectMs = {};
    for (const e of list) {
      const m = entryMs(e, now);
      workMs += m.net;
      breakMs += m.brk;
      qualMs += m.qual;
      if (e.end == null) running = true;
      const pid = e.projectId || '';
      perProjectMs[pid] = (perProjectMs[pid] || 0) + m.net;
      if (prevEnd != null && e.start > prevEnd) {
        const gap = e.start - prevEnd; // Lücke zwischen zwei Einträgen = Pause
        breakMs += gap;
        if (gap >= 15 * MIN) qualMs += gap;
      }
      const end = e.end != null ? e.end : now;
      prevEnd = prevEnd == null ? end : Math.max(prevEnd, end);
    }

    const t = targetFor(ctx, key);
    let workMin = Math.round(workMs / MIN);
    const qualMin = Math.round(qualMs / MIN);
    let autoMin = 0;
    if (settings.autoBreak && !running && list.length) {
      autoMin = autoBreakMin(workMin, qualMin);
      workMin -= autoMin;
    }

    const warnings = [];
    if (list.length) {
      if (workMin > 600) warnings.push({ code: 'max', text: 'Mehr als 10 Std. Arbeitszeit (§ 3 ArbZG)' });
      const req = requiredBreakMin(workMin);
      const have = qualMin + autoMin;
      if (!running && have < req) {
        warnings.push({ code: 'break', text: `Pause zu kurz: ${have} von ${req} Min. (§ 4 ArbZG)` });
      }
      const i = idx.days.indexOf(key);
      if (i > 0) {
        const prev = idx.byDay.get(idx.days[i - 1]);
        if (prev.every((e) => e.end != null)) {
          const prevEndMax = Math.max(...prev.map((e) => e.end));
          const rest = list[0].start - prevEndMax;
          if (rest < 11 * HOUR) {
            warnings.push({ code: 'rest', text: `Ruhezeit nur ${fmtHM(Math.max(0, rest) / MIN)} Std. statt 11 Std. (§ 5 ArbZG)` });
          }
        }
      }
      if (t.holiday) warnings.push({ code: 'sunday', text: `Arbeit am Feiertag (${t.holiday})` });
      else if (weekday(key) === 0) warnings.push({ code: 'sunday', text: 'Arbeit am Sonntag (§ 9 ArbZG)' });
    }

    const perProject = {};
    for (const pid in perProjectMs) perProject[pid] = Math.round(perProjectMs[pid] / MIN);

    return {
      key,
      entries: list,
      workMin,
      breakMin: Math.round(breakMs / MIN),
      qualMin,
      autoMin,
      targetMin: t.targetMin,
      balanceMin: t.counted ? workMin - t.targetMin : 0,
      counted: t.counted,
      holiday: t.holiday,
      absence: t.absence,
      running,
      perProject,
      firstStart: list.length ? list[0].start : null,
      lastEnd: list.length ? (running ? null : prevEnd) : null,
      warnings,
    };
  }

  function rangeSummary(ctx, from, to) {
    const days = daysBetween(from, to).map((k) => daySummary(ctx, k));
    const tot = { workMin: 0, targetMin: 0, balanceMin: 0, breakMin: 0, perProject: {} };
    for (const d of days) {
      tot.workMin += d.workMin;
      tot.targetMin += d.targetMin;
      tot.balanceMin += d.balanceMin;
      tot.breakMin += d.breakMin;
      for (const pid in d.perProject) tot.perProject[pid] = (tot.perProject[pid] || 0) + d.perProject[pid];
    }
    return { from, to, days, ...tot };
  }

  /** Stand des Arbeitszeitkontos am Ende des Tages `toKey` (inkl. Übertrag) */
  function balanceUntil(ctx, toKey) {
    const s = ctx.settings;
    let from = s.startDate || ctx.idx.days[0];
    let bal = s.openingBalanceMin || 0;
    if (!from || toKey < from) return bal;
    for (const k of daysBetween(from, toKey)) bal += daySummary(ctx, k).balanceMin;
    return bal;
  }

  /** Urlaubskonto eines Jahres (halbe Tage zählen 0,5) */
  function vacation(ctx, year, todayKey) {
    const s = ctx.settings;
    let taken = 0, planned = 0;
    const yFrom = `${year}-01-01`, yTo = `${year}-12-31`;
    for (const a of ctx.absences) {
      if (a.type !== 'urlaub') continue;
      const from = a.from > yFrom ? a.from : yFrom;
      const to = (a.to || a.from) < yTo ? (a.to || a.from) : yTo;
      for (const k of daysBetween(from, to)) {
        if (!(s.targets[weekday(k)] > 0) || holidayOn(k, s.state)) continue;
        const v = a.half ? 0.5 : 1;
        if (k <= todayKey) taken += v; else planned += v;
      }
    }
    const total = s.vacationDaysPerYear || 0;
    return { total, taken, planned, left: total - taken - planned };
  }

  /** Voraussichtlicher Zeitpunkt, an dem das Tagessoll erreicht ist */
  function eta(ctx, key) {
    const d = daySummary(ctx, key);
    if (!d.running || d.targetMin <= 0) return null;
    const remaining = d.targetMin - d.workMin;
    if (remaining <= 0) return { reached: true, overMin: -remaining };
    const missingBreak = Math.max(0, requiredBreakMin(d.targetMin) - d.qualMin);
    return { reached: false, at: ctx.now + (remaining + missingBreak) * MIN, missingBreak };
  }

  // ------------------------------------------------------------------
  // Stempeln (gemeinsam für Server und Offline-Betrieb auf dem Handy)
  // ------------------------------------------------------------------
  /**
   * Führt eine Stempel-Aktion auf `state` aus (verändert state).
   * op.action: in | out | breakStart | breakEnd | project | note
   * @returns {{error?: string, message?: string}}
   */
  function applyStamp(state, op, t) {
    const run = runningEntry(state.entries);
    const newEntry = (pid) => {
      const e = { id: uid(), projectId: pid || null, start: t, end: null, breaks: [], pauseMin: 0, note: '', manual: false };
      state.entries.push(e);
      return e;
    };
    switch (op.action) {
      case 'in': {
        if (run) return { error: 'Du bist schon eingestempelt.' };
        if (findOverlap(state.entries, { id: '', start: t, end: t + 1 }, t)) {
          return { error: 'Zu dieser Uhrzeit gibt es schon einen Eintrag.' };
        }
        if (op.projectId !== undefined) state.activeProjectId = op.projectId || null;
        newEntry(state.activeProjectId);
        return { message: `Gekommen um ${timeOfDay(t)}` };
      }
      case 'out': {
        if (!run) return { error: 'Du bist nicht eingestempelt.' };
        if (t < run.start) return { error: 'Gehen kann nicht vor Kommen liegen.' };
        run.breaks.forEach((b) => { if (b.end == null) b.end = Math.max(b.start, t); });
        run.end = t;
        return { message: `Gegangen um ${timeOfDay(t)}` };
      }
      case 'breakStart': {
        if (!run) return { error: 'Du bist nicht eingestempelt.' };
        if (isOnBreak(run)) return { error: 'Du bist schon in der Pause.' };
        if (t < run.start) return { error: 'Die Pause kann nicht vor Kommen beginnen.' };
        run.breaks.push({ start: t, end: null });
        return { message: `Pause seit ${timeOfDay(t)}` };
      }
      case 'breakEnd': {
        if (!isOnBreak(run)) return { error: 'Du bist gerade nicht in der Pause.' };
        const b = run.breaks[run.breaks.length - 1];
        if (t < b.start) return { error: 'Das Pausenende liegt vor dem Pausenbeginn.' };
        if ((state.activeProjectId || null) !== (run.projectId || null)) {
          // Projekt wurde in der Pause gewechselt: alter Eintrag endet mit Pausenbeginn
          run.breaks.pop();
          run.end = b.start;
          if (run.end <= run.start) state.entries.splice(state.entries.indexOf(run), 1);
          newEntry(state.activeProjectId);
          return { message: 'Pause beendet, weiter mit dem neuen Projekt' };
        }
        b.end = t;
        return { message: `Pause beendet nach ${Math.max(1, Math.round((t - b.start) / MIN))} Min.` };
      }
      case 'project': {
        const pid = op.projectId || null;
        state.activeProjectId = pid;
        if (!run || (run.projectId || null) === pid) return {};
        if (isOnBreak(run)) return { message: 'Nach der Pause geht es mit dem neuen Projekt weiter' };
        if (t - run.start < 2 * MIN) run.projectId = pid; // gerade erst gestartet: nur umbuchen
        else {
          run.end = Math.max(run.start, t);
          newEntry(pid);
        }
        return { message: `Projekt gewechselt um ${timeOfDay(t)}` };
      }
      case 'note': {
        if (!run) return { error: 'Du bist nicht eingestempelt.' };
        run.note = String(op.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        return { message: 'Notiz gespeichert' };
      }
      default:
        return { error: 'Unbekannte Aktion.' };
    }
  }

  function overlaps(a, b, now) {
    const aEnd = a.end != null ? a.end : now;
    const bEnd = b.end != null ? b.end : now;
    return a.start < bEnd && b.start < aEnd;
  }
  function findOverlap(entries, cand, now) {
    return entries.find((e) => e.id !== cand.id && overlaps(e, cand, now)) || null;
  }

  // ------------------------------------------------------------------
  // CSV (Semikolon, deutsches Dezimalkomma – passt für Excel/LibreOffice)
  // ------------------------------------------------------------------
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** Freitext absichern, damit Excel ihn nicht als Formel ausführt */
  function csvText(v) {
    const s = v == null ? '' : String(v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }
  function toCSV(rows) {
    return rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
  }

  function entriesCSV(ctx, from, to, projectId) {
    const pmap = new Map(ctx.projects.map((p) => [p.id, p]));
    const rows = [['Datum', 'Wochentag', 'Beginn', 'Ende', 'Pause (Min.)', 'Dauer (h:mm)', 'Dauer (Std.)', 'Projekt', 'Kunde', 'Notiz', 'Nachgetragen']];
    let sum = 0;
    for (const k of daysBetween(from, to)) {
      for (const e of ctx.idx.byDay.get(k) || []) {
        if (projectId !== undefined && projectId !== null && (e.projectId || '') !== projectId) continue;
        const m = entryMs(e, ctx.now);
        const net = Math.round(m.net / MIN);
        sum += net;
        const p = pmap.get(e.projectId);
        rows.push([
          fmtDate(k), WEEKDAYS_SHORT[weekday(k)], timeOfDay(e.start),
          e.end != null ? timeOfDay(e.end) : 'läuft', Math.round(m.brk / MIN),
          fmtHM(net, { ascii: true }), fmtDec(net),
          csvText(p ? p.name : ''), csvText(p ? p.client : ''), csvText(e.note || ''), e.manual ? 'ja' : '',
        ]);
      }
    }
    rows.push(['Summe', '', '', '', '', fmtHM(sum, { ascii: true }), fmtDec(sum), '', '', '', '']);
    return toCSV(rows);
  }

  function daysCSV(ctx, from, to) {
    const r = rangeSummary(ctx, from, to);
    const rows = [['Datum', 'Wochentag', 'Feiertag/Abwesenheit', 'Beginn', 'Ende', 'Pause (Min.)',
      'Ist (h:mm)', 'Soll (h:mm)', 'Saldo (h:mm)', 'Ist (Std.)', 'Soll (Std.)', 'Saldo (Std.)', 'Hinweise']];
    for (const d of r.days) {
      const info = [d.holiday, d.absence ? absenceLabel(d.absence) : null].filter(Boolean).join(', ');
      rows.push([
        fmtDate(d.key), WEEKDAYS_SHORT[weekday(d.key)], csvText(info),
        d.firstStart != null ? timeOfDay(d.firstStart) : '',
        d.lastEnd != null ? timeOfDay(d.lastEnd) : (d.running ? 'läuft' : ''),
        d.entries.length ? d.breakMin + d.autoMin : '',
        fmtHM(d.workMin, { ascii: true }), fmtHM(d.targetMin, { ascii: true }), fmtHM(d.balanceMin, { ascii: true }),
        fmtDec(d.workMin), fmtDec(d.targetMin), fmtDec(d.balanceMin),
        csvText(d.warnings.map((w) => w.text).join(' | ')),
      ]);
    }
    rows.push(['Summe', '', '', '', '', '',
      fmtHM(r.workMin, { ascii: true }), fmtHM(r.targetMin, { ascii: true }), fmtHM(r.balanceMin, { ascii: true }),
      fmtDec(r.workMin), fmtDec(r.targetMin), fmtDec(r.balanceMin), '']);
    return toCSV(rows);
  }

  function absenceLabel(a) {
    const t = ABSENCE_TYPES[a.type];
    return (t ? t.short : a.type) + (a.half ? ' (½ Tag)' : '');
  }

  // ------------------------------------------------------------------
  // Datenmodell prüfen / reparieren (Laden & Import)
  // ------------------------------------------------------------------
  const COLORS = ['#0f766e', '#c2410c', '#4338ca', '#b91c1c', '#a16207', '#0369a1', '#7e22ce', '#4d7c0f'];

  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function toMs(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v) {
      const n = Date.parse(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }
  const str = (v) => (typeof v === 'string' ? v : '');
  const numOr = (v, d) => (v !== null && v !== '' && Number.isFinite(+v) ? +v : d);

  function defaultState(now) {
    return normalizeState(null, now);
  }

  function normalizeState(raw, now) {
    const t = now == null ? Date.now() : now;
    const s = raw && typeof raw === 'object' ? raw : {};
    const st = s.settings && typeof s.settings === 'object' ? s.settings : {};

    const settings = {
      name: str(st.name),
      targets: Array.isArray(st.targets) && st.targets.length === 7
        ? st.targets.map((v) => Math.max(0, Math.min(1440, Math.round(numOr(v, 0)))))
        : [0, 480, 480, 480, 480, 480, 0],
      state: STATES[st.state] ? st.state : '',
      startDate: KEY_RE.test(st.startDate) ? st.startDate : dateKey(t),
      openingBalanceMin: Math.round(numOr(st.openingBalanceMin, 0)),
      vacationDaysPerYear: Math.max(0, numOr(st.vacationDaysPerYear, 30)),
      autoBreak: !!st.autoBreak,
    };

    const projects = [];
    const seen = new Set();
    for (const p of Array.isArray(s.projects) ? s.projects : []) {
      if (!p || typeof p !== 'object' || !str(p.name).trim()) continue;
      const id = str(p.id) || uid();
      if (seen.has(id)) continue;
      seen.add(id);
      projects.push({
        id,
        name: str(p.name).trim(),
        client: str(p.client).trim(),
        color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : COLORS[projects.length % COLORS.length],
        archived: !!p.archived,
      });
    }

    let entries = [];
    for (const e of Array.isArray(s.entries) ? s.entries : []) {
      if (!e || typeof e !== 'object') continue;
      const start = toMs(e.start);
      if (start == null) continue;
      let end = toMs(e.end);
      if (end != null && end < start) continue;
      const breaks = [];
      for (const b of Array.isArray(e.breaks) ? e.breaks : []) {
        const bs = toMs(b && b.start);
        if (bs == null) continue;
        const be = toMs(b.end);
        if (be != null && be < bs) continue;
        breaks.push({ start: bs, end: be });
      }
      entries.push({
        id: str(e.id) || uid(),
        projectId: seen.has(e.projectId) ? e.projectId : null,
        start,
        end,
        breaks,
        pauseMin: Math.max(0, Math.round(numOr(e.pauseMin, 0))),
        note: str(e.note),
        manual: !!e.manual,
      });
    }
    // Höchstens ein laufender Eintrag (der neueste); ältere offene werden geschlossen
    const open = entries.filter((e) => e.end == null).sort((a, b) => b.start - a.start);
    for (const e of open.slice(1)) {
      e.end = e.start;
      e.breaks.forEach((b) => { if (b.end == null) b.end = e.end; });
    }
    for (const e of entries) {
      if (e.end != null) e.breaks.forEach((b) => { if (b.end == null) b.end = e.end; });
    }
    entries = entries.sort((a, b) => a.start - b.start);

    const absences = [];
    for (const a of Array.isArray(s.absences) ? s.absences : []) {
      if (!a || !ABSENCE_TYPES[a.type] || !KEY_RE.test(a.from)) continue;
      const to = KEY_RE.test(a.to) && a.to >= a.from ? a.to : a.from;
      absences.push({
        id: str(a.id) || uid(),
        type: a.type,
        from: a.from,
        to,
        half: !!a.half && to === a.from,
        note: str(a.note),
      });
    }

    return {
      version: 1,
      settings,
      projects,
      entries,
      absences,
      activeProjectId: seen.has(s.activeProjectId) ? s.activeProjectId : null,
      ui: { hintDismissed: !!(s.ui && s.ui.hintDismissed) },
    };
  }

  return {
    MIN, HOUR, STATES, ABSENCE_TYPES, COLORS, WEEKDAYS_SHORT, WEEKDAYS_LONG, MONTHS,
    pad, dateKey, parseKey, addDays, weekday, startOfWeek, isoWeek, daysBetween, monthRange,
    timeOfDay, combine, fmtHM, fmtDec, fmtHMS, fmtDate, parseDuration,
    easterSunday, holidays, holidayOn, requiredBreakMin, autoBreakMin,
    entryMs, entryNetMin, isOnBreak, runningEntry, presenceStart, buildIndex, absenceOn, makeContext,
    targetFor, daySummary, rangeSummary, balanceUntil, vacation, eta, applyStamp, overlaps, findOverlap,
    csvCell, csvText, toCSV, entriesCSV, daysCSV, absenceLabel,
    uid, defaultState, normalizeState,
  };
});
