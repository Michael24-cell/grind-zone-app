const test = require('node:test');
const assert = require('node:assert/strict');
const insights = require('../provider-insights.js');
const metrics = require('../clinical-metrics.js');

const TODAY = '2026-03-28';

function log(day, overrides = {}) {
  return { patient_logical_day: day, ts: `${day}T12:00:00-08:00`, drug: 'concerta', feel: 6, tags: [], time: '12:00', zone: 'Building', elapsed_h: 2, ...overrides };
}

test('period comparison uses adjacent equal windows and withholds delta when sparse', () => {
  const logs = [log('2026-03-28', { feel: 8 }), log('2026-03-20', { feel: 6 }), log('2026-03-15', { feel: 7 }), log('2026-03-14', { feel: 4 })];
  const r = insights.periodComparison(logs, { today: TODAY, days: 14 });
  assert.equal(r.recent.start, '2026-03-15');
  assert.equal(r.prior.end, '2026-03-14');
  assert.equal(r.prior.start, '2026-03-01');
  assert.equal(r.recent.n, 3);
  assert.equal(r.prior.n, 1);
  assert.equal(r.delta, null);
  assert.equal(r.reason, 'insufficient_observations_for_comparison');
});

test('period comparison computes delta once both windows have enough observations', () => {
  const recent = ['2026-03-27', '2026-03-26', '2026-03-25'].map(d => log(d, { feel: 8 }));
  const prior = ['2026-03-10', '2026-03-09', '2026-03-08'].map(d => log(d, { feel: 5 }));
  const r = insights.periodComparison([...recent, ...prior], { today: TODAY });
  assert.equal(r.delta, 3);
  assert.equal(r.reason, null);
  assert.equal(r.recent.days_with_entries, 3);
});

test('out-of-range feel values are excluded rather than clamped', () => {
  const r = insights.periodComparison([log(TODAY, { feel: 0 }), log(TODAY, { feel: 11 }), log(TODAY, { feel: 'x' }), log(TODAY, { feel: 7 })], { today: TODAY });
  assert.equal(r.recent.n, 1);
  assert.equal(r.recent.mean, 7);
});

test('feel by phase strips star, excludes check-in label, and orders by hours since dose', () => {
  const logs = [
    log(TODAY, { zone: 'Taper', elapsed_h: 12, feel: 4 }), log(TODAY, { zone: 'Taper', elapsed_h: 11.5, feel: 5 }), log(TODAY, { zone: 'Taper', elapsed_h: 12.2, feel: 4 }),
    log(TODAY, { zone: 'True Peak ⭐', elapsed_h: 7, feel: 8 }), log(TODAY, { zone: 'True Peak ⭐', elapsed_h: 6.5, feel: 9 }), log(TODAY, { zone: 'True Peak ⭐', elapsed_h: 8, feel: 8 }),
    log(TODAY, { zone: 'IR Overcoat', elapsed_h: 0, feel: 6 }),
    log(TODAY, { zone: 'Clinical check-in', elapsed_h: null, feel: 2 })
  ];
  const r = insights.feelByPhase(logs);
  const d = r.drugs[0];
  assert.deepEqual(d.phases.map(p => p.label), ['IR Overcoat', 'True Peak', 'Taper']);
  assert.equal(d.phases[0].median_elapsed_h, 0, 'zero elapsed hours is retained, not treated as missing');
  assert.equal(d.phases[0].limited, true);
  assert.equal(d.lowest_mean_phase, 'Taper');
  assert.equal(d.highest_mean_phase, 'True Peak');
  assert.equal(d.n, 7);
});

test('lowest/highest phase are withheld when phase means tie', () => {
  const logs = [...Array(3)].flatMap(() => [log(TODAY, { zone: 'Taper', elapsed_h: 12, feel: 6 }), log(TODAY, { zone: 'Building', elapsed_h: 2, feel: 6 })]);
  const d = insights.feelByPhase(logs).drugs[0];
  assert.equal(d.lowest_mean_phase, null);
  assert.equal(d.highest_mean_phase, null);
});

test('lowest/highest phase are withheld unless two phases have enough observations', () => {
  const r = insights.feelByPhase([log(TODAY, { zone: 'Taper', feel: 3 }), log(TODAY, { zone: 'Building', feel: 9 })]);
  assert.equal(r.drugs[0].lowest_mean_phase, null);
  assert.equal(r.drugs[0].highest_mean_phase, null);
});

