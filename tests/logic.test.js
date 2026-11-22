// Ausführen mit: npm test  (bzw. TZ=Europe/Berlin node --test tests/)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ZE = require('../public/js/logic.js');

const { combine } = ZE;
const at = (day, hhmm) => combine(day, hhmm);
let n = 0;
const entry = (day, from, to, extra = {}) => ({
  id: 'e' + ++n, projectId: null, start: at(day, from), end: to ? at(day, to) : null,
  breaks: [], pauseMin: 0, note: '', ...extra,
});
const state = (over = {}) => ZE.normalizeState({
  settings: { startDate: '2026-11-02', ...(over.settings || {}) },
  entries: over.entries || [],
  absences: over.absences || [],
  projects: over.projects || [],
}, at('2026-11-22', '12:00'));

test('Ostersonntag', () => {
  assert.equal(ZE.easterSunday(2024), '2024-03-31');
  assert.equal(ZE.easterSunday(2025), '2025-04-20');
  assert.equal(ZE.easterSunday(2026), '2026-04-05');
  assert.equal(ZE.easterSunday(2027), '2027-03-28');
});

test('Feiertage je Bundesland', () => {
  const by = ZE.holidays(2026, 'BY');
  assert.equal(by.get('2026-06-04'), 'Fronleichnam');
  assert.equal(by.get('2026-01-06'), 'Heilige Drei Könige');
  assert.equal(by.get('2026-11-01'), 'Allerheiligen');
  assert.equal(by.has('2026-10-31'), false);

  const sn = ZE.holidays(2026, 'SN');
  assert.equal(sn.get('2026-11-18'), 'Buß- und Bettag');
  assert.equal(sn.get('2026-10-31'), 'Reformationstag');

  assert.equal(ZE.holidays(2026, 'BE').get('2026-03-08'), 'Internationaler Frauentag');
  assert.equal(ZE.holidays(2022, 'MV').has('2022-03-08'), false);
  assert.equal(ZE.holidays(2023, 'MV').has('2023-03-08'), true);
  assert.equal(ZE.holidays(2026, 'TH').get('2026-09-20'), 'Weltkindertag');
  assert.equal(ZE.holidays(2025, 'BE').get('2025-05-08'), 'Tag der Befreiung');
  assert.equal(ZE.holidays(2017, 'BY').get('2017-10-31'), 'Reformationstag');

  const none = ZE.holidays(2026, '');
  assert.equal(none.size, 9); // bundesweit
  assert.equal(none.get('2026-04-03'), 'Karfreitag');
  assert.equal(none.get('2026-05-14'), 'Christi Himmelfahrt');
  assert.equal(none.get('2026-05-25'), 'Pfingstmontag');
});

test('Datumshilfen', () => {
  assert.equal(ZE.startOfWeek('2026-11-22'), '2026-11-16');
  assert.equal(ZE.startOfWeek('2026-11-16'), '2026-11-16');
  assert.equal(ZE.isoWeek('2026-11-22'), 47);
  assert.equal(ZE.isoWeek('2027-01-01'), 53);
  assert.equal(ZE.addDays('2026-03-28', 2), '2026-03-30'); // über Zeitumstellung
  assert.deepEqual(ZE.monthRange(2028, 2), ['2028-02-01', '2028-02-29']);
  assert.equal(ZE.daysBetween('2026-11-01', '2026-11-30').length, 30);
});

test('Dauer parsen und formatieren', () => {
  assert.equal(ZE.parseDuration('8'), 480);
  assert.equal(ZE.parseDuration('8:30'), 510);
  assert.equal(ZE.parseDuration('7,5'), 450);
  assert.equal(ZE.parseDuration('0.25'), 15);
  assert.equal(ZE.parseDuration('-1:15'), -75);
  assert.equal(ZE.parseDuration('−0:30'), -30);
  assert.equal(ZE.parseDuration(''), null);
  assert.equal(ZE.parseDuration('abc'), null);
  assert.equal(ZE.parseDuration('8:75'), null);
  assert.equal(ZE.fmtHM(75), '1:15');
  assert.equal(ZE.fmtHM(-75), '−1:15');
  assert.equal(ZE.fmtHM(-75, { ascii: true }), '-1:15');
  assert.equal(ZE.fmtHM(5, { signed: true }), '+0:05');
  assert.equal(ZE.fmtDec(450), '7,50');
});

