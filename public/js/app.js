/*
 * Zeiterfassung – Oberfläche
 * Rendern per Template-String. Jede Änderung geht an den Server; die Antwort
 * enthält den neuen Stand. Stempeln ohne Netz wird auf dem Handy vorgemerkt
 * und automatisch nachgereicht.
 */
(function () {
  'use strict';
  const Z = window.ZE;
  const Api = window.Api;
  const MIN = Z.MIN;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const now = () => Api.now();
  const todayKey = () => Z.dateKey(now());
  const COLOR_NAMES = ['Petrol', 'Orange', 'Indigo', 'Rot', 'Ocker', 'Blau', 'Violett', 'Olivgrün'];
  const ORDER = [1, 2, 3, 4, 5, 6, 0];
  const ICONS = {
    heute: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/>',
    eintraege: '<rect x="5" y="3.5" width="14" height="17" rx="1"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
    bericht: '<path d="M4 20h16"/><path d="M7 17v-5M12 17V7M17 17v-8"/>',
    aufgaben: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>',
    team: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="16.5" cy="9.5" r="2.3"/><path d="M16.5 14c2.2 0 3.7 1.4 4.1 4"/>',
    einstellungen: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  };
  const TAB_LABELS = { heute: 'Heute', aufgaben: 'Aufgaben', eintraege: 'Einträge', bericht: 'Bericht', team: 'Team', einstellungen: 'Einstellungen' };

  let session = null; // { user, company }
  let serverMe = null; // eigener Stand laut Server
  let me = null; // eigener Stand inkl. noch nicht übertragener Offline-Stempelungen
  let other = null; // Mitarbeiter, den das Büro gerade ansieht
  let state = null; // Stand, den die aktuelle Ansicht zeigt
  let ctx = null;
  const d0 = new Date();
  const ym0 = { y: d0.getFullYear(), m: d0.getMonth() + 1 };
  const ui = {
    view: 'heute',
    subjectId: null,
    sub: null,
    otherId: null,
    entriesMonth: { ...ym0 },
    reportMonth: { ...ym0 },
    teamMonth: { ...ym0 },
    reportProject: '__all',
    stamp: null,
    day: Z.dateKey(Date.now()),
    balYesterday: 0,
    busy: false,
    flushing: false,
    team: null,
    teamNow: 0,
    audit: null,
    installPrompt: null,
    myTasks: null,
    adminTasks: null,
    tasksDay: Z.dateKey(Date.now()),
  };

  // ------------------------------------------------------------------
  // Hilfen
  // ------------------------------------------------------------------
  const hm = (min, signed) => Z.fmtHM(min, { signed });
  const bal = (min) => `<span class="num ${min < 0 ? 'neg' : ''}">${hm(min, true)}</span>`;
  const isAdmin = () => !!(session && session.user.role === 'admin');
  const viewingOther = () => !!(ui.subjectId && session && ui.subjectId !== session.user.id);
  const projectById = (id) => (state || me).projects.find((p) => p.id === id) || null;
  const monthLabel = (ym) => Z.MONTHS[ym.m - 1] + ' ' + ym.y;
  const shortDate = (k) => `${Z.WEEKDAYS_SHORT[Z.weekday(k)]} ${Z.fmtDate(k, false)}`;
  const fmtDays = (n) => (n % 1 ? n.toFixed(1).replace('.', ',') : String(n));
  const daysWord = (n) => `${fmtDays(n)} ${n === 1 ? 'Arbeitstag' : 'Arbeitstage'}`;
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function longDate(k) {
    const d = Z.parseKey(k);
    return `${Z.WEEKDAYS_LONG[d.getDay()]}, ${d.getDate()}. ${Z.MONTHS[d.getMonth()]}`;
  }
  function slug(s) {
    return String(s).toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function usernameFrom(name) {
    return slug(name).replace(/-/g, '.').slice(0, 40);
  }
  function absenceDays(from, to, half) {
    let n = 0;
    for (const k of Z.daysBetween(from, to)) {
      if (state.settings.targets[Z.weekday(k)] > 0 && !Z.holidayOn(k, state.settings.state)) n += half ? 0.5 : 1;
    }
    return n;
  }
  /** Liegen im Zeitraum Arbeitstage oder Einträge vor dem Start des Zeitkontos? */
  function skippedBeforeStart(from, to) {
    const sd = state.settings.startDate;
    if (!(sd > from)) return false;
    const before = Z.addDays(sd, -1);
    const last = before < to ? before : to;
    return Z.daysBetween(from, last).some((k) => state.settings.targets[Z.weekday(k)] > 0 && !Z.holidayOn(k, state.settings.state))
      || state.entries.some((e) => { const k = Z.dateKey(e.start); return k >= from && k <= last; });
  }
  function describeTargets(t) {
    const week = t.reduce((a, b) => a + b, 0);
    const days = ORDER.filter((i) => t[i] > 0);
    if (!days.length) return 'keine Sollzeit';
    const same = days.every((i) => t[i] === t[days[0]]);
    const consecutive = days.every((i, n) => n === 0 || ORDER.indexOf(i) === ORDER.indexOf(days[n - 1]) + 1);
    let s;
    if (same && consecutive && days.length > 1) s = `${Z.WEEKDAYS_SHORT[days[0]]}–${Z.WEEKDAYS_SHORT[days[days.length - 1]]} je ${hm(t[days[0]])}`;
    else s = days.map((i) => `${Z.WEEKDAYS_SHORT[i]} ${hm(t[i])}`).join(', ');
    return `${s}, ${hm(week)} pro Woche`;
  }
  function download(name, text, type) {
    const blob = new Blob(['﻿' + text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------------
  // Offline-Speicher (nur der eigene Stand und die Warteschlange)
  // ------------------------------------------------------------------
  const store = {
    get(key, def) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? def : JSON.parse(v);
      } catch (_) { return def; }
    },
    set(key, v) {
      try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* voll oder gesperrt */ }
    },
    del(key) {
      try { localStorage.removeItem(key); } catch (_) { /* egal */ }
    },
  };
  const queueKey = () => 'ze.queue.' + session.user.id;
  const getQueue = () => (session ? store.get(queueKey(), []) : []);
  const setQueue = (q) => store.set(queueKey(), q);

  function setMe(st) {
    serverMe = Z.normalizeState(st);
    me = Z.normalizeState(JSON.parse(JSON.stringify(serverMe)));
    for (const op of getQueue()) Z.applyStamp(me, op, op.at);
    store.set('ze.cache', { session, state: serverMe });
  }
  function applyState(st) {
    if (viewingOther()) other = Z.normalizeState(st);
    else setMe(st);
  }
  function setProjects(projects) {
    for (const s of [serverMe, me, other]) if (s) s.projects = projects.map((p) => ({ ...p }));
    store.set('ze.cache', { session, state: serverMe });
  }

  // ------------------------------------------------------------------
  // Server
  // ------------------------------------------------------------------
  async function call(method, url, body) {
    try {
      return await Api.call(method, url, body);
    } catch (err) {
      if (err.status === 401 && session) {
        err.handled = true;
        session = null;
        store.del('ze.cache');
        showLogin('Deine Anmeldung ist abgelaufen. Bitte melde dich neu an.');
      }
      throw err;
    }
  }
  const errText = (err) => (err.offline ? 'Keine Verbindung zum Server. Bitte versuch es gleich noch einmal.' : err.message);

  /** Server-Aufruf aus einer Schaltfläche: Ergebnis übernehmen, Meldung zeigen */
  async function act(fn, okMsg, undo) {
    try {
      const r = await fn();
      if (r && r.state) applyState(r.state);
      render();
      const m = typeof okMsg === 'function' ? okMsg(r) : okMsg;
      if (m) toast(m, undo ? () => undo(r) : null);
      return r;
    } catch (err) {
      if (!err.handled) toast(errText(err));
      return null;
    }
  }

  let toastTimer;
  function toast(text, undo) {
    const el = $('#toast');
    el.innerHTML = `<span>${esc(text)}</span>` + (undo ? '<button type="button">Rückgängig</button>' : '');
    if (undo) {
      el.querySelector('button').addEventListener('click', () => {
        el.classList.remove('show');
        undo();
      });
    }
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 8000 : 4500);
  }

  // ------------------------------------------------------------------
  // Stempeln (mit Offline-Warteschlange)
  // ------------------------------------------------------------------
  async function stamp(action, extra) {
    if (ui.busy) return;
    const op = { opId: Z.uid(), action, at: now(), ...(extra || {}) };
    const before = Z.runningEntry(me.entries);
    ui.busy = true;
    render();
    let msg = null;
    let undo = null;
    try {
      if (getQueue().length) await flushQueue();
      if (getQueue().length) throw Object.assign(new Error('offline'), { offline: true });
      const r = await call('POST', '/api/stamp', op);
      setMe(r.state);
      msg = r.message;
      if (action === 'in') {
        const run = Z.runningEntry(me.entries);
        if (run) undo = () => act(() => call('DELETE', '/api/entries/' + run.id), 'Kommen zurückgenommen');
      }
      if (action === 'out' && before) {
        const e = me.entries.find((x) => x.id === before.id);
        if (e) {
          msg += `. Heute gearbeitet: ${hm(Z.daySummary(Z.makeContext(me, now()), Z.dateKey(e.start)).workMin)}`;
          undo = () => act(() => call('PUT', '/api/entries/' + e.id, { ...entryBody(e), end: null }), 'Gehen zurückgenommen, die Zeit läuft weiter');
        }
      }
    } catch (err) {
      if (err.offline) {
        const res = Z.applyStamp(me, op, op.at);
        if (res.error) msg = res.error;
        else {
          setQueue([...getQueue(), op]);
          msg = 'Kein Netz. Die Stempelung ist auf dem Handy gespeichert und wird automatisch übertragen.';
        }
      } else if (!err.handled) {
        msg = err.message;
      }
    } finally {
      ui.busy = false;
    }
    const run = Z.runningEntry(me.entries);
    if (action === 'in' && run) ui.stamp = { id: run.id, field: 'start' };
    if (action === 'out' && before) ui.stamp = { id: before.id, field: 'end' };
    render();
    if (msg) toast(msg, undo);
  }

  async function flushQueue() {
    if (ui.flushing || !session) return;
    const q = getQueue();
    if (!q.length) return;
    ui.flushing = true;
    let sent = 0;
    const rejected = [];
    try {
      while (q.length) {
        try {
          await Api.post('/api/stamp', { ...q[0], offline: true });
          sent++;
        } catch (err) {
          if (err.offline || err.status === 401) break;
          rejected.push(err.message);
        }
        q.shift();
        setQueue(q);
      }
    } finally {
      ui.flushing = false;
    }
    if (sent || rejected.length) {
      try {
        setMe((await Api.get('/api/state')).state);
      } catch (_) {
        setMe(serverMe);
      }
      render();
      if (rejected.length) toast('Eine Offline-Stempelung wurde nicht übernommen: ' + rejected[0]);
      else if (!getQueue().length) toast('Offline-Stempelungen übertragen');
    }
  }

  function entryBody(e) {
    return {
      start: e.start, end: e.end, pauseMin: e.pauseMin, breaks: e.breaks,
      projectId: e.projectId, note: e.note, userId: viewingOther() ? ui.subjectId : undefined,
    };
  }

  // ------------------------------------------------------------------
  // Ansicht: Heute
  // ------------------------------------------------------------------
  function todayMs(run, k) {
    let ms = 0;
    for (const e of ctx.idx.byDay.get(k) || []) ms += Z.entryMs(e, ctx.now).net;
    if (run && Z.dateKey(run.start) !== k) ms += Z.entryMs(run, ctx.now).net;
    return ms;
  }

  function statusLine(run, d) {
    if (run && Z.isOnBreak(run)) return ['break', `In Pause seit ${Z.timeOfDay(run.breaks[run.breaks.length - 1].start)}`];
    if (run) {
      const s = Z.presenceStart(me.entries, run);
      return ['work', `Anwesend seit ${Z.dateKey(s) !== todayKey() ? 'gestern ' : ''}${Z.timeOfDay(s)}`];
    }
    if (d.entries.length) return ['off', `Gegangen um ${Z.timeOfDay(d.lastEnd)}`];
    return ['off', 'Noch nicht gestempelt'];
  }

  function subText(d, run) {
    if (d.targetMin <= 0) {
      if (d.holiday) return `${d.holiday}, heute gibt es kein Soll.`;
      if (d.absence) return `${Z.absenceLabel(d.absence)}, heute gibt es kein Soll.`;
      return 'Heute gibt es kein Soll.';
    }
    const rest = d.targetMin - d.workMin;
    if (rest <= 0) return `Soll von ${hm(d.targetMin)} erreicht, ${hm(-rest)} darüber.`;
    let s = `Soll ${hm(d.targetMin)}, noch ${hm(rest)}.`;
    const e = run && !Z.isOnBreak(run) ? Z.eta(ctx, d.key) : null;
    if (e && !e.reached) {
      s += ` Feierabend gegen ${Z.timeOfDay(e.at)}` + (e.missingBreak ? ` (mit ${e.missingBreak} Min. Pause)` : '') + '.';
    }
    return s;
  }

  function projectOptions(selected, includeAll) {
    return state.projects
      .filter((p) => includeAll || !p.archived || p.id === selected)
      .map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.client ? ' – ' + esc(p.client) : ''}${p.archived ? ' (archiviert)' : ''}</option>`)
      .join('');
  }

  function stampRow(e, compact) {
    const st = ui.stamp && ui.stamp.id === e.id ? ui.stamp.field : '';
    const p = projectById(e.projectId);
    const m = Z.entryMs(e, ctx.now);
    const brk = Math.round(m.brk / MIN);
    const end = e.end != null
      ? `<span class="t ${st === 'end' ? 'stamp-new' : ''}">${Z.timeOfDay(e.end)}</span>`
      : `<span class="t running">${Z.isOnBreak(e) ? 'Pause' : 'läuft'}</span>`;
    const start = `<span class="t ${st === 'start' ? 'stamp-new' : ''}">${Z.timeOfDay(e.start)}</span>`;
    const what = `<span class="what">${p ? `<span class="pname"><i class="dot" style="--c:${esc(p.color)}"></i>${esc(p.name)}</span>` : '<span class="pname muted">Ohne Projekt</span>'}`
      + (e.note ? `<small>${esc(e.note)}</small>` : '')
      + (brk ? `<small>Pause ${brk} Min.</small>` : '')
      + (e.manual ? '<small class="manual">nachgetragen</small>' : '') + '</span>';
    return `<li><button type="button" class="stamp-row${compact ? ' stamp-row--compact' : ''}" data-act="editEntry" data-id="${esc(e.id)}">`
      + (compact ? `<span class="times">${start}<span class="dash">–</span>${end}</span>` : start + end)
      + what + `<span class="num dur">${hm(Math.round(m.net / MIN))}</span></button></li>`;
  }

  function warningList(warnings, withDate) {
    if (!warnings.length) return '';
    return `<ul class="warnings">${warnings.map((w) => `<li>${withDate ? `<b>${esc(shortDate(w.key))}</b> ` : ''}${esc(w.text)}</li>`).join('')}</ul>`;
  }

  function installHelp() {
    if (isStandalone()) return '<p>Die Zeiterfassung ist als App auf deinem Startbildschirm.</p>';
    return (ui.installPrompt ? '<p><button type="button" class="btn btn--primary" data-act="install">Als App installieren</button></p>' : '')
      + '<p><b>iPhone:</b> In Safari unten auf das Teilen-Symbol tippen, dann „Zum Home-Bildschirm“.<br>'
      + '<b>Android:</b> In Chrome oben rechts auf ⋮ tippen, dann „App installieren“ oder „Zum Startbildschirm hinzufügen“.</p>';
  }

  function viewToday() {
    const k = todayKey();
    const d = Z.daySummary(ctx, k);
    const run = Z.runningEntry(me.entries);
    const onBreak = Z.isOnBreak(run);
    const [stCls, stText] = statusLine(run, d);
    const pid = run && !onBreak ? run.projectId : me.activeProjectId;
    const hasProjects = me.projects.some((p) => !p.archived) || pid;
    const dis = ui.busy ? ' disabled' : '';

    const select = hasProjects ? `
      <label class="field field--project"><span>Projekt</span>
        <select data-change="project"${dis}><option value="">Ohne Projekt</option>${projectOptions(pid)}</select>
      </label>` : '';

    const buttons = !run
      ? `<button type="button" class="punch punch--in" data-act="clockIn"${dis}>Kommen</button>`
      : `<div class="punch-row">
          ${onBreak
            ? `<button type="button" class="punch punch--pause" data-act="breakEnd"${dis}>Pause beenden</button>`
            : `<button type="button" class="punch punch--pause" data-act="breakStart"${dis}>Pause</button>`}
          <button type="button" class="punch punch--out" data-act="clockOut"${dis}>Gehen</button>
        </div>`;

    const note = run ? `
      <label class="field field--note"><span>Notiz zur laufenden Zeit</span>
        <input type="text" data-change="runNote" value="${esc(run.note)}" maxlength="300" placeholder="Woran arbeitest du gerade?">
      </label>` : '';

    const list = d.entries.slice();
    if (run && Z.dateKey(run.start) !== k) list.unshift(run);

    const ws = Z.startOfWeek(k);
    const week = Z.rangeSummary(ctx, ws, Z.addDays(ws, 6));
    const pct = week.targetMin ? Math.min(100, Math.round((week.workMin / week.targetMin) * 100)) : 0;
    ui.balYesterday = Z.balanceUntil(ctx, Z.addDays(k, -1));
    const vac = Z.vacation(ctx, +k.slice(0, 4), k);
    const after = ui.balYesterday + d.balanceMin;
    const afterRow = run || d.entries.length ? `
      <div class="row"><span>${run ? 'Zeitkonto, wenn du jetzt gehst' : 'Zeitkonto nach heute'}</span>
        <span data-live="after">${bal(after)}</span></div>` : '';

    const hint = !isStandalone() && !store.get('ze.installHintDone', false) ? `
      <aside class="hint">
        <p><b>Tipp:</b> Leg die Zeiterfassung auf deinen Startbildschirm, dann startet sie wie eine App.</p>
        ${installHelp()}
        <p><button type="button" class="link-btn" data-act="dismissInstall">Ausblenden</button></p>
      </aside>` : '';

    return `
      <header class="page-head">
        <h1>${esc(longDate(k))}</h1>
        <p class="sub">KW ${Z.isoWeek(k)}${d.holiday ? ', ' + esc(d.holiday) : ''}${d.absence ? ', ' + esc(Z.absenceLabel(d.absence)) : ''}</p>
      </header>
      <section class="clock clock--${stCls}" aria-label="Stempeluhr">
        <p class="status"><i aria-hidden="true"></i><span>${esc(stText)}</span></p>
        <p class="timer num" role="timer" data-live="timer">${Z.fmtHMS(todayMs(run, k))}</p>
        <p class="timer-sub" data-live="sub">${esc(subText(d, run))}</p>
        ${select}
        ${buttons}
        ${note}
      </section>

      ${tasksSection()}

      <section class="timecard" aria-labelledby="tc-h">
        <div class="timecard-head"><h2 id="tc-h">Stempelkarte</h2><span class="num">${Z.fmtDate(k)}</span></div>
        <div class="stamp-cols" aria-hidden="true"><span>Kommen</span><span>Gehen</span><span>Projekt</span><span>Dauer</span></div>
        ${list.length
          ? `<ol class="stamps">${list.map((e) => stampRow(e)).join('')}</ol>`
          : '<p class="empty">Noch nichts gestempelt. Tipp auf „Kommen“, sobald du anfängst.</p>'}
        ${d.entries.length ? `<div class="timecard-foot"><span>Pausen ${hm(d.breakMin + d.autoMin)}${d.autoMin ? `, davon ${d.autoMin} Min. automatisch` : ''}</span><span class="num">${hm(d.workMin)}</span></div>` : ''}
        ${warningList(d.warnings)}
        ${canEdit() ? `<button type="button" class="link-btn" data-act="newEntry" data-date="${k}">Zeit nachtragen</button>` : ''}
      </section>

      <section class="ledger" aria-label="Überblick">
        <div class="row row--bar">
          <span>Woche ${Z.isoWeek(k)}</span>
          <span class="num" data-live="week">${hm(week.workMin)} von ${hm(week.targetMin)}</span>
          <div class="bar" aria-hidden="true"><i data-live="weekbar" style="width:${pct}%"></i></div>
        </div>
        <div class="row"><span>Zeitkonto bis gestern</span>${bal(ui.balYesterday)}</div>
        ${afterRow}
        <div class="row">
          <span>Urlaub ${k.slice(0, 4)}</span>
          <span class="num">${fmtDays(vac.left)} von ${fmtDays(vac.total)} Tagen übrig</span>
          <small>${fmtDays(vac.taken)} genommen, ${fmtDays(vac.planned)} geplant</small>
        </div>
      </section>
      ${hint}`;
  }

  // ------------------------------------------------------------------
  // Ansicht: Einträge (eigene oder eines Mitarbeiters)
  // ------------------------------------------------------------------
  const canEdit = () => isAdmin() || session.company.employeesCanEdit;

  function monthNav(which, ym) {
    return `<div class="month-nav">
      <button type="button" class="icon-btn" data-act="month" data-which="${which}" data-dir="-1" aria-label="Vorheriger Monat">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg></button>
      <span class="month-label">${monthLabel(ym)}</span>
      <button type="button" class="icon-btn" data-act="month" data-which="${which}" data-dir="1" aria-label="Nächster Monat">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg></button>
    </div>`;
  }

  function dayItem(d, k) {
    const isToday = d.key === k;
    const off = d.targetMin === 0 && !d.entries.length;
    const missing = d.key < k && d.targetMin > 0 && !d.entries.length && !(d.absence && d.absence.type === 'abbau');
    const badges = [];
    if (d.holiday) badges.push(`<span class="badge badge--holiday">${esc(d.holiday)}</span>`);
    if (d.absence) {
      badges.push(canEdit()
        ? `<button type="button" class="badge badge--absence" data-act="editAbsence" data-id="${esc(d.absence.id)}">${esc(Z.absenceLabel(d.absence))}</button>`
        : `<span class="badge badge--absence">${esc(Z.absenceLabel(d.absence))}</span>`);
    }
    const settled = d.counted && (d.key < k || (isToday && d.entries.length && !d.running));
    const figs = d.entries.length || d.targetMin
      ? `<span class="num">${hm(d.workMin)}${d.targetMin ? ` / ${hm(d.targetMin)}` : ''}</span>${settled && d.balanceMin ? bal(d.balanceMin) : ''}`
      : '';
    return `<li class="day${off ? ' day--off' : ''}${isToday ? ' day--today' : ''}">
      <div class="day-head">
        <span class="day-date">${esc(shortDate(d.key))}${isToday ? ' <small>heute</small>' : ''}</span>
        <span class="badges">${badges.join('')}</span>
        <span class="day-figs">${figs}</span>
      </div>
      ${d.entries.length ? `<ol class="stamps stamps--compact">${d.entries.map((e) => stampRow(e, true)).join('')}</ol>` : ''}
      ${missing ? `<p class="missing">Keine Zeit erfasst.${canEdit() ? ` <button type="button" class="link-btn" data-act="newEntry" data-date="${d.key}">Nachtragen</button>` : ''}</p>` : ''}
      ${warningList(d.warnings)}
    </li>`;
  }

  function viewEntries(embedded) {
    const ym = ui.entriesMonth;
    const [from, to] = Z.monthRange(ym.y, ym.m);
    const k = todayKey();
    const r = Z.rangeSummary(ctx, from, to);
    const startDate = state.settings.startDate;
    // Tage vor dem Start des Zeitkontos nur zeigen, wenn dort etwas eingetragen ist
    const shown = r.days.filter((d) => d.entries.length || d.absence || (d.key <= k && d.key >= startDate)
      || (d.holiday && d.key >= startDate)).reverse();
    const yesterday = Z.addDays(k, -1);
    const sumTo = to < yesterday ? to : yesterday;
    let summary = '';
    if (from <= sumTo) {
      const s = Z.rangeSummary(ctx, from, sumTo);
      summary = `<p class="summary">${to <= yesterday ? 'Im Monat' : 'Bis gestern'}: Ist <span class="num">${hm(s.workMin)}</span>, Soll <span class="num">${hm(s.targetMin)}</span>, Saldo ${bal(s.balanceMin)}</p>`;
    }
    const defDate = from <= k && k <= to ? k : from;
    const head = embedded
      ? `<div class="page-head page-head--nav page-head--sub">${monthNav('entries', ym)}</div>`
      : `<header class="page-head page-head--nav"><h1>Einträge</h1>${monthNav('entries', ym)}</header>`;
    return `${head}
      ${canEdit() ? `<div class="actions">
        <button type="button" class="btn" data-act="newEntry" data-date="${defDate}">Zeit nachtragen</button>
        <button type="button" class="btn" data-act="newAbsence" data-date="${defDate}">Abwesenheit eintragen</button>
      </div>` : '<p class="help">Fehlt etwas oder ist etwas falsch? Sag im Büro Bescheid, dort wird es korrigiert.</p>'}
      ${summary}
      ${skippedBeforeStart(from, to) ? `<p class="help">Das Zeitkonto zählt ab ${Z.fmtDate(startDate)}. Davor gibt es kein Soll und keinen Saldo.</p>` : ''}
      ${shown.length
        ? `<ol class="days">${shown.map((d) => dayItem(d, k)).join('')}</ol>`
        : `<p class="empty">Für ${monthLabel(ym)} ist noch nichts eingetragen.</p>`}`;
  }

  // ------------------------------------------------------------------
  // Ansicht: Bericht
  // ------------------------------------------------------------------
  function viewReport(embedded) {
    const ym = ui.reportMonth;
    const [from, to] = Z.monthRange(ym.y, ym.m);
    const k = todayKey();
    const pf = ui.reportProject;
    const s = state.settings;

    const head = (embedded
      ? `<div class="page-head page-head--nav page-head--sub no-print">${monthNav('report', ym)}</div>`
      : `<header class="page-head page-head--nav no-print"><h1>Bericht</h1>${monthNav('report', ym)}</header>`)
      + `<label class="field no-print"><span>Inhalt</span>
        <select data-change="reportProject">
          <option value="__all" ${pf === '__all' ? 'selected' : ''}>Arbeitszeitnachweis, alle Zeiten</option>
          <option value="" ${pf === '' ? 'selected' : ''}>Nur Zeiten ohne Projekt</option>
          ${projectOptions(pf, true)}
        </select>
      </label>`;

    if (from > k) return head + `<p class="empty">${monthLabel(ym)} hat noch nicht begonnen.</p>`;
    const end = to < k ? to : k;
    const stand = end === to ? '' : ` Stand: ${Z.fmtDate(k)}, ${Z.timeOfDay(now())} Uhr.`;
    const created = `Erstellt am ${Z.fmtDate(k)}.`;
    if (pf !== '__all') return head + reportForProject(pf, from, end, ym, stand || created);

    const r = Z.rangeSummary(ctx, from, end);
    const closing = Z.balanceUntil(ctx, end);
    const actions = `
      <div class="actions no-print">
        <button type="button" class="btn" data-act="csvDays">CSV: Tage</button>
        <button type="button" class="btn" data-act="csvEntries">CSV: Einträge</button>
        <button type="button" class="btn btn--primary" data-act="print">Drucken oder PDF</button>
      </div>`;

    const totalWork = Object.values(r.perProject).reduce((a, b) => a + b, 0);
    const projRows = Object.entries(r.perProject).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([pid, min]) => {
      const p = projectById(pid);
      const pctv = totalWork ? Math.round((min / totalWork) * 100) : 0;
      return `<li>
        <span class="pname">${p ? `<i class="dot" style="--c:${esc(p.color)}"></i>${esc(p.name)}${p.client ? ` <small>${esc(p.client)}</small>` : ''}` : '<span class="muted">Ohne Projekt</span>'}</span>
        <span class="num">${hm(min)}</span><span class="num pct">${pctv} %</span>
        <div class="bar" aria-hidden="true"><i style="width:${pctv}%;${p ? `background:${esc(p.color)}` : ''}"></i></div>
      </li>`;
    }).join('');
    const hasProjects = Object.keys(r.perProject).some((pid) => pid && r.perProject[pid] > 0);
    const autoTotal = r.days.reduce((a, d) => a + d.autoMin, 0);

    const abs = {};
    for (const d of r.days) {
      if (!d.absence || d.holiday || !(s.targets[Z.weekday(d.key)] > 0)) continue;
      abs[d.absence.type] = (abs[d.absence.type] || 0) + (d.absence.half ? 0.5 : 1);
    }
    const absText = Object.entries(abs).map(([t, n]) => `${Z.ABSENCE_TYPES[t].short} ${fmtDays(n)} ${n === 1 ? 'Tag' : 'Tage'}`).join(', ');

    const rows = r.days.map((d) => {
      const info = [d.holiday, d.absence ? Z.absenceLabel(d.absence) : null, d.entries.some((e) => e.manual) ? 'nachgetragen' : null].filter(Boolean).join(', ');
      const off = d.targetMin === 0 && !d.entries.length;
      return `<tr class="${off ? 'off' : ''}">
        <td>${esc(shortDate(d.key))}${info ? `<small>${esc(info)}</small>` : ''}</td>
        <td class="num">${d.firstStart != null ? Z.timeOfDay(d.firstStart) : ''}</td>
        <td class="num">${d.lastEnd != null ? Z.timeOfDay(d.lastEnd) : d.running ? 'läuft' : ''}</td>
        <td class="num">${d.entries.length ? hm(d.breakMin + d.autoMin) : ''}</td>
        <td class="num">${d.entries.length ? hm(d.workMin) : ''}</td>
        <td class="num">${d.targetMin ? hm(d.targetMin) : ''}</td>
        <td class="num ${d.balanceMin < 0 ? 'neg' : ''}">${d.balanceMin || d.entries.length ? hm(d.balanceMin, true) : ''}</td>
      </tr>`;
    }).join('');

    const warns = r.days.flatMap((d) => d.warnings.map((w) => ({ ...w, key: d.key })));

    return head + actions + `
      <div class="print-head">
        <h1>Arbeitszeitnachweis ${monthLabel(ym)}</h1>
        <p>${esc(s.name)}${session.company.name ? ', ' + esc(session.company.name) : ''}. ${s.state ? 'Feiertage: ' + esc(Z.STATES[s.state]) + '. ' : ''}${stand || created}</p>
      </div>
      ${stand ? `<p class="note no-print">Laufender Monat.${stand} Der heutige Tag zählt mit vollem Soll.</p>` : ''}
      ${skippedBeforeStart(from, end) ? `<p class="note">Das Zeitkonto zählt ab ${Z.fmtDate(s.startDate)}. Davor gibt es kein Soll und keinen Saldo.</p>` : ''}
      <dl class="totals">
        <div><dt>Ist</dt><dd class="num">${hm(r.workMin)}</dd></div>
        <div><dt>Soll</dt><dd class="num">${hm(r.targetMin)}</dd></div>
        <div><dt>Saldo im Monat</dt><dd>${bal(r.balanceMin)}</dd></div>
        <div><dt>Zeitkonto am ${Z.fmtDate(end, false)}</dt><dd>${bal(closing)}</dd></div>
      </dl>
      ${absText ? `<p class="summary">Abwesenheiten: ${esc(absText)}</p>` : ''}
      ${hasProjects ? `<section class="report-sec"><h2>Nach Projekt</h2><ul class="proj-bars">${projRows}</ul>
        ${autoTotal ? `<p class="note">Automatisch abgezogene Pausen (${hm(autoTotal)}) sind in den Projektzeiten nicht abgezogen.</p>` : ''}</section>` : ''}
      <section class="report-sec">
        <h2>Tage</h2>
        <div class="table-wrap"><table class="report">
          <thead><tr><th>Tag</th><th class="num">Kommen</th><th class="num">Gehen</th><th class="num">Pause</th><th class="num">Ist</th><th class="num">Soll</th><th class="num">Saldo</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><th>Summe</th><td></td><td></td><td class="num">${hm(r.breakMin + autoTotal)}</td><td class="num">${hm(r.workMin)}</td><td class="num">${hm(r.targetMin)}</td><td class="num ${r.balanceMin < 0 ? 'neg' : ''}">${hm(r.balanceMin, true)}</td></tr></tfoot>
        </table></div>
      </section>
      <section class="report-sec">
        <h2>Arbeitszeitgesetz</h2>
        ${warns.length ? warningList(warns, true) : '<p class="ok">Keine Auffälligkeiten bei Höchstarbeitszeit, Pausen und Ruhezeiten.</p>'}
      </section>
      <div class="signatures"><div>Datum, Unterschrift Mitarbeiter/in</div><div>Datum, Unterschrift Vorgesetzte/r</div></div>`;
  }

  function reportForProject(pf, from, end, ym, stand) {
    const p = projectById(pf);
    const label = pf === '' ? 'Zeiten ohne Projekt' : p ? p.name : 'Projekt';
    let total = 0;
    const rows = [];
    for (const k of Z.daysBetween(from, end)) {
      for (const e of ctx.idx.byDay.get(k) || []) {
        if ((e.projectId || '') !== pf) continue;
        const m = Z.entryMs(e, ctx.now);
        const net = Math.round(m.net / MIN);
        total += net;
        rows.push(`<tr>
          <td>${esc(shortDate(k))}</td>
          <td class="num">${Z.timeOfDay(e.start)}–${e.end != null ? Z.timeOfDay(e.end) : 'läuft'}</td>
          <td class="num">${m.brk ? hm(Math.round(m.brk / MIN)) : ''}</td>
          <td class="num">${hm(net)}</td>
          <td class="note-cell">${esc(e.note)}</td>
        </tr>`);
      }
    }
    return `
      <div class="actions no-print">
        <button type="button" class="btn" data-act="csvEntries">CSV: Einträge</button>
        <button type="button" class="btn btn--primary" data-act="print">Drucken oder PDF</button>
      </div>
      <div class="print-head">
        <h1>Tätigkeitsnachweis ${monthLabel(ym)}</h1>
        <p>${esc(label)}${p && p.client ? ', ' + esc(p.client) : ''}. ${esc(state.settings.name)}. ${stand}</p>
      </div>
      <dl class="totals">
        <div><dt>${esc(label)}</dt><dd class="num">${hm(total)}</dd></div>
        <div><dt>Dezimal</dt><dd class="num">${Z.fmtDec(total)} Std.</dd></div>
        <div><dt>Einträge</dt><dd class="num">${rows.length}</dd></div>
      </dl>
      ${rows.length ? `<div class="table-wrap"><table class="report report--project">
        <thead><tr><th>Tag</th><th class="num">Zeit</th><th class="num">Pause</th><th class="num">Dauer</th><th>Notiz</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
        <tfoot><tr><th>Summe</th><td></td><td></td><td class="num">${hm(total)}</td><td></td></tr></tfoot>
      </table></div>` : `<p class="empty">Im ${monthLabel(ym)} gibt es keine Zeiten für „${esc(label)}“.</p>`}`;
  }

  // ------------------------------------------------------------------
  // Ansicht: Team (Büro)
  // ------------------------------------------------------------------
  function memberStatus(u) {
    if (u.status === 'work') return `Anwesend seit ${Z.timeOfDay(u.since)}`;
    if (u.status === 'break') return `In Pause seit ${Z.timeOfDay(u.since)}`;
    if (u.absence) return u.absence;
    if (u.holiday) return u.holiday;
    if (!u.active) return 'Zugang deaktiviert';
    if (!u.hasPassword) return 'Einladung noch nicht angenommen';
    if (u.since) return `Gegangen um ${Z.timeOfDay(u.since)}`;
    return u.targetTodayMin ? 'Heute noch nicht gestempelt' : 'Heute kein Soll';
  }

  function memberRow(u) {
    const p = u.projectId ? me.projects.find((x) => x.id === u.projectId) : null;
    return `<li><a class="member" href="#team/${esc(u.id)}">
      <i class="presence presence--${u.status}" aria-hidden="true"></i>
      <span class="who"><b>${esc(u.name)}</b>${u.role === 'admin' ? ' <span class="role">Admin</span>' : ''}
        <small>${esc(memberStatus(u))}${p ? ', ' + esc(p.name) : ''}</small>
        ${u.tasksOpen + u.tasksDone ? `<small>Aufgaben heute: ${u.tasksDone} von ${u.tasksOpen + u.tasksDone} erledigt</small>` : ''}
        ${u.warnings ? `<small class="neg">${u.warnings} ${u.warnings === 1 ? 'Hinweis' : 'Hinweise'} zum Arbeitszeitgesetz</small>` : ''}</span>
      <span class="figs"><span class="num">${hm(u.todayMin)}</span><small>Konto ${bal(u.balanceMin)}</small></span>
    </a></li>`;
  }

  function viewTeam() {
    if (!ui.team) return '<p class="empty">Lädt …</p>';
    const active = ui.team.filter((u) => u.active);
    const inactive = ui.team.filter((u) => !u.active);
    const present = active.filter((u) => u.status !== 'off').length;
    const ym = ui.teamMonth;
    const tag = `${ym.y}-${Z.pad(ym.m)}`;
    const future = Z.monthRange(ym.y, ym.m)[0] > todayKey();
    return `
      <header class="page-head">
        <h1>Team</h1>
        <p class="sub">${present} von ${active.length} anwesend, Stand ${Z.timeOfDay(ui.teamNow)} Uhr</p>
      </header>
      <div class="actions">
        <button type="button" class="btn btn--primary" data-act="newMember">Mitarbeiter anlegen</button>
        <button type="button" class="btn" data-act="refreshTeam">Aktualisieren</button>
      </div>
      ${active.length <= 1 ? `<aside class="hint"><p>Leg jetzt deine Mitarbeiter an. Jeder bekommt einen Link aufs Handy, legt damit sein Passwort fest und kann sofort stempeln.</p></aside>` : ''}
      <ul class="team">${active.map(memberRow).join('')}</ul>
      ${inactive.length ? `<details class="archived"><summary>Deaktiviert (${inactive.length})</summary><ul class="team">${inactive.map(memberRow).join('')}</ul></details>` : ''}
      <section class="report-sec">
        <div class="page-head page-head--nav"><h2>Monatsexport</h2>${monthNav('team', ym)}</div>
        ${future ? '<p class="empty">Dieser Monat hat noch nicht begonnen.</p>' : `<div class="actions">
          <a class="btn" href="/api/export/overview.csv?month=${tag}" download>Übersicht als CSV</a>
          <a class="btn" href="/api/export/entries.csv?month=${tag}" download>Alle Einträge als CSV</a>
        </div>`}
        <p class="help">Die Übersicht hat je Mitarbeiter eine Zeile mit Ist, Soll, Saldo, Zeitkonto sowie Urlaubs- und Krankheitstagen, passend für die Lohnabrechnung. Den Nachweis einer Person zum Unterschreiben druckst du in ihrem Bericht.</p>
      </section>`;
  }

  function viewMember() {
    const u = (ui.team || []).find((x) => x.id === ui.subjectId);
    if (!ui.team) return '<p class="empty">Lädt …</p>';
    if (!u) return '<p class="empty">Diesen Mitarbeiter gibt es nicht. <a href="#team">Zurück zum Team</a></p>';
    const tabs = [['eintraege', 'Einträge'], ['bericht', 'Bericht'], ['vertrag', 'Vertrag'], ['protokoll', 'Änderungen']];
    let body;
    if (ui.sub === 'vertrag') body = viewContract(u);
    else if (ui.sub === 'protokoll') body = viewAudit();
    else if (!state) body = '<p class="empty">Lädt …</p>';
    else body = ui.sub === 'bericht' ? viewReport(true) : viewEntries(true);
    return `
      <header class="page-head no-print">
        <a class="back" href="#team">Team</a>
        <h1>${esc(u.name)}</h1>
        <p class="sub">${esc(memberStatus(u))}</p>
      </header>
      <nav class="subnav no-print" aria-label="${esc(u.name)}">
        ${tabs.map(([k, l]) => `<a href="#team/${esc(u.id)}/${k}"${ui.sub === k ? ' aria-current="page"' : ''}>${l}</a>`).join('')}
      </nav>
      ${body}`;
  }

  function weekGrid(targets) {
    return `<div class="week-grid">
      ${ORDER.map((i) => `<label><span>${Z.WEEKDAYS_SHORT[i]}</span><input name="t${i}" inputmode="decimal" autocomplete="off" value="${targets[i] ? hm(targets[i]) : ''}" placeholder="0:00"></label>`).join('')}
    </div>
    <p class="help">Als 8:00 oder 7,5 eingeben. Woche gesamt: <b class="num" data-live="weeksum">${hm(targets.reduce((a, b) => a + b, 0))}</b></p>`;
  }
  function readTargets(fd) {
    const targets = [];
    for (let i = 0; i < 7; i++) {
      const v = String(fd.get('t' + i) || '').trim();
      const m = v === '' ? 0 : Z.parseDuration(v);
      if (m == null || m < 0 || m > 1440) return { error: `Die Sollzeit für ${Z.WEEKDAYS_LONG[i]} ist kein gültiger Wert. Gib sie als 8:00 oder 7,5 ein.` };
      targets[i] = m;
    }
    return { targets };
  }

  function viewContract(u) {
    const s = u.settings;
    const self = u.id === session.user.id;
    return `
      <form id="member-form" class="settings" novalidate>
        <fieldset>
          <legend>Person</legend>
          <label class="field"><span>Name</span><input type="text" name="name" value="${esc(u.name)}" maxlength="80"></label>
          <div class="field-row">
            <label class="field"><span>Benutzername</span><input type="text" name="username" value="${esc(u.username)}" autocapitalize="none" autocomplete="off" spellcheck="false"></label>
            <label class="field"><span>Rolle</span><select name="role"${self ? ' disabled' : ''}>
              <option value="employee" ${u.role === 'employee' ? 'selected' : ''}>Mitarbeiter/in</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin (Büro)</option>
            </select></label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Sollzeit pro Wochentag</legend>
          ${weekGrid(s.targets)}
        </fieldset>
        <fieldset>
          <legend>Zeitkonto und Urlaub</legend>
          <div class="field-row">
            <label class="field"><span>Zählt ab</span><input type="date" name="startDate" value="${esc(s.startDate)}"></label>
            <label class="field"><span>Übertrag in Stunden</span><input type="text" name="opening" autocomplete="off" value="${hm(s.openingBalanceMin || 0, true)}" placeholder="+12:30"></label>
          </div>
          <label class="field field--short"><span>Urlaubstage pro Jahr</span><input type="number" name="vacation" min="0" max="366" step="0.5" value="${s.vacationDaysPerYear}"></label>
          <p class="help">Der Übertrag ist der Stand aus einer früheren Zeiterfassung, zum Beispiel +12:30 oder -3:00.</p>
        </fieldset>
        <p class="form-error" role="alert" hidden></p>
        <button type="submit" class="btn btn--primary btn--wide">Speichern</button>
      </form>

      <section class="backup" aria-labelledby="zg-h">
        <h2 id="zg-h">Zugang</h2>
        <p>${!u.active ? 'Der Zugang ist deaktiviert. Die erfassten Zeiten bleiben erhalten.'
          : u.hasPassword ? `Angemeldet wird mit dem Benutzernamen <b>${esc(u.username)}</b> und dem eigenen Passwort.`
            : 'Die Einladung wurde noch nicht angenommen.'}</p>
        <div class="actions">
          ${u.active ? `<button type="button" class="btn" data-act="invite" data-id="${esc(u.id)}">${u.hasPassword ? 'Passwort zurücksetzen' : 'Neuen Einladungslink erstellen'}</button>` : ''}
          ${self ? '' : `<button type="button" class="btn ${u.active ? 'btn--danger' : ''}" data-act="toggleActive" data-id="${esc(u.id)}">${u.active ? 'Zugang deaktivieren' : 'Zugang wieder aktivieren'}</button>`}
        </div>
        <p class="help">Ein neuer Link ersetzt den alten und gilt 7 Tage. Damit setzt du auch ein vergessenes Passwort zurück: Die Person legt über den Link ein neues fest.</p>
      </section>`;
  }

  function viewAudit() {
    if (!ui.audit) return '<p class="empty">Lädt …</p>';
    if (!ui.audit.length) return '<p class="empty">Noch keine Änderungen. Hier steht, wer wann Zeiten nachgetragen, geändert oder gelöscht hat.</p>';
    return `<p class="help">Nachträge, Änderungen und Löschungen von Zeiten, Stempelungen ohne Netz und Änderungen am Zugang, jeweils mit Zeitpunkt und wer es war.</p>
      <ol class="audit">${ui.audit.map((a) => `<li>
        <span class="when num">${Z.fmtDate(Z.dateKey(a.at))}, ${Z.timeOfDay(a.at)}</span>
        <span class="what">${esc(a.text)}<small>von ${esc(a.actorName || 'unbekannt')}</small></span>
      </li>`).join('')}</ol>`;
  }

  // ------------------------------------------------------------------
  // Aufgaben: Büro plant, Mitarbeiter haken ab
  // ------------------------------------------------------------------
  const CHEV_LEFT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>';
  const CHEV_RIGHT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg>';

  function nameOf(id) {
    if (session && id === session.user.id) return session.user.name;
    const u = (ui.team || []).find((x) => x.id === id);
    return u ? u.name : '';
  }
  function taskProject(t) {
    return t.projectId ? me.projects.find((p) => p.id === t.projectId) || null : null;
  }
  function doneText(t) {
    const when = Z.dateKey(t.doneAt) === t.day ? `um ${Z.timeOfDay(t.doneAt)}` : `am ${shortDate(Z.dateKey(t.doneAt))} um ${Z.timeOfDay(t.doneAt)}`;
    const who = t.doneBy && t.doneBy !== session.user.id ? ` von ${t.doneByName}` : '';
    return `Erledigt${who} ${when}${t.doneNote ? ': ' + t.doneNote : ''}`;
  }
  function updateTask(task) {
    for (const list of [ui.myTasks, ui.adminTasks]) {
      if (!list) continue;
      const i = list.findIndex((x) => x.id === task.id);
      if (i >= 0) list[i] = task;
    }
  }

  /** Aufgaben-Block auf „Heute“ */
  function tasksSection() {
    if (!ui.myTasks) return '';
    const k = todayKey();
    const tomorrow = Z.addDays(k, 1);
    const today = ui.myTasks.filter((t) => t.day <= k && (t.doneAt == null || t.day === k || Z.dateKey(t.doneAt) === k));
    const next = ui.myTasks.filter((t) => t.day === tomorrow);
    if (!today.length && !next.length) return '';
    const open = today.filter((t) => t.doneAt == null).length;
    return `<section class="tasks" aria-labelledby="tk-h">
      <div class="timecard-head"><h2 id="tk-h">Aufgaben</h2><span class="${open ? '' : 'muted'}">${open ? `${open} offen` : 'alles erledigt'}</span></div>
      ${today.length ? `<ul class="task-list">${today.map((t) => taskRow(t)).join('')}</ul>` : '<p class="empty">Für heute ist nichts eingetragen.</p>'}
      ${next.length ? `<details class="tomorrow"><summary>Morgen: ${next.length} ${next.length === 1 ? 'Aufgabe' : 'Aufgaben'}</summary>
        <ul class="task-list">${next.map((t) => taskRow(t, true)).join('')}</ul></details>` : ''}
    </section>`;
  }

  function taskRow(t, readonly) {
    const p = taskProject(t);
    const done = t.doneAt != null;
    const late = !done && t.day < todayKey();
    const check = readonly
      ? '<span class="task-check" aria-hidden="true"></span>'
      : `<button type="button" class="task-check" data-act="${done ? 'reopenTask' : 'doneTask'}" data-id="${esc(t.id)}" aria-pressed="${done}" aria-label="${done ? 'Wieder öffnen' : 'Abhaken'}: ${esc(t.title)}"></button>`;
    return `<li class="task${done ? ' task--done' : ''}">
      ${check}
      <div class="task-body">
        <b>${esc(t.title)}</b>
        ${p ? `<span class="pname"><i class="dot" style="--c:${esc(p.color)}"></i>${esc(p.name)}</span>` : ''}
        ${late ? `<small class="neg">offen seit ${esc(shortDate(t.day))}</small>` : ''}
        ${t.details ? `<p class="task-details">${esc(t.details)}</p>` : ''}
        ${done ? `<small class="done-text">${esc(doneText(t))}</small>` : ''}
      </div>
    </li>`;
  }

  function adminTaskRow(t) {
    const p = taskProject(t);
    const names = t.assignees.length ? t.assignees.map(nameOf).filter(Boolean).join(', ') : 'alle';
    const done = t.doneAt != null;
    const late = !done && t.day < ui.tasksDay;
    return `<li><button type="button" class="admin-task${done ? ' task--done' : ''}" data-act="editTask" data-id="${esc(t.id)}">
      <span class="task-check" aria-hidden="true"></span>
      <span class="task-body">
        <b>${esc(t.title)}</b>
        <small>${p ? esc(p.name) + ', ' : ''}für ${esc(names)}</small>
        ${late ? `<small class="neg">offen seit ${esc(shortDate(t.day))}</small>` : ''}
        ${done ? `<small class="done-text">${esc(doneText(t))}</small>` : ''}
      </span>
    </button></li>`;
  }

  function viewTasks() {
    const day = ui.tasksDay;
    const k = todayKey();
    const rel = { [k]: 'heute', [Z.addDays(k, 1)]: 'morgen', [Z.addDays(k, -1)]: 'gestern' }[day] || '';
    const label = `${Z.WEEKDAYS_LONG[Z.weekday(day)]}, ${Z.fmtDate(day, false)}`;
    const month = `${day.slice(0, 7)}`;
    const head = `
      <header class="page-head"><h1>Aufgaben</h1></header>
      <div class="day-nav">
        <button type="button" class="icon-btn" data-act="taskDay" data-dir="-1" aria-label="Vorheriger Tag">${CHEV_LEFT}</button>
        <span class="day-label">${esc(label)}${rel ? ` <small>${rel}</small>` : ''}</span>
        <button type="button" class="icon-btn" data-act="taskDay" data-dir="1" aria-label="Nächster Tag">${CHEV_RIGHT}</button>
        ${day !== k ? `<button type="button" class="link-btn" data-act="taskDay" data-day="${k}">Heute</button>` : ''}
      </div>
      <div class="actions"><button type="button" class="btn btn--primary" data-act="newTask">Aufgabe anlegen</button></div>`;
    if (!ui.adminTasks) return head + '<p class="empty">Lädt …</p>';
    const ofDay = ui.adminTasks.filter((t) => t.day === day);
    const carried = ui.adminTasks.filter((t) => t.day < day && t.doneAt == null);
    return head + `
      ${carried.length ? `<section class="report-sec"><h2>Noch offen von früher</h2><ul class="admin-tasks">${carried.map(adminTaskRow).join('')}</ul></section>` : ''}
      <section class="report-sec">
        <h2>Geplant</h2>
        ${ofDay.length ? `<ul class="admin-tasks">${ofDay.map(adminTaskRow).join('')}</ul>`
          : '<p class="empty">Für diesen Tag ist noch nichts geplant. Leg eine Aufgabe an, dann sehen die Mitarbeiter sie auf „Heute“.</p>'}
      </section>
      <section class="report-sec">
        <h2>Export</h2>
        <p><a class="btn" href="/api/export/tasks.csv?month=${month}" download>Aufgaben im ${Z.MONTHS[+day.slice(5, 7) - 1]} als CSV</a></p>
        <p class="help">Mit Tag, Baustelle, wer es erledigt hat, wann und mit welcher Notiz.</p>
      </section>`;
  }

  async function loadMyTasks() {
    if (!session) return;
    const k = todayKey();
    try {
      const r = await call('GET', `/api/tasks?from=${k}&to=${Z.addDays(k, 1)}&mine=1`);
      ui.myTasks = r.tasks;
      store.set('ze.tasks', { uid: session.user.id, tasks: r.tasks });
    } catch (_) {
      const c = store.get('ze.tasks', null);
      if (!ui.myTasks && c && session && c.uid === session.user.id) ui.myTasks = c.tasks;
    }
  }
  async function loadAdminTasks() {
    if (!isAdmin()) return;
    const day = ui.tasksDay;
    try {
      const r = await call('GET', `/api/tasks?from=${day}&to=${day}`);
      if (ui.tasksDay === day) ui.adminTasks = r.tasks;
    } catch (err) {
      if (!err.handled) toast(errText(err));
      if (!ui.adminTasks) ui.adminTasks = [];
    }
  }

  async function reopenTask(id) {
    await act(async () => {
      const r = await call('POST', `/api/tasks/${encodeURIComponent(id)}/reopen`, {});
      updateTask(r.task);
      return r;
    }, 'Wieder offen');
  }

  function openDoneDialog(id) {
    const t = (ui.myTasks || []).find((x) => x.id === id);
    if (!t) return;
    const p = taskProject(t);
    openDialog({
      title: 'Aufgabe erledigt?',
      submit: 'Erledigt',
      body: `
        <p class="task-dlg"><b>${esc(t.title)}</b>${p ? `<br><span class="muted">${esc(p.name)}</span>` : ''}</p>
        <label class="field"><span>Notiz, optional</span>
          <textarea name="note" rows="3" maxlength="500" placeholder="z. B. zwei Anstriche, Farbe reicht noch für morgen"></textarea></label>`,
      onSubmit: async (fd) => {
        try {
          const r = await call('POST', `/api/tasks/${encodeURIComponent(id)}/done`, { note: fd.get('note') });
          updateTask(r.task);
        } catch (err) {
          if (err.status === 409) loadMyTasks().then(render);
          throw err;
        }
        render();
        toast('Abgehakt', () => reopenTask(id));
        return null;
      },
    });
  }

  async function openTaskDialog(id) {
    const t = id ? (ui.adminTasks || []).find((x) => x.id === id) : null;
    if (id && !t) return;
    if (!ui.team) await loadTeam();
    const people = (ui.team || []).filter((u) => u.active || (t && t.assignees.includes(u.id)));
    const all = !t || !t.assignees.length;
    const done = t && t.doneAt != null;
    openDialog({
      title: t ? 'Aufgabe bearbeiten' : 'Aufgabe anlegen',
      submit: t ? 'Speichern' : 'Anlegen',
      body: `
        <label class="field"><span>Was ist zu tun?</span>
          <input type="text" name="title" maxlength="120" value="${esc(t ? t.title : '')}" placeholder="z. B. Wohnzimmer zweiter Anstrich"></label>
        <label class="field"><span>Details, optional</span>
          <textarea name="details" rows="3" maxlength="1000" placeholder="Farbe, Material, Ansprechpartner vor Ort …">${esc(t ? t.details : '')}</textarea></label>
        <div class="field-row">
          <label class="field"><span>Tag</span><input type="date" name="day" value="${esc(t ? t.day : ui.tasksDay)}"></label>
          ${me.projects.length ? `<label class="field"><span>Projekt</span><select name="project"><option value="">Ohne Projekt</option>${projectOptions(t ? t.projectId : null)}</select></label>` : ''}
        </div>
        <fieldset class="assign"><legend>Für wen?</legend>
          <label class="check"><input type="checkbox" name="all" data-assign-all ${all ? 'checked' : ''}><span>Alle</span></label>
          ${people.map((u) => `<label class="check"><input type="checkbox" name="a" value="${esc(u.id)}" data-assign-one ${!all && t.assignees.includes(u.id) ? 'checked' : ''}><span>${esc(u.name)}</span></label>`).join('')}
        </fieldset>
        ${t ? `<label class="check"><input type="checkbox" name="done" ${done ? 'checked' : ''}><span>Erledigt${done ? `<small>${esc(doneText(t))}</small>` : ''}</span></label>` : ''}`,
      onSubmit: async (fd) => {
        const title = String(fd.get('title') || '').trim();
        if (!title) return 'Bitte beschreib kurz, was zu tun ist.';
        const assignees = fd.get('all') === 'on' ? [] : fd.getAll('a').map(String);
        if (fd.get('all') !== 'on' && !assignees.length) return 'Bitte wähl aus, für wen die Aufgabe ist, oder kreuz „Alle“ an.';
        const body = {
          title, details: String(fd.get('details') || ''), day: String(fd.get('day') || ''),
          projectId: String(fd.get('project') || '') || null, assignees,
        };
        const r = t ? await call('PUT', `/api/tasks/${encodeURIComponent(t.id)}`, body) : await call('POST', '/api/tasks', body);
        if (t && (fd.get('done') === 'on') !== done) {
          await call('POST', `/api/tasks/${encodeURIComponent(t.id)}/${done ? 'reopen' : 'done'}`, {});
        }
        if (!t && body.day !== ui.tasksDay) ui.tasksDay = body.day;
        await loadAdminTasks();
        render();
        toast(t ? 'Aufgabe gespeichert' : `Aufgabe angelegt für ${shortDate(r.task.day)}`);
        return null;
      },
      del: t ? async () => {
        await call('DELETE', `/api/tasks/${encodeURIComponent(t.id)}`);
        ui.adminTasks = ui.adminTasks.filter((x) => x.id !== t.id);
        render();
        toast('Aufgabe gelöscht');
        return null;
      } : null,
    });
  }

  // ------------------------------------------------------------------
  // Ansicht: Einstellungen
  // ------------------------------------------------------------------
  function viewSettings() {
    const u = session.user;
    const s = me.settings;
    const c = session.company;
    const year = +todayKey().slice(0, 4);
    const hol = [...Z.holidays(year, c.state)].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const projects = me.projects;
    const admin = isAdmin();
    return `
      <header class="page-head"><h1>Einstellungen</h1></header>

      <section class="settings-sec" aria-labelledby="acc-h">
        <h2 id="acc-h">Mein Konto</h2>
        <dl class="facts">
          <div><dt>Name</dt><dd>${esc(u.name)}</dd></div>
          <div><dt>Benutzername</dt><dd>${esc(u.username)}</dd></div>
          <div><dt>Sollzeit</dt><dd>${esc(describeTargets(s.targets))}</dd></div>
          <div><dt>Urlaub</dt><dd>${fmtDays(s.vacationDaysPerYear)} Tage pro Jahr</dd></div>
          <div><dt>Feiertage</dt><dd>${c.state ? esc(Z.STATES[c.state]) : 'nur bundesweite'}</dd></div>
        </dl>
        <p class="help">${admin ? 'Deine eigenen Einträge, Berichte, Sollzeit und Urlaub findest du unter Team bei deinem Namen.' : 'Sollzeit und Urlaub legt das Büro fest. Stimmt etwas nicht, sag dort Bescheid.'}</p>
      </section>

      ${admin ? `
      <form id="company-form" class="settings settings-sec" novalidate>
        <fieldset>
          <legend>Firma</legend>
          <label class="field"><span>Firmenname</span><input type="text" name="name" value="${esc(c.name)}" maxlength="80"></label>
          <label class="field"><span>Bundesland für Feiertage</span>
            <select name="state">
              <option value="">Nur bundesweite Feiertage</option>
              ${Object.entries(Z.STATES).map(([code, n]) => `<option value="${code}" ${c.state === code ? 'selected' : ''}>${esc(n)}</option>`).join('')}
            </select>
          </label>
          <details><summary>Feiertage ${year} ansehen</summary>
            <ul class="holiday-list">${hol.map(([kk, n]) => `<li><span class="num">${shortDate(kk)}</span> ${esc(n)}</li>`).join('')}</ul>
            <p class="help">Feiertage, die nur in einzelnen Gemeinden gelten, trägst du als Abwesenheit „Sonderurlaub / bezahlt frei“ ein.</p>
          </details>
          <label class="check"><input type="checkbox" name="employeesCanEdit" ${c.employeesCanEdit ? 'checked' : ''}>
            <span>Mitarbeiter dürfen Zeiten und Abwesenheiten selbst nachtragen und ändern
            <small>Jede Änderung landet im Änderungsprotokoll. Ist das aus, korrigiert nur das Büro.</small></span></label>
          <label class="check"><input type="checkbox" name="autoBreak" ${c.autoBreak ? 'checked' : ''}>
            <span>Gesetzliche Mindestpause automatisch abziehen
            <small>Ist an einem Tag weniger Pause erfasst als vorgeschrieben (30 Min. ab 6 Std., 45 Min. ab 9 Std.), wird der Rest von der Arbeitszeit abgezogen.</small></span></label>
        </fieldset>
        <p class="form-error" role="alert" hidden></p>
        <button type="submit" class="btn btn--primary btn--wide">Firma speichern</button>
      </form>

      <section class="settings-sec" aria-labelledby="pj-h">
        <h2 id="pj-h">Projekte</h2>
        <p class="help">Projekte sind freiwillig. Gibt es welche, wählen die Mitarbeiter beim Stempeln aus, woran sie arbeiten.</p>
        ${projects.length ? `<ul class="projects">${projects.map((p) => `<li><button type="button" class="proj-row" data-act="editProject" data-id="${esc(p.id)}">
          <i class="dot" style="--c:${esc(p.color)}"></i>
          <span class="pname">${esc(p.name)}${p.client ? `<small>${esc(p.client)}</small>` : ''}</span>
          <span class="muted">${p.archived ? 'archiviert' : ''}</span></button></li>`).join('')}</ul>` : ''}
        <div class="actions"><button type="button" class="btn" data-act="newProject">Projekt anlegen</button></div>
      </section>

      <section class="settings-sec" aria-labelledby="bk-h">
        <h2 id="bk-h">Datensicherung</h2>
        <p>Alle Daten liegen in einer Datei auf dem Server. Lade regelmäßig ein Backup herunter, oder lass den Ordner <code>data</code> auf dem Server automatisch sichern.</p>
        <div class="actions"><a class="btn" href="/api/backup" download>Backup herunterladen</a></div>
      </section>` : ''}

      <form id="password-form" class="settings settings-sec" novalidate>
        <fieldset>
          <legend>Passwort ändern</legend>
          <input type="text" name="username" value="${esc(u.username)}" autocomplete="username" hidden>
          <label class="field"><span>Bisheriges Passwort</span><input type="password" name="current" autocomplete="current-password"></label>
          <label class="field"><span>Neues Passwort, mindestens 8 Zeichen</span><input type="password" name="next" autocomplete="new-password" minlength="8"></label>
        </fieldset>
        <p class="form-error" role="alert" hidden></p>
        <button type="submit" class="btn">Passwort ändern</button>
      </form>

      <section class="settings-sec" aria-labelledby="ph-h">
        <h2 id="ph-h">Auf dem Handy</h2>
        ${installHelp()}
      </section>

      <button type="button" class="btn btn--wide" data-act="logout">Abmelden</button>
      <p class="about">Die Hinweise zum Arbeitszeitgesetz helfen beim Erfassen. Eine rechtliche Prüfung ersetzen sie nicht.</p>`;
  }

  // ------------------------------------------------------------------
  // Anmelden, Einladung, Ersteinrichtung
  // ------------------------------------------------------------------
  function shell(html) {
    document.body.classList.remove('app');
    $('#view').innerHTML = `<div class="auth">${html}</div>`;
  }

  function showLogin(message, company) {
    session = null;
    const name = company && company.name;
    shell(`
      <h1>${esc(name || 'Zeiterfassung')}</h1>
      <p class="sub">Melde dich an, um zu stempeln.</p>
      ${message ? `<p class="note">${esc(message)}</p>` : ''}
      <form id="login-form" novalidate>
        <label class="field"><span>Benutzername</span><input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
        <label class="field"><span>Passwort</span><input type="password" name="password" autocomplete="current-password"></label>
        <p class="form-error" role="alert" hidden></p>
        <button type="submit" class="btn btn--primary btn--wide">Anmelden</button>
      </form>
      <p class="help">Noch keinen Zugang oder Passwort vergessen? Das Büro schickt dir einen Einladungslink.</p>`);
  }

  function showSetup() {
    shell(`
      <h1>Zeiterfassung einrichten</h1>
      <p class="sub">Du legst die Firma und deinen eigenen Zugang als Admin an. Danach lädst du deine Mitarbeiter ein.</p>
      <form id="setup-form" class="settings" novalidate>
        <label class="field"><span>Einrichtungscode</span><input type="text" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX"></label>
        <p class="help">Der Code steht in der Ausgabe des Servers, wenn er zum ersten Mal startet.</p>
        <label class="field"><span>Firmenname</span><input type="text" name="company" maxlength="80"></label>
        <label class="field"><span>Bundesland für Feiertage</span>
          <select name="state"><option value="">Nur bundesweite Feiertage</option>
            ${Object.entries(Z.STATES).map(([code, n]) => `<option value="${code}">${esc(n)}</option>`).join('')}
          </select></label>
        <label class="field"><span>Dein Name</span><input type="text" name="name" autocomplete="name" maxlength="80"></label>
        <label class="field"><span>Benutzername</span><input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
        <label class="field"><span>Passwort, mindestens 8 Zeichen</span><input type="password" name="password" autocomplete="new-password"></label>
        <p class="form-error" role="alert" hidden></p>
        <button type="submit" class="btn btn--primary btn--wide">Einrichten</button>
      </form>`);
  }

  async function showInvite(token) {
    shell('<p class="empty">Lädt …</p>');
    let info;
    try {
      info = await Api.get('/api/invite/' + encodeURIComponent(token));
    } catch (err) {
      shell(`<h1>Einladung</h1><p class="note">${esc(errText(err))}</p><p><a href="#" data-act="toLogin">Zur Anmeldung</a></p>`);
      return;
    }
    shell(`
      <h1>Willkommen${info.company ? ' bei ' + esc(info.company) : ''}</h1>
      <p class="sub">Hallo ${esc(info.name)}, leg dein Passwort fest. Danach kannst du sofort stempeln.</p>
      <form id="invite-form" data-token="${esc(token)}" novalidate>
        <input type="text" name="username" value="${esc(info.username)}" autocomplete="username" hidden>
        <p>Dein Benutzername: <b>${esc(info.username)}</b></p>
        <label class="field"><span>Passwort, mindestens 8 Zeichen</span><input type="password" name="password" autocomplete="new-password"></label>
        <label class="field"><span>Passwort wiederholen</span><input type="password" name="repeat" autocomplete="new-password"></label>
        <p class="form-error" role="alert" hidden></p>
        <button type="submit" class="btn btn--primary btn--wide">Passwort festlegen und loslegen</button>
      </form>`);
  }

  function showMessage(title, text) {
    shell(`<h1>${esc(title)}</h1><p class="sub">${esc(text)}</p><p><button type="button" class="btn btn--primary" data-act="reload">Noch einmal versuchen</button></p>`);
  }

  /** Tag und Monate nach der Serveruhr ausrichten (die Handyuhr kann falsch gehen) */
  function syncDays() {
    const k = todayKey();
    const ym = { y: +k.slice(0, 4), m: +k.slice(5, 7) };
    ui.day = k;
    ui.tasksDay = k;
    ui.entriesMonth = { ...ym };
    ui.reportMonth = { ...ym };
    ui.teamMonth = { ...ym };
  }

  async function enterApp(s) {
    session = { user: s.user, company: s.company };
    try {
      await flushQueue();
      setMe((await call('GET', '/api/state')).state);
    } catch (err) {
      const c = store.get('ze.cache', null);
      if (err.offline && c && c.session && c.session.user.id === session.user.id) setMe(c.state);
      else {
        if (!err.handled) showMessage('Keine Verbindung', 'Der Server ist gerade nicht erreichbar. Prüf deine Internetverbindung.');
        return;
      }
    }
    syncDays();
    document.body.classList.add('app');
    renderNav();
    if (/^#einladung\//.test(location.hash)) history.replaceState(null, '', '#heute');
    await route();
  }

  async function boot() {
    const m = /^#einladung\/([\w-]+)$/.exec(location.hash);
    if (m) return showInvite(m[1]);
    let s;
    try {
      s = await Api.get('/api/session');
    } catch (err) {
      const c = store.get('ze.cache', null);
      if (err.offline && c && c.session) {
        session = c.session;
        setMe(c.state);
        syncDays();
        document.body.classList.add('app');
        renderNav();
        return route();
      }
      return showMessage('Keine Verbindung', 'Der Server ist gerade nicht erreichbar. Prüf deine Internetverbindung.');
    }
    if (s.needsSetup) return showSetup();
    if (!s.user) return showLogin(null, s.company);
    return enterApp(s);
  }

  // ------------------------------------------------------------------
  // Dialoge
  // ------------------------------------------------------------------
  function showFormError(form, err) {
    const el = form.querySelector('.form-error');
    if (!el) return;
    el.hidden = !err;
    el.textContent = err || '';
  }

  /** onSubmit/del: async, geben eine Fehlermeldung zurück oder null */
  function openDialog({ title, body, submit, onSubmit, del, danger, cancel }) {
    const dlg = $('#dlg');
    dlg.innerHTML = `<form novalidate>
      <h2 id="dlg-title">${esc(title)}</h2>
      <div class="dlg-body">${body}</div>
      <p class="form-error" role="alert" hidden></p>
      <div class="dlg-actions">
        ${del ? '<button type="button" class="btn btn--quiet btn--del" data-dlg="delete">Löschen</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn btn--quiet" data-dlg="cancel">${esc(cancel || 'Abbrechen')}</button>
        ${submit ? `<button type="submit" class="btn ${danger ? 'btn--danger' : 'btn--primary'}">${esc(submit)}</button>` : ''}
      </div>
    </form>`;
    const form = dlg.querySelector('form');
    const run = async (fn, btn) => {
      btn.disabled = true;
      let err;
      try {
        err = await fn();
      } catch (e) {
        err = errText(e);
      }
      btn.disabled = false;
      if (err) showFormError(form, err);
      else if (dlg.open) dlg.close();
    };
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (onSubmit) run(() => onSubmit(new FormData(form), form), form.querySelector('[type=submit]'));
    });
    dlg.querySelector('[data-dlg=cancel]').addEventListener('click', () => dlg.close());
    if (del) {
      const b = dlg.querySelector('[data-dlg=delete]');
      b.addEventListener('click', () => run(del, b));
    }
    dlg.showModal();
    return dlg;
  }

  function projectField(selected) {
    if (!state.projects.length) return '<input type="hidden" name="project" value="">';
    return `<label class="field"><span>Projekt</span>
      <select name="project"><option value="">Ohne Projekt</option>${projectOptions(selected)}</select></label>`;
  }

  function openEntryDialog(id, date) {
    const e = id ? state.entries.find((x) => x.id === id) : null;
    if (id && !e) return;
    if (!canEdit()) {
      toast('Änderungen macht bei euch das Büro. Sag dort Bescheid, wenn etwas nicht stimmt.');
      return;
    }
    const k = e ? Z.dateKey(e.start) : date || todayKey();
    const initialPause = e ? Math.round(Z.entryMs(e, now()).brk / MIN) : 0;
    const running = e && e.end == null;
    openDialog({
      title: e ? 'Eintrag bearbeiten' : 'Zeit nachtragen',
      submit: 'Speichern',
      body: `
        <label class="field"><span>Datum</span><input type="date" name="date" value="${k}"></label>
        <div class="field-row field-row--3">
          <label class="field"><span>Kommen</span><input type="time" name="from" value="${e ? Z.timeOfDay(e.start) : ''}"></label>
          <label class="field"><span>Gehen</span><input type="time" name="to" value="${e && e.end != null ? Z.timeOfDay(e.end) : ''}"></label>
          <label class="field"><span>Pause, Min.</span><input type="number" name="pause" min="0" step="1" inputmode="numeric" value="${initialPause}"></label>
        </div>
        ${running ? '<p class="help">Diese Zeit läuft noch. Trag eine Gehen-Zeit ein, um sie zu beenden.</p>' : ''}
        ${projectField(e ? e.projectId : state.activeProjectId)}
        <label class="field"><span>Notiz</span><input type="text" name="note" maxlength="300" value="${esc(e ? e.note : '')}"></label>
        ${viewingOther() || e ? '' : '<p class="help">Nachträge sind für das Büro als „nachgetragen“ markiert.</p>'}`,
      onSubmit: (fd) => saveEntry(fd, e, initialPause),
      del: e ? async () => {
        const body = entryBody(e);
        const r = await call('DELETE', '/api/entries/' + e.id);
        applyState(r.state);
        render();
        toast('Eintrag gelöscht', () => act(() => call('POST', '/api/entries', body), 'Eintrag wiederhergestellt'));
        return null;
      } : null,
    });
  }

  async function saveEntry(fd, e, initialPause) {
    const date = String(fd.get('date') || '');
    const from = String(fd.get('from') || '');
    const to = String(fd.get('to') || '');
    if (!date || !from) return 'Bitte Datum und Kommen-Zeit angeben.';
    const start = Z.combine(date, from);
    let end = null;
    let overnight = false;
    if (to) {
      end = Z.combine(date, to);
      if (end <= start) {
        end = Z.combine(Z.addDays(date, 1), to);
        overnight = true;
      }
    }
    const pv = String(fd.get('pause') || '').trim();
    const pauseMin = pv === '' ? 0 : Math.round(Number(pv));
    if (!(pauseMin >= 0)) return 'Die Pause bitte in ganzen Minuten angeben.';
    let breaks = e ? e.breaks : [];
    let pause = e ? e.pauseMin : pauseMin;
    if (!e || pauseMin !== initialPause) {
      // Pause von Hand geändert: Pausenstempel durch den Minutenwert ersetzen
      breaks = e ? e.breaks.filter((b) => b.end == null && end == null) : [];
      pause = pauseMin;
    }
    const body = {
      start, end, pauseMin: pause, breaks,
      projectId: String(fd.get('project') || '') || null,
      note: String(fd.get('note') || '').trim(),
      userId: viewingOther() ? ui.subjectId : undefined,
    };
    const r = e ? await call('PUT', '/api/entries/' + e.id, body) : await call('POST', '/api/entries', body);
    applyState(r.state);
    render();
    toast((e ? 'Eintrag gespeichert' : 'Zeit nachgetragen') + (overnight ? ', endet am Folgetag' : ''));
    return null;
  }

  function openAbsenceDialog(id, date) {
    const a = id ? state.absences.find((x) => x.id === id) : null;
    if (id && !a) return;
    const from = a ? a.from : date || todayKey();
    openDialog({
      title: a ? 'Abwesenheit bearbeiten' : 'Abwesenheit eintragen',
      submit: 'Speichern',
      body: `
        <label class="field"><span>Art</span><select name="type">
          ${Object.entries(Z.ABSENCE_TYPES).map(([key, t]) => `<option value="${key}" ${a && a.type === key ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
        </select></label>
        <div class="field-row">
          <label class="field"><span>Von</span><input type="date" name="from" value="${from}"></label>
          <label class="field"><span>Bis</span><input type="date" name="to" value="${a ? a.to : from}"></label>
        </div>
        <label class="check"><input type="checkbox" name="half" ${a && a.half ? 'checked' : ''}><span>Halber Tag<small>Geht nur, wenn Von und Bis derselbe Tag sind.</small></span></label>
        <label class="field"><span>Notiz</span><input type="text" name="note" maxlength="200" value="${esc(a ? a.note : '')}"></label>
        <p class="help">Urlaub, Krankheit und bezahlte Freistellung senken das Soll dieser Tage. Ein Gleittag lässt das Soll stehen und baut so Überstunden ab.</p>`,
      onSubmit: async (fd) => {
        const type = String(fd.get('type'));
        const f = String(fd.get('from') || '');
        const t = String(fd.get('to') || '') || f;
        const half = fd.get('half') === 'on';
        if (!f) return 'Bitte ein Von-Datum wählen.';
        if (t < f) return 'Das Bis-Datum liegt vor dem Von-Datum.';
        if (half && t !== f) return 'Einen halben Tag kannst du nur für einen einzelnen Tag eintragen.';
        const body = { type, from: f, to: t, half, note: String(fd.get('note') || '').trim(), userId: viewingOther() ? ui.subjectId : undefined };
        const r = a ? await call('PUT', '/api/absences/' + a.id, body) : await call('POST', '/api/absences', body);
        applyState(r.state);
        render();
        toast(`${Z.ABSENCE_TYPES[type].short} eingetragen: ${daysWord(absenceDays(f, t, half))}`);
        return null;
      },
      del: a ? async () => {
        const body = { ...a, userId: viewingOther() ? ui.subjectId : undefined };
        const r = await call('DELETE', '/api/absences/' + a.id);
        applyState(r.state);
        render();
        toast('Abwesenheit gelöscht', () => act(() => call('POST', '/api/absences', body), 'Abwesenheit wiederhergestellt'));
        return null;
      } : null,
    });
  }

  function openProjectDialog(id) {
    const p = id ? projectById(id) : null;
    if (id && !p) return;
    const color = p ? p.color : Z.COLORS[me.projects.length % Z.COLORS.length];
    openDialog({
      title: p ? 'Projekt bearbeiten' : 'Projekt anlegen',
      submit: p ? 'Speichern' : 'Anlegen',
      body: `
        <label class="field"><span>Name</span><input type="text" name="name" maxlength="80" value="${esc(p ? p.name : '')}" placeholder="z. B. Baustelle Hauptstraße"></label>
        <label class="field"><span>Kunde, optional</span><input type="text" name="client" maxlength="80" value="${esc(p ? p.client : '')}"></label>
        <fieldset class="swatches"><legend>Farbe</legend>
          ${Z.COLORS.map((c, i) => `<label class="swatch" style="--c:${c}"><input type="radio" name="color" value="${c}" ${c === color ? 'checked' : ''}><span class="sr-only">${COLOR_NAMES[i]}</span></label>`).join('')}
        </fieldset>
        ${p ? `<label class="check"><input type="checkbox" name="archived" ${p.archived ? 'checked' : ''}><span>Archiviert<small>Archivierte Projekte stehen beim Stempeln nicht mehr zur Auswahl. Ihre Zeiten bleiben erhalten.</small></span></label>` : ''}`,
      onSubmit: async (fd) => {
        const name = String(fd.get('name') || '').trim();
        if (!name) return 'Bitte gib dem Projekt einen Namen.';
        const body = { name, client: String(fd.get('client') || '').trim(), color: fd.get('color') || color, archived: fd.get('archived') === 'on' };
        const r = p ? await call('PUT', '/api/projects/' + p.id, body) : await call('POST', '/api/projects', body);
        setProjects(r.projects);
        render();
        toast(p ? 'Projekt gespeichert' : `Projekt „${name}“ angelegt`);
        return null;
      },
      del: p ? async () => {
        const r = await call('DELETE', '/api/projects/' + p.id);
        setProjects(r.projects);
        render();
        toast('Projekt gelöscht');
        return null;
      } : null,
    });
  }

  function openMemberDialog() {
    const k = todayKey();
    openDialog({
      title: 'Mitarbeiter anlegen',
      submit: 'Anlegen und Link erzeugen',
      body: `
        <label class="field"><span>Name</span><input type="text" name="name" maxlength="80" autocomplete="off" data-username-source></label>
        <div class="field-row">
          <label class="field"><span>Benutzername</span><input type="text" name="username" autocapitalize="none" autocomplete="off" spellcheck="false" data-username></label>
          <label class="field"><span>Rolle</span><select name="role"><option value="employee">Mitarbeiter/in</option><option value="admin">Admin (Büro)</option></select></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Wochenstunden</span><input type="text" name="weekly" inputmode="decimal" value="40"></label>
          <label class="field"><span>Urlaubstage pro Jahr</span><input type="number" name="vacation" min="0" max="366" step="0.5" value="30"></label>
        </div>
        <fieldset class="days-pick"><legend>Arbeitstage</legend>
          ${ORDER.map((i) => `<label><input type="checkbox" name="d${i}" ${i >= 1 && i <= 5 ? 'checked' : ''}><span>${Z.WEEKDAYS_SHORT[i]}</span></label>`).join('')}
        </fieldset>
        <label class="field"><span>Zeitkonto zählt ab</span><input type="date" name="startDate" value="${k}"></label>
        <p class="help">Die Wochenstunden werden gleichmäßig auf die Arbeitstage verteilt. Abweichende Tage stellst du danach unter „Vertrag“ ein.</p>`,
      onSubmit: async (fd) => {
        const name = String(fd.get('name') || '').trim();
        if (!name) return 'Bitte einen Namen angeben.';
        const weekly = Z.parseDuration(fd.get('weekly'));
        if (weekly == null || weekly < 0 || weekly > 7 * 1440) return 'Die Wochenstunden bitte als Zahl eingeben, zum Beispiel 40 oder 38,5.';
        const days = ORDER.filter((i) => fd.get('d' + i) === 'on');
        if (weekly > 0 && !days.length) return 'Bitte mindestens einen Arbeitstag ankreuzen.';
        const targets = [0, 0, 0, 0, 0, 0, 0];
        days.forEach((i) => { targets[i] = Math.round(weekly / days.length); });
        const r = await call('POST', '/api/users', {
          name,
          username: String(fd.get('username') || '').trim(),
          role: fd.get('role'),
          settings: { targets, vacationDaysPerYear: Number(fd.get('vacation')) || 0, startDate: String(fd.get('startDate') || k), openingBalanceMin: 0 },
        });
        await loadTeam();
        render();
        setTimeout(() => openInviteDialog(r.user, r.invite), 0);
        return null;
      },
    });
  }

  function openInviteDialog(u, invite) {
    const first = u.name.split(/\s+/)[0];
    const msg = `Hallo ${first}, hier ist dein Zugang zur Zeiterfassung${session.company.name ? ' von ' + session.company.name : ''}: ${invite.url} – Link öffnen, Passwort festlegen, fertig. Dein Benutzername ist ${u.username}. Der Link gilt 7 Tage.`;
    const dlg = openDialog({
      title: `Einladung für ${u.name}`,
      cancel: 'Fertig',
      body: `
        <p>Schick ${esc(first)} diesen Link aufs Handy. Darüber legt ${esc(first)} ein Passwort fest und ist sofort angemeldet. Der Link gilt 7 Tage und funktioniert nur einmal.</p>
        <label class="field"><span>Link</span><input type="text" readonly value="${esc(invite.url)}" data-invite-url></label>
        <p class="help">Benutzername für spätere Anmeldungen: <b>${esc(u.username)}</b></p>
        <div class="actions">
          ${navigator.share ? '<button type="button" class="btn btn--primary" data-share>Teilen</button>' : ''}
          <a class="btn" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Per WhatsApp</a>
          <a class="btn" href="mailto:?subject=${encodeURIComponent('Dein Zugang zur Zeiterfassung')}&amp;body=${encodeURIComponent(msg)}">Per E-Mail</a>
          <button type="button" class="btn" data-copy>Kopieren</button>
        </div>`,
    });
    const share = $('[data-share]', dlg);
    if (share) share.addEventListener('click', () => navigator.share({ title: 'Zeiterfassung', text: msg }).catch(() => {}));
    $('[data-copy]', dlg).addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(invite.url);
        toast('Link kopiert');
      } catch (_) {
        const input = $('[data-invite-url]', dlg);
        input.select();
        toast('Link markiert. Jetzt kopieren und verschicken.');
      }
    });
  }

  function confirmDialog(title, text, okLabel, onOk) {
    openDialog({ title, submit: okLabel, danger: true, body: `<p>${esc(text)}</p>`, onSubmit: onOk });
  }

  // ------------------------------------------------------------------
  // Formulare
  // ------------------------------------------------------------------
  async function withForm(form, fn) {
    const btn = form.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    let err = null;
    try {
      err = await fn(new FormData(form));
    } catch (e) {
      if (!e.handled) err = errText(e);
    }
    if (btn && btn.isConnected) btn.disabled = false;
    if (form.isConnected) showFormError(form, err);
  }

  const forms = {
    'login-form': (fd) => Api.post('/api/login', { username: fd.get('username'), password: fd.get('password') })
      .then((r) => { enterApp(r); return null; }),
    'setup-form': (fd) => Api.post('/api/setup', Object.fromEntries(fd)).then((r) => {
      enterApp(r).then(() => { location.hash = '#team'; });
      return null;
    }),
    'invite-form': (fd, form) => {
      if (fd.get('password') !== fd.get('repeat')) return 'Die beiden Passwörter sind nicht gleich.';
      return Api.post('/api/invite/' + encodeURIComponent(form.dataset.token), { password: fd.get('password') })
        .then((r) => { history.replaceState(null, '', '#heute'); enterApp(r); return null; });
    },
    'password-form': async (fd, form) => {
      await call('POST', '/api/password', { current: fd.get('current'), next: fd.get('next') });
      form.reset();
      toast('Passwort geändert. Andere Geräte sind abgemeldet.');
      return null;
    },
    'company-form': async (fd) => {
      const r = await call('PUT', '/api/company', {
        name: fd.get('name'), state: fd.get('state'),
        autoBreak: fd.get('autoBreak') === 'on', employeesCanEdit: fd.get('employeesCanEdit') === 'on',
      });
      session.company = r.company;
      setMe((await call('GET', '/api/state')).state);
      render();
      toast('Firma gespeichert');
      return null;
    },
    'member-form': async (fd) => {
      const { targets, error } = readTargets(fd);
      if (error) return error;
      const ov = String(fd.get('opening') || '').trim();
      const opening = ov === '' ? 0 : Z.parseDuration(ov);
      if (opening == null) return 'Den Übertrag bitte als Stunden eingeben, zum Beispiel +12:30 oder -3:00.';
      const vacation = Number(fd.get('vacation'));
      if (!(vacation >= 0) || vacation > 366) return 'Urlaubstage bitte als Zahl zwischen 0 und 366 eingeben.';
      const body = {
        name: fd.get('name'), username: fd.get('username'),
        settings: { targets, startDate: fd.get('startDate'), openingBalanceMin: opening, vacationDaysPerYear: vacation },
      };
      if (fd.get('role')) body.role = fd.get('role');
      const r = await call('PUT', '/api/users/' + ui.subjectId, body);
      if (r.user.id === session.user.id) {
        session.user = { ...session.user, ...r.user };
        setMe((await call('GET', '/api/state')).state);
      }
      await Promise.all([loadTeam(), loadOther()]);
      render();
      toast('Gespeichert');
      return null;
    },
  };

  // ------------------------------------------------------------------
  // Export
  // ------------------------------------------------------------------
  function reportRange() {
    const ym = ui.reportMonth;
    const [from, to] = Z.monthRange(ym.y, ym.m);
    const k = todayKey();
    return { from, to: to < k ? to : k, tag: `${ym.y}-${Z.pad(ym.m)}` };
  }
  const personSlug = () => slug(state.settings.name) || 'export';
  function csvEntries() {
    const { from, to, tag } = reportRange();
    const pf = ui.reportProject;
    const p = projectById(pf);
    const suffix = pf === '__all' ? 'eintraege' : pf === '' ? 'ohne-projekt' : slug(p ? p.name : 'projekt');
    download(`zeiterfassung-${tag}-${personSlug()}-${suffix}.csv`, Z.entriesCSV(ctx, from, to, pf === '__all' ? undefined : pf), 'text/csv;charset=utf-8');
  }
  function csvDays() {
    const { from, to, tag } = reportRange();
    download(`zeiterfassung-${tag}-${personSlug()}-tage.csv`, Z.daysCSV(ctx, from, to), 'text/csv;charset=utf-8');
  }

  // ------------------------------------------------------------------
  // Laden, Rendern, Navigation
  // ------------------------------------------------------------------
  async function loadTeam() {
    if (!isAdmin()) return;
    try {
      const r = await call('GET', '/api/team');
      ui.team = r.users;
      ui.teamNow = r.now;
    } catch (err) {
      if (!err.handled) toast(errText(err));
    }
  }
  async function loadOther() {
    if (!viewingOther()) return;
    const id = ui.subjectId;
    try {
      const r = await call('GET', '/api/state?user=' + encodeURIComponent(id));
      if (ui.subjectId === id) {
        other = Z.normalizeState(r.state);
        ui.otherId = id;
      }
    } catch (err) {
      if (!err.handled) toast(errText(err));
    }
  }
  async function loadAudit() {
    ui.audit = null;
    try {
      ui.audit = (await call('GET', `/api/users/${encodeURIComponent(ui.subjectId)}/audit`)).items;
    } catch (err) {
      ui.audit = [];
      if (!err.handled) toast(errText(err));
    }
  }

  function renderNav() {
    // Büro: eigene Einträge und Berichte unter Team beim eigenen Namen
    const tabs = isAdmin() ? ['heute', 'aufgaben', 'team', 'einstellungen'] : ['heute', 'eintraege', 'bericht', 'einstellungen'];
    $('.tabs-inner').style.gridTemplateColumns = `repeat(${tabs.length}, 1fr)`;
    $('.tabs-inner').innerHTML = tabs.map((t) => `<a href="#${t}" data-view="${t}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t]}</svg><span>${TAB_LABELS[t]}</span></a>`).join('');
  }

  function banner() {
    const q = getQueue().length;
    if (q) return `<p class="offline-banner">Ohne Netz gestempelt: ${q} ${q === 1 ? 'Stempelung wartet' : 'Stempelungen warten'} auf Übertragung. Das passiert automatisch.</p>`;
    if (navigator.onLine === false) return '<p class="offline-banner">Du bist offline. Stempeln geht trotzdem, es wird später übertragen.</p>';
    return '';
  }

  function render() {
    if (!session || !me) return;
    state = viewingOther() ? (ui.otherId === ui.subjectId ? other : null) : me;
    ctx = Z.makeContext(state || me, now());
    let html;
    if (ui.view === 'team') html = ui.subjectId ? viewMember() : viewTeam();
    else if (ui.view === 'aufgaben') html = viewTasks();
    else if (ui.view === 'eintraege') html = viewEntries(false);
    else if (ui.view === 'bericht') html = viewReport(false);
    else if (ui.view === 'einstellungen') html = viewSettings();
    else html = viewToday();
    $('#view').innerHTML = banner() + html;
    $$('.tabs a').forEach((a) => {
      if (a.dataset.view === ui.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    ui.stamp = null;
    tick(true);
  }

  function setText(sel, html) {
    const el = $(sel);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }

  function tick(force) {
    if (!session || !me || (document.hidden && !force)) return;
    const k = todayKey();
    if (k !== ui.day) {
      ui.day = k;
      render();
      return;
    }
    const run = Z.runningEntry(me.entries);
    if (ui.view !== 'heute') {
      document.title = 'Zeiterfassung';
      return;
    }
    ctx.now = now();
    const ms = todayMs(run, k);
    document.title = run ? `${Z.fmtHMS(ms)} – Zeiterfassung` : 'Zeiterfassung';
    if (!$('[data-live=timer]')) return;
    const d = Z.daySummary(ctx, k);
    setText('[data-live=timer]', Z.fmtHMS(ms));
    setText('[data-live=sub]', esc(subText(d, run)));
    const ws = Z.startOfWeek(k);
    const w = Z.rangeSummary(ctx, ws, Z.addDays(ws, 6));
    setText('[data-live=week]', `${hm(w.workMin)} von ${hm(w.targetMin)}`);
    const bar = $('[data-live=weekbar]');
    if (bar) bar.style.width = (w.targetMin ? Math.min(100, Math.round((w.workMin / w.targetMin) * 100)) : 0) + '%';
    setText('[data-live=after]', bal(ui.balYesterday + d.balanceMin));
  }

  async function route() {
    if (!session) return;
    const parts = location.hash.slice(1).split('/');
    let v = parts[0] || 'heute';
    if (!TAB_LABELS[v] || ((v === 'team' || v === 'aufgaben') && !isAdmin())) v = 'heute';
    ui.view = v;
    ui.subjectId = v === 'team' && parts[1] ? decodeURIComponent(parts[1]) : null;
    ui.sub = ui.subjectId ? (['eintraege', 'bericht', 'vertrag', 'protokoll'].includes(parts[2]) ? parts[2] : 'eintraege') : null;
    if (ui.subjectId && ui.otherId !== ui.subjectId) other = null;
    render();
    if (v === 'team') {
      const jobs = [loadTeam()];
      if (viewingOther()) jobs.push(loadOther());
      if (ui.sub === 'protokoll') jobs.push(loadAudit());
      await Promise.all(jobs);
      render();
    }
    if (v === 'aufgaben') {
      await Promise.all([loadTeam(), loadAdminTasks()]);
      render();
    }
    if (v === 'heute') {
      await loadMyTasks();
      render();
    }
  }

  // ------------------------------------------------------------------
  // Ereignisse
  // ------------------------------------------------------------------
  const actions = {
    clockIn: () => {
      const sel = $('[data-change=project]');
      stamp('in', sel ? { projectId: sel.value || null } : {});
    },
    clockOut: () => stamp('out'),
    breakStart: () => stamp('breakStart'),
    breakEnd: () => stamp('breakEnd'),
    csvEntries,
    csvDays,
    print: () => window.print(),
    newEntry: (el) => openEntryDialog(null, el.dataset.date),
    editEntry: (el) => openEntryDialog(el.dataset.id),
    newAbsence: (el) => openAbsenceDialog(null, el.dataset.date),
    editAbsence: (el) => openAbsenceDialog(el.dataset.id),
    newProject: () => openProjectDialog(null),
    editProject: (el) => openProjectDialog(el.dataset.id),
    newMember: () => openMemberDialog(),
    newTask: () => openTaskDialog(null),
    editTask: (el) => openTaskDialog(el.dataset.id),
    doneTask: (el) => openDoneDialog(el.dataset.id),
    reopenTask: (el) => reopenTask(el.dataset.id),
    taskDay: async (el) => {
      ui.tasksDay = el.dataset.day || Z.addDays(ui.tasksDay, Number(el.dataset.dir));
      ui.adminTasks = null;
      render();
      await loadAdminTasks();
      render();
    },
    refreshTeam: async () => {
      await loadTeam();
      render();
    },
    invite: async (el) => {
      const u = ui.team.find((x) => x.id === el.dataset.id);
      const r = await act(() => call('POST', `/api/users/${encodeURIComponent(u.id)}/invite`, {}));
      if (r) {
        await loadTeam();
        render();
        openInviteDialog(u, r.invite);
      }
    },
    toggleActive: (el) => {
      const u = ui.team.find((x) => x.id === el.dataset.id);
      const go = async () => {
        await call('PUT', '/api/users/' + encodeURIComponent(u.id), { active: !u.active });
        await loadTeam();
        render();
        toast(u.active ? `Zugang von ${u.name} deaktiviert` : `Zugang von ${u.name} wieder aktiv`);
        return null;
      };
      if (u.active) {
        confirmDialog(`${u.name} deaktivieren?`,
          `${u.name} kann sich dann nicht mehr anmelden und wird auf allen Geräten abgemeldet. Die erfassten Zeiten bleiben erhalten, du kannst den Zugang jederzeit wieder aktivieren.`,
          'Deaktivieren', go);
      } else go().catch((err) => toast(errText(err)));
    },
    logout: async () => {
      const q = getQueue().length;
      const go = async () => {
        try { await Api.post('/api/logout'); } catch (_) { /* trotzdem abmelden */ }
        store.del('ze.cache');
        session = null;
        me = null;
        history.replaceState(null, '', '#heute');
        showLogin('Du bist abgemeldet.');
        return null;
      };
      if (q) confirmDialog('Trotzdem abmelden?', `${q} Stempelung${q === 1 ? ' ist' : 'en sind'} noch nicht übertragen. Sie bleiben auf dem Handy und werden gesendet, sobald du dich wieder anmeldest.`, 'Abmelden', go);
      else go();
    },
    install: async () => {
      if (!ui.installPrompt) return;
      ui.installPrompt.prompt();
      await ui.installPrompt.userChoice.catch(() => {});
      ui.installPrompt = null;
      render();
    },
    dismissInstall: () => {
      store.set('ze.installHintDone', true);
      render();
    },
    toLogin: () => {
      history.replaceState(null, '', '#');
      boot();
    },
    reload: () => location.reload(),
    month: (el) => {
      const key = { report: 'reportMonth', team: 'teamMonth' }[el.dataset.which] || 'entriesMonth';
      let { y, m } = ui[key];
      m += Number(el.dataset.dir);
      if (m < 1) { m = 12; y--; }
      if (m > 12) { m = 1; y++; }
      ui[key] = { y, m };
      render();
    },
  };

  const changes = {
    project: (el) => stamp('project', { projectId: el.value || null }),
    runNote: (el) => stamp('note', { note: el.value }),
    reportProject: (el) => {
      ui.reportProject = el.value;
      render();
    },
  };

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || !actions[el.dataset.act] || el.disabled) return;
    ev.preventDefault();
    actions[el.dataset.act](el);
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-change]');
    if (el && changes[el.dataset.change]) changes[el.dataset.change](el);
    // „Alle“ und einzelne Personen schließen sich gegenseitig aus
    const form = ev.target.form;
    if (form && ev.target.checked && ev.target.matches('[data-assign-all]')) {
      $$('[data-assign-one]', form).forEach((x) => { x.checked = false; });
    }
    if (form && ev.target.checked && ev.target.matches('[data-assign-one]')) {
      const allBox = $('[data-assign-all]', form);
      if (allBox) allBox.checked = false;
    }
  });
  document.addEventListener('submit', (ev) => {
    const fn = forms[ev.target.id];
    if (!fn) return;
    ev.preventDefault();
    withForm(ev.target, (fd) => fn(fd, ev.target));
  });
  document.addEventListener('input', (ev) => {
    const form = ev.target.closest('form');
    const sum = form && $('[data-live=weeksum]', form);
    if (sum) {
      let total = 0;
      for (let i = 0; i < 7; i++) total += Math.max(0, Z.parseDuration(form.elements['t' + i].value) || 0);
      sum.textContent = hm(total);
    }
    if (ev.target.matches('[data-username-source]')) {
      const u = $('[data-username]', form);
      if (u && !u.dataset.touched) u.value = usernameFrom(ev.target.value);
    }
    if (ev.target.matches('[data-username]')) ev.target.dataset.touched = '1';
  });
  $('#dlg').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) ev.currentTarget.close(); // Klick auf den Hintergrund
  });
  window.addEventListener('hashchange', () => {
    if (!session) {
      boot();
      return;
    }
    if (/^#einladung\//.test(location.hash)) {
      boot();
      return;
    }
    route();
    window.scrollTo(0, 0);
    $('#view').focus({ preventScroll: true });
  });
  window.addEventListener('online', () => { flushQueue().then(render); });
  window.addEventListener('offline', () => render());
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    ui.installPrompt = ev;
    if (session && (ui.view === 'heute' || ui.view === 'einstellungen')) render();
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !session) return;
    await flushQueue();
    if ($('#dlg').open || ['einstellungen'].includes(ui.view) || ui.sub === 'vertrag') {
      tick(true); // offene Eingaben nicht verwerfen
      return;
    }
    try {
      setMe((await call('GET', '/api/state')).state);
    } catch (_) { /* offline: alter Stand bleibt */ }
    if (ui.view === 'team' || ui.view === 'aufgaben' || ui.view === 'heute') await route();
    else render();
  });
  setInterval(tick, 1000);
  setInterval(() => {
    if (document.hidden || !session) return;
    if (getQueue().length) flushQueue();
    if (ui.view === 'team' && !ui.subjectId && !$('#dlg').open) loadTeam().then(render);
    if (ui.view === 'heute' && !$('#dlg').open && !document.activeElement.matches('input, select, textarea')) loadMyTasks().then(render);
    if (ui.view === 'aufgaben' && !$('#dlg').open) loadAdminTasks().then(render);
  }, 60000);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker nicht registriert', err));
  }

  boot();
})();