test('tag changes count distinct days, merge side effects, and map unknown tags to Other', () => {
  const logs = [
    log('2026-03-27', { tags: ['irritable'] }), log('2026-03-27', { tags: ['irritable', 'focused'] }),
    log('2026-03-26', { tags: ['Reduced appetite'], side_effects: ['Reduced appetite'] }),
    log('2026-03-10', { tags: ['irritable'] })
  ];
  const r = insights.tagDomainChanges(logs, { today: TODAY });
  const mood = r.domains.find(d => d.domain === 'Mood').tags.find(t => t.tag === 'irritable');
  assert.equal(mood.recent_days, 1);
  assert.equal(mood.prior_days, 1);
  const other = r.domains.find(d => d.domain === 'Side effects & other').tags.find(t => t.tag === 'Reduced appetite');
  assert.equal(other.recent_days, 1);
  assert.equal(r.recent_window.days_with_entries, 2);
});

test('dose segments only appear for medications with more than one logged dose', () => {
  const logs = [
    log('2026-03-01', { dose_mg: 18, feel: 5, ts: '2026-03-01T10:00:00Z' }), log('2026-03-02', { dose_mg: 18, feel: 5, ts: '2026-03-02T10:00:00Z' }),
    log('2026-03-10', { dose_mg: 27, feel: 7, ts: '2026-03-10T10:00:00Z' }),
    log('2026-03-11', { drug: 'ritalin', dose_mg: null, ts: '2026-03-11T10:00:00Z' }),
    log('2026-03-12', { drug: 'lexapro', dose_mg: 10, ts: '2026-03-12T10:00:00Z' })
  ];
  const r = insights.doseSegments(logs);
  assert.equal(r.drugs.length, 1);
  assert.deepEqual(r.drugs[0].segments.map(s => [s.dose_mg, s.first_day, s.last_day, s.entries]), [[18, '2026-03-01', '2026-03-02', 2], [27, '2026-03-10', '2026-03-10', 1]]);
});

test('logging pattern buckets clock times and respects the window', () => {
  const logs = [log(TODAY, { time: '07:30' }), log(TODAY, { time: '13:00' }), log(TODAY, { time: '23:15' }), log(TODAY, { time: '02:00' }), log('2026-01-01', { time: '09:00' })];
  const r = insights.loggingPattern(logs, { today: TODAY, days: 28 });
  assert.equal(r.n, 4);
  assert.deepEqual(r.buckets.map(b => b.count), [1, 1, 0, 2]);
});

test('recent notes are newest first, trimmed, and limited', () => {
  const logs = [log('2026-03-01', { note: 'old', ts: '2026-03-01T10:00:00Z' }), log('2026-03-20', { note: '  newer  ', ts: '2026-03-20T10:00:00Z' }), log('2026-03-21', { note: '', ts: '2026-03-21T10:00:00Z' })];
  const r = insights.recentNotes(logs, { limit: 1 });
  assert.equal(r.n, 1);
  assert.equal(r.notes[0].note, 'newer');
});

function plan(overrides = {}) {
  return { id: 'p1', drug_key: 'concerta', drug_name: 'Concerta', dose_mg: 27, treatment_change_date: '2026-03-20', end_date: '2026-04-02', duration_days: 14, status: 'active', created_at: '2026-03-20T09:00:00Z', ...overrides };
}

test('triage flags follow-up reached, undocumented outcome, and pending acceptance', () => {
  const patient = {
    link: { created_at: '2026-01-01T00:00:00Z' },
    logs: [log(TODAY)],
    plans: [
      plan({ id: 'a', follow_up_date: TODAY, treatment_change_date: '2026-03-27', end_date: '2026-04-09' }),
      plan({ id: 'b', status: 'completed', outcome: null }),
      plan({ id: 'c', status: 'pending', created_at: '2026-03-20T09:00:00Z' })
    ]
  };
  const codes = insights.triageSignals(patient, { today: TODAY, metrics }).signals.map(s => s.code);
  assert.deepEqual(codes, ['follow_up_due', 'outcome_not_documented', 'plan_pending_acceptance']);
});

test('triage flags low check-in completion on an active plan using the metrics engine', () => {
  const patient = { link: {}, logs: [log('2026-03-20', { monitoring_plan_id: 'p1', took_medication: true })], plans: [plan()] };
  const r = insights.triageSignals(patient, { today: TODAY, metrics });
  const signal = r.signals.find(s => s.code === 'low_check_in_completion');
  assert.ok(signal);
  assert.match(signal.detail, /1\/9 eligible days/);
});

test('triage flags no recent entries and no entries since linking', () => {
  const stale = insights.triageSignals({ link: {}, logs: [log('2026-03-01')], plans: [] }, { today: TODAY });
  assert.deepEqual(stale.signals.map(s => s.code), ['no_recent_entries']);
  const silent = insights.triageSignals({ link: { created_at: '2026-03-01T12:00:00Z' }, logs: [], plans: [] }, { today: TODAY });
  assert.deepEqual(silent.signals.map(s => s.code), ['no_entries_since_linking']);
});