test('Gesetzliche Pause automatisch', () => {
  assert.equal(ZE.autoBreakMin(360, 0), 0);
  assert.equal(ZE.autoBreakMin(370, 0), 10); // nur bis 6:00 kürzen
  assert.equal(ZE.autoBreakMin(400, 0), 30);
  assert.equal(ZE.autoBreakMin(400, 20), 10);
  assert.equal(ZE.autoBreakMin(400, 30), 0);
  assert.equal(ZE.autoBreakMin(580, 0), 40); // auf 9:00 kürzen
  assert.equal(ZE.autoBreakMin(600, 30), 15);
  assert.equal(ZE.autoBreakMin(600, 0), 45);
});

test('Tagesauswertung mit Pausen, Lücken und Soll', () => {
  const s = state({
    entries: [
      entry('2026-11-16', '08:00', '12:00'),
      entry('2026-11-16', '12:30', '17:00', {
        breaks: [{ start: at('2026-11-16', '15:00'), end: at('2026-11-16', '15:10') }],
      }),
    ],
  });
  const ctx = ZE.makeContext(s, at('2026-11-22', '12:00'));
  const d = ZE.daySummary(ctx, '2026-11-16');
  assert.equal(d.workMin, 8 * 60 + 20); // 4:00 + 4:30 − 0:10
  assert.equal(d.breakMin, 40); // 30 Lücke + 10 Pause
  assert.equal(d.qualMin, 30); // 10-Min.-Pause zählt nicht (§ 4: Blöcke ≥ 15 min)
  assert.equal(d.targetMin, 480);
  assert.equal(d.balanceMin, 20);
  assert.deepEqual(d.warnings, []);
  assert.equal(ZE.timeOfDay(d.lastEnd), '17:00');
});

test('Warnungen nach ArbZG', () => {
  const s = state({
    entries: [
      entry('2026-11-17', '07:00', '18:00'), // 11 h ohne Pause
      entry('2026-11-18', '04:00', '10:00'), // Ruhezeit nur 10 h
      entry('2026-11-22', '10:00', '11:00'), // Sonntag
    ],
  });
  const ctx = ZE.makeContext(s, at('2026-11-22', '12:00'));
  const d1 = ZE.daySummary(ctx, '2026-11-17');
  assert.deepEqual(d1.warnings.map((w) => w.code), ['max', 'break']);
  assert.deepEqual(ZE.daySummary(ctx, '2026-11-18').warnings.map((w) => w.code), ['rest']);
  assert.deepEqual(ZE.daySummary(ctx, '2026-11-22').warnings.map((w) => w.code), ['sunday']);
});

test('Automatischer Pausenabzug in der Tagesauswertung', () => {
  const s = state({ settings: { autoBreak: true }, entries: [entry('2026-11-16', '08:00', '16:30')] });
  const d = ZE.daySummary(ZE.makeContext(s, at('2026-11-22', '12:00')), '2026-11-16');
  assert.equal(d.autoMin, 30);
  assert.equal(d.workMin, 480);
  assert.equal(d.balanceMin, 0);
  assert.deepEqual(d.warnings, []);
});

test('Feiertag, Urlaub, halber Tag, Gleittag, Startdatum', () => {
  const s = state({
    settings: { state: 'SN' },
    absences: [
      { id: 'a1', type: 'urlaub', from: '2026-11-09', to: '2026-11-13' },
      { id: 'a2', type: 'urlaub', from: '2026-11-16', to: '2026-11-16', half: true },
      { id: 'a3', type: 'abbau', from: '2026-11-17' },
    ],
  });
  const ctx = ZE.makeContext(s, at('2026-11-22', '12:00'));
  assert.equal(ZE.daySummary(ctx, '2026-11-10').targetMin, 0);
  assert.equal(ZE.daySummary(ctx, '2026-11-16').targetMin, 240);
  assert.equal(ZE.daySummary(ctx, '2026-11-17').balanceMin, -480);
  assert.equal(ZE.daySummary(ctx, '2026-11-18').holiday, 'Buß- und Bettag');
  assert.equal(ZE.daySummary(ctx, '2026-11-18').targetMin, 0);
  assert.equal(ZE.daySummary(ctx, '2026-10-30').counted, false);
  assert.equal(ZE.daySummary(ctx, '2026-10-30').balanceMin, 0);

  const v = ZE.vacation(ctx, 2026, '2026-11-22');
  assert.deepEqual(v, { total: 30, taken: 5.5, planned: 0, left: 24.5 });
});

test('Kontostand mit Übertrag', () => {
  const s = state({
    settings: { openingBalanceMin: 120 },
    entries: [entry('2026-11-02', '08:00', '17:00', { pauseMin: 30 })], // 8:30 -> +0:30
  });
  const ctx = ZE.makeContext(s, at('2026-11-22', '12:00'));
  // 2.–6.11.: 5 Soll-Tage, nur einer gearbeitet
  assert.equal(ZE.balanceUntil(ctx, '2026-11-06'), 120 + 30 - 4 * 480);
  assert.equal(ZE.balanceUntil(ctx, '2026-11-01'), 120);
});

test('Laufender Eintrag, Pause und voraussichtliches Ende', () => {
  const now = at('2026-11-20', '12:00');
  const e = entry('2026-11-20', '08:00', null, {
    breaks: [{ start: at('2026-11-20', '11:45'), end: null }],
  });
  const s = state({ entries: [e] });
  const ctx = ZE.makeContext(s, now);
  assert.equal(ZE.isOnBreak(e), true);
  const d = ZE.daySummary(ctx, '2026-11-20');
  assert.equal(d.running, true);
  assert.equal(d.workMin, 225); // 4 h − 15 min Pause
  assert.equal(d.qualMin, 15);
  const eta = ZE.eta(ctx, '2026-11-20');
  // noch 255 min + 15 min fehlende Pause
  assert.equal(ZE.timeOfDay(eta.at), '16:30');
});

test('Überschneidungen erkennen', () => {
  const a = entry('2026-11-16', '08:00', '12:00');
  const b = { ...entry('2026-11-16', '11:00', '13:00'), id: 'x' };
  const c = { ...entry('2026-11-16', '12:00', '13:00'), id: 'y' };
  assert.equal(ZE.findOverlap([a], b, 0), a);
  assert.equal(ZE.findOverlap([a], c, 0), null);
});

test('CSV: Escaping, Formelschutz, Summen', () => {
  assert.equal(ZE.csvCell('a;b'), '"a;b"');
  assert.equal(ZE.csvCell('sag "hi"'), '"sag ""hi"""');
  assert.equal(ZE.csvText('=SUMME(A1)'), "'=SUMME(A1)");
  const s = state({
    projects: [{ id: 'p1', name: 'Website', client: 'ACME; GmbH' }],
    entries: [
      entry('2026-11-16', '08:00', '12:00', { projectId: 'p1', note: '=1+1' }),
      entry('2026-11-16', '13:00', '14:30'),
    ],
  });
  const ctx = ZE.makeContext(s, at('2026-11-22', '12:00'));
  const all = ZE.entriesCSV(ctx, '2026-11-01', '2026-11-30').trim().split('\r\n');
  assert.equal(all.length, 4);
  assert.equal(all[1], "16.11.2026;Mo;08:00;12:00;0;4:00;4,00;Website;\"ACME; GmbH\";'=1+1;");
  assert.match(all[3], /^Summe;;;;;5:30;5,50/);
  const only = ZE.entriesCSV(ctx, '2026-11-01', '2026-11-30', 'p1').trim().split('\r\n');
  assert.equal(only.length, 3);
  const days = ZE.daysCSV(ctx, '2026-11-16', '2026-11-16').trim().split('\r\n');
  assert.equal(days[1], '16.11.2026;Mo;;08:00;14:30;60;5:30;8:00;-2:30;5,50;8,00;-2,50;');
});