test('a recently active patient with documented plans raises no signals', () => {
  const patient = { link: { created_at: '2026-03-01T12:00:00Z' }, logs: [log(TODAY)], plans: [plan({ status: 'completed', outcome: 'Continue current plan' })] };
  assert.equal(insights.triageSignals(patient, { today: TODAY, metrics }).signals.length, 0);
});

test('panel summary counts plans and patients needing review', () => {
  const s = insights.panelSummary([
    { link: {}, logs: [log(TODAY)], plans: [plan({ treatment_change_date: TODAY, end_date: '2026-04-10' })] },
    { link: {}, logs: [log('2026-02-01')], plans: [plan({ status: 'pending', created_at: `${TODAY}T08:00:00Z` })] }
  ], { today: TODAY, metrics });
  assert.equal(s.linked_patients, 2);
  assert.equal(s.active_plans, 1);
  assert.equal(s.pending_plans, 1);
  assert.equal(s.patients_needing_review, 1);
});

test('pre-visit summary is descriptive and carries the support-not-replace disclaimer', () => {
  const logs = [];
  for (let i = 0; i < 28; i++) {
    const day = insights.addDays(TODAY, -i);
    logs.push(log(day, { feel: (i < 14 ? 7 : 5) - (i % 2 ? 1 : 0), zone: i % 2 ? 'Taper' : 'True Peak ⭐', elapsed_h: i % 2 ? 12 : 7, tags: i % 3 ? ['focused'] : ['irritable'], dose_mg: i < 14 ? 27 : 18, ts: `${day}T12:00:00Z`, note: i === 1 ? 'Afternoon dip before meetings' : '' }));
  }
  const patient = { link: {}, logs, medications: [{ drug_key: 'concerta', drug_name: 'Concerta', dose_mg: 27 }], plans: [] };
  const overview = insights.computePatientOverview(patient, { today: TODAY, metrics });
  const text = insights.previsitSummaryText(patient, overview);
  assert.match(text, /support, not replace, clinical judgment/);
  assert.match(text, /18 mg .* → 27 mg/);
  assert.match(text, /lowest mean in Taper/);
  assert.doesNotMatch(text, /expected|coverage gap|recommend|should|diagnos|improv|worsen|deteriorat/i);
});

test('overview excludes overall-day plan check-ins from momentary analyses but keeps their tags and notes', () => {
  const everyday = [1, 2, 3].map(i => log(insights.addDays(TODAY, -i), { zone: 'Taper', elapsed_h: 12, feel: 4, ts: `2026-03-2${i}T19:00:00Z` }));
  const checkIn = log(TODAY, { monitoring_plan_id: 'p1', zone: 'Taper', elapsed_h: 10, feel: 9, tags: ['Dry mouth'], side_effects: ['Dry mouth'], note: 'check-in note', ts: '2026-03-28T18:00:00Z' });
  const overview = insights.computePatientOverview({ link: {}, logs: [...everyday, checkIn], plans: [] }, { today: TODAY });
  const taper = overview.phases.drugs[0].phases.find(p => p.label === 'Taper');
  assert.equal(taper.n, 3);
  assert.equal(taper.mean, 4);
  assert.equal(overview.period.recent.n, 3);
  assert.equal(overview.plan_check_ins, 1);
  assert.ok(overview.tags.domains.some(d => d.tags.some(t => t.tag === 'Dry mouth')));
  assert.equal(overview.notes.notes[0].note, 'check-in note');
});

test('pre-visit summary states an empty window plainly instead of printing a blank mean', () => {
  const logs = [1, 2, 3].map(i => log(insights.addDays(TODAY, -(15 + i)), { feel: 5 }));
  const patient = { link: {}, logs, plans: [] };
  const text = insights.previsitSummaryText(patient, insights.computePatientOverview(patient, { today: TODAY }));
  assert.match(text, /no everyday entries in the last 14 days; prior 14 days mean 5\.0 \(n=3/);
  assert.doesNotMatch(text, /mean — /);
});

test('every top-level insight result carries calculation version, n, and reason', () => {
  const overview = insights.computePatientOverview({ link: {}, logs: [log(TODAY)], plans: [] }, { today: TODAY });
  ['period', 'phases', 'tags', 'doses', 'pattern', 'notes', 'triage'].forEach(key => {
    assert.equal(overview[key].calculation_version, insights.CALCULATION_VERSION, key);
    assert.ok('n' in overview[key], key);
    assert.ok('reason' in overview[key], key);
  });
});