test('Import wird bereinigt', () => {
  const s = ZE.normalizeState({
    settings: { state: 'XX', targets: [0, '8', 1], startDate: 'gestern' },
    projects: [{ id: 'p', name: '  A  ', color: 'red' }, { name: '' }],
    entries: [
      { start: '2026-11-16T08:00:00+01:00', end: '2026-11-16T07:00:00+01:00' }, // Ende vor Beginn
      { id: 'r1', start: at('2026-11-16', '08:00'), end: null, projectId: 'gibtsnicht' },
      { id: 'r2', start: at('2026-11-17', '08:00'), end: null, breaks: [{ start: 'x' }] },
    ],
    absences: [{ type: 'urlaub', from: '2026-12-24', to: '2026-12-01', half: true }, { type: '??', from: '2026-01-01' }],
  }, at('2026-11-22', '12:00'));
  assert.equal(s.settings.state, '');
  assert.deepEqual(s.settings.targets, [0, 480, 480, 480, 480, 480, 0]);
  assert.equal(s.settings.startDate, '2026-11-22');
  assert.equal(s.projects.length, 1);
  assert.equal(s.projects[0].name, 'A');
  assert.equal(s.entries.length, 2);
  assert.equal(s.entries.filter((e) => e.end == null).length, 1);
  assert.equal(ZE.runningEntry(s.entries).id, 'r2');
  assert.equal(s.entries[0].projectId, null);
  assert.deepEqual(s.absences.map((a) => [a.to, a.half]), [['2026-12-24', true]]);
});

test('Stempeln: Pause, Projektwechsel in der Pause, Fehlerfälle', () => {
  const s = state({ projects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  assert.equal(ZE.applyStamp(s, { action: 'out' }, at('2026-11-16', '08:00')).error, 'Du bist nicht eingestempelt.');
  assert.ok(!ZE.applyStamp(s, { action: 'in', projectId: 'a' }, at('2026-11-16', '08:00')).error);
  assert.ok(ZE.applyStamp(s, { action: 'in' }, at('2026-11-16', '08:05')).error);
  ZE.applyStamp(s, { action: 'breakStart' }, at('2026-11-16', '12:00'));
  ZE.applyStamp(s, { action: 'project', projectId: 'b' }, at('2026-11-16', '12:10'));
  assert.equal(s.entries.length, 1); // in der Pause noch kein neuer Eintrag
  ZE.applyStamp(s, { action: 'breakEnd' }, at('2026-11-16', '12:30'));
  assert.equal(s.entries.length, 2);
  assert.equal(ZE.timeOfDay(s.entries[0].end), '12:00'); // alter Eintrag endet mit Pausenbeginn
  assert.equal(s.entries[1].projectId, 'b');
  ZE.applyStamp(s, { action: 'project', projectId: 'a' }, at('2026-11-16', '14:00'));
  ZE.applyStamp(s, { action: 'out' }, at('2026-11-16', '16:30'));
  const d = ZE.daySummary(ZE.makeContext(s, at('2026-11-17', '08:00')), '2026-11-16');
  assert.equal(d.workMin, 480);
  assert.deepEqual(d.perProject, { a: 4 * 60 + 150, b: 90 });
  assert.equal(ZE.timeOfDay(ZE.presenceStart(s.entries, s.entries[1])), '12:30');
});

test('Zahlen und Geld im deutschen Format', () => {
  assert.equal(ZE.parseDecimal('120'), 120);
  assert.equal(ZE.parseDecimal('120,5 m²'), 120.5);
  assert.equal(ZE.parseDecimal('1.080'), 1080);
  assert.equal(ZE.parseDecimal('1.5'), 1.5);
  assert.equal(ZE.parseDecimal('1.080,50'), 1080.5);
  assert.equal(ZE.parseDecimal('abc'), null);
  assert.equal(ZE.parseMoney('9,50 €'), 950);
  assert.equal(ZE.parseMoney(''), null);
  assert.equal(ZE.fmtEUR(108000), '1.080 €');
  assert.equal(ZE.fmtEUR(950), '9,50 €');
  assert.equal(ZE.fmtNum(120.5), '120,5');
});

test('Baustelle: Angebot in Stunden und in Euro, Hochrechnung', () => {
  // Stunden: 20 h angeboten, 17 h gearbeitet -> 85 % -> warn
  let st = ZE.projectStatus({ budgetMin: 1200 }, { workedMin: 1020 });
  assert.equal(st.level, 'warn');
  // mit Fortschritt 60 %: 17 h / 0,6 = 28,3 h -> 42 % drüber
  st = ZE.projectStatus({ budgetMin: 1200, progressPct: 60 }, { workedMin: 1020 });
  assert.equal(st.level, 'forecast');
  assert.equal(st.overPct, 42);
  // überschritten
  assert.equal(ZE.projectStatus({ budgetMin: 600 }, { workedMin: 630 }).level, 'over');

  // Euro (Beispiel aus dem Gespräch): 120 m² zu 9 €, 14 h zu 52 €, Material 130 €, 80 m² fertig
  const p = { offerArea: 120, offerUnitPrice: 900, doneArea: 80 };
  st = ZE.projectStatus(p, { workedMin: 14 * 60, materialCost: 13000, hourlyRate: 5200 });
  assert.equal(st.offerSum, 108000);
  assert.equal(st.cost, 85800);
  assert.equal(Math.round(st.money.forecast), 128700);
  assert.equal(st.overPct, 19);
  assert.equal(st.level, 'forecast');
  // ohne Stundensatz kein Euro-Vergleich
  assert.equal(ZE.projectStatus(p, { workedMin: 840, materialCost: 13000, hourlyRate: null }).level, null);
  // zu wenig Fortschritt für eine Hochrechnung
  assert.equal(ZE.projectStatus({ budgetMin: 1200, progressPct: 5 }, { workedMin: 300 }).level, 'ok');
});

test('Checklisten: Zeilen, Überschriften, stabile Schlüssel', () => {
  const p = ZE.parseChecklist('# Werkzeug\n- Leiter\n* Abdeckmaschine\n\n# Leer\n# Material\n[ ] Acryl\nAcryl\n- [x] Acrylspritze', 'L1');
  assert.deepEqual(p.sections.map((x) => x.title), ['Werkzeug', 'Material']);
  assert.deepEqual(p.sections[1].items.map((x) => x.text), ['Acryl', 'Acryl', 'Acrylspritze']);
  assert.equal(p.count, 5);
  const keys = p.sections.flatMap((x) => x.items.map((i) => i.key));
  assert.equal(new Set(keys).size, 5); // gleiche Zeile zweimal: eigener Schlüssel
  assert.ok(keys.every((k) => k.startsWith('L1:')));
  // Schlüssel hängt am Text, nicht an der Position
  const q = ZE.parseChecklist('Acrylspritze\nLeiter', 'L1');
  assert.equal(q.sections[0].items[1].key, p.sections[0].items[0].key);
  assert.deepEqual(ZE.checklistProgress(p, new Set([keys[0], keys[4], 'L1:fremd'])), { done: 2, total: 5 });
  assert.deepEqual(ZE.checklistProgress(p, { [keys[1]]: 1 }), { done: 1, total: 5 });
});

test('Packliste aus der Beschreibung', () => {
  const PACK = require('../public/js/packliste.js');
  const r = PACK.suggest('Innenanstrich einer Whg mit Silikatfarbe');
  assert.deepEqual(r.found, ['Innenräume', 'Wohnung', 'Anstrich', 'Silikatfarbe']);
  for (const want of ['Abdeckmaschine', 'Acrylspritze', 'Acryl', 'Leiter', 'Silikat-Grundierung oder Fixativ zum Grundieren und Verdünnen', 'Augenspülflasche']) {
    assert.ok(r.body.split('\n').includes(want), want);
  }
  assert.ok(!/Wandfarbe|Dispersionsfarbe/.test(r.body), 'keine andere Farbart');
  assert.equal(r.body.split('\n').filter((l) => /^Schutzbrille/.test(l)).length, 1, 'Schutzbrille nur einmal');
  const parsed = ZE.parseChecklist(r.body, 'eigen');
  assert.equal(parsed.count, r.count);
  assert.equal(parsed.sections[0].title, 'Vorher klären');

  assert.match(PACK.suggest('Wohnzimmer streichen').body, /Wandfarbe: Menge und Farbton laut Auftrag/);
  assert.deepEqual(PACK.suggest('Fassade streichen').found, ['Anstrich', 'Fassade']);
  assert.ok(PACK.suggest('Wohnzimmer tapezieren, alte Tapete entfernen').found.includes('Alte Tapete runter'));
  assert.ok(!PACK.suggest('Türkis streichen im Büro').found.includes('Türen'));
  assert.deepEqual(PACK.suggest('Rechnung schreiben'), { body: '', found: [], count: 0 });
});
