// Provider-side longitudinal insights built from everyday patient logs.
// Descriptive only: no clinical thresholds, PK comparisons, or recommendations.
// Monitoring-plan metrics stay in clinical-metrics.js and are not modified here.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GrindZoneProviderInsights = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CALCULATION_VERSION = 'provider-insights-v1';
  // Display rule, not a clinical threshold: fewer observations than this are
  // shown but marked limited, and period deltas are withheld.
  const MIN_OBSERVATIONS = 3;

  // Workflow (operational) defaults for the triage queue — not clinical cutoffs.
  const TRIAGE_DEFAULTS = {
    pendingAcceptanceDays: 3,
    lowCompletionMinEligibleDays: 3,
    lowCompletionRate: 0.5,
    noRecentEntriesDays: 14,
    noEntriesSinceLinkDays: 7
  };

  // Mirrors TAG_GROUPS in app.html; keep in sync when patient tags change.
  const TAG_DOMAINS = {
    Mood: ['calm','content','grounded','steady','baseline','motivated','euphoric','moody','irritable','emotional','low','flat','blunted'],
    Mental: ['focused','productive','clear','creative','scattered','overthinking','spacy','foggy','distracted'],
    Energy: ['energized','tired','tense','restless','wired','crashed','headache','dry mouth','suppressed appetite','nauseous'],
    Social: ['talkative','social battery low','withdrawn']
  };
  const TAG_TO_DOMAIN = Object.entries(TAG_DOMAINS).reduce((acc, [domain, tags]) => {
    tags.forEach(tag => { acc[tag] = domain; });
    return acc;
  }, {});

  const DRUG_NAMES = {
    ritalin:'Ritalin LA', concerta:'Concerta', wellbutrin:'Wellbutrin XL', lamictal:'Lamictal',
    remeron:'Remeron', lexapro:'Lexapro',
    'wellbutrin+remeron':'Wellbutrin + Remeron (combination)', 'lamictal+lexapro':'Lamictal + Lexapro (combination)'
  };

  const NON_PHASE_ZONES = new Set(['', '—', 'Clinical check-in']);

  function drugName(key) { return DRUG_NAMES[key] || String(key || 'Unknown'); }

  function validDateKey(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }

  function addDays(key, amount) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d, 12));
    date.setUTCDate(date.getUTCDate() + Number(amount || 0));
    return date.toISOString().slice(0, 10);
  }

  function daysBetween(a, b) {
    const [ay, am, ad] = a.split('-').map(Number), [by, bm, bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 864e5);
  }

  // Same convention as the patient app and provider portal: before 3am belongs
  // to the previous day. Uses runtime-local time because routine logs carry no
  // patient timezone; plan check-ins prefer their captured patient_logical_day.
  function defaultDayOf(ts) {
    const d = ts ? new Date(ts) : null;
    if (!d || Number.isNaN(d.getTime())) return null;
    if (d.getHours() < 3) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function dayOfRow(row, dayOf) {
    if (validDateKey(row.patient_logical_day)) return row.patient_logical_day;
    return (dayOf || defaultDayOf)(row.occurred_at || row.ts);
  }

  function finiteFeel(row) {
    const value = Number(row.feel);
    return Number.isFinite(value) && value >= 1 && value <= 10 ? value : null;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * q, lower = Math.floor(position), upper = Math.ceil(position);
    return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }

  function summarize(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return { mean:null, median:null, min:null, max:null, n:0, limited:false, reason:'no_observations', calculation_version:CALCULATION_VERSION };
    return {
      mean: sorted.reduce((s, v) => s + v, 0) / n,
      median: quantile(sorted, 0.5),
      min: sorted[0], max: sorted[n - 1], n,
      limited: n < MIN_OBSERVATIONS,
      reason: n < MIN_OBSERVATIONS ? 'limited_observations' : null,
      calculation_version: CALCULATION_VERSION
    };
  }

  function inWindow(day, start, end) { return day && day >= start && day <= end; }

  // Recent window vs the immediately preceding window of equal length.
  function periodComparison(logs, options = {}) {
    const today = options.today, length = options.days || 14;
    if (!validDateKey(today)) return { recent:null, prior:null, delta:null, n:0, reason:'invalid_today', calculation_version:CALCULATION_VERSION };
    const recentStart = addDays(today, -(length - 1)), priorEnd = addDays(recentStart, -1), priorStart = addDays(priorEnd, -(length - 1));
    function windowStats(start, end) {
      const rows = logs.filter(row => inWindow(dayOfRow(row, options.dayOf), start, end));
      const feels = rows.map(finiteFeel).filter(v => v !== null);
      const days = new Set(rows.map(row => dayOfRow(row, options.dayOf)));
      return { start, end, ...summarize(feels), days_with_entries: days.size, window_days: length };
    }
    const recent = windowStats(recentStart, today), prior = windowStats(priorStart, priorEnd);
    const comparable = recent.n >= MIN_OBSERVATIONS && prior.n >= MIN_OBSERVATIONS;
    return {
      recent, prior,
      delta: comparable ? recent.mean - prior.mean : null,
      n: recent.n + prior.n,
      reason: comparable ? null : 'insufficient_observations_for_comparison',
      calculation_version: CALCULATION_VERSION
    };
  }

  // Feel grouped by the phase label the app displayed when the patient logged.
  // Ordered by the median hours-since-dose recorded for that label.
  function feelByPhase(logs) {
    const byDrug = {};
    logs.forEach(row => {
      const feel = finiteFeel(row), label = String(row.zone || '').replace(' ⭐', '').trim();
      if (feel === null || NON_PHASE_ZONES.has(label) || !row.drug) return;
      const drug = (byDrug[row.drug] = byDrug[row.drug] || {});
      const phase = (drug[label] = drug[label] || { feels:[], elapsed:[] });
      phase.feels.push(feel);
      const elapsed = Number(row.elapsed_h);
      if (row.elapsed_h !== null && row.elapsed_h !== undefined && Number.isFinite(elapsed)) phase.elapsed.push(elapsed);
    });
    const drugs = Object.entries(byDrug).map(([drug, phases]) => {
      const rows = Object.entries(phases).map(([label, data]) => {
        const elapsedSorted = data.elapsed.slice().sort((a, b) => a - b);
        return { label, median_elapsed_h: quantile(elapsedSorted, 0.5), ...summarize(data.feels) };
      }).sort((a, b) => {
        if (a.median_elapsed_h === null && b.median_elapsed_h === null) return a.label.localeCompare(b.label);
        if (a.median_elapsed_h === null) return 1;
        if (b.median_elapsed_h === null) return -1;
        return a.median_elapsed_h - b.median_elapsed_h;
      });
      const total = rows.reduce((s, r) => s + r.n, 0);
      const comparable = rows.filter(r => !r.limited);
      let lowest = comparable.length >= 2 ? comparable.reduce((a, b) => (b.mean < a.mean ? b : a)) : null;
      let highest = comparable.length >= 2 ? comparable.reduce((a, b) => (b.mean > a.mean ? b : a)) : null;
      if (lowest && highest && lowest.mean === highest.mean) lowest = highest = null;
      return { drug, drug_name: drugName(drug), phases: rows, lowest_mean_phase: lowest && lowest.label, highest_mean_phase: highest && highest.label, n: total, reason: total ? null : 'no_phase_observations', calculation_version: CALCULATION_VERSION };
    }).sort((a, b) => b.n - a.n);
    const n = drugs.reduce((s, d) => s + d.n, 0);
    return { drugs, n, reason: n ? null : 'no_phase_observations', calculation_version: CALCULATION_VERSION };
  }

  // Distinct-day tag reporting in the recent vs prior window, grouped by domain.
  function tagDomainChanges(logs, options = {}) {
    const today = options.today, length = options.days || 14;
    if (!validDateKey(today)) return { domains:[], n:0, reason:'invalid_today', calculation_version:CALCULATION_VERSION };
    const recentStart = addDays(today, -(length - 1)), priorEnd = addDays(recentStart, -1), priorStart = addDays(priorEnd, -(length - 1));
    const recentDays = {}, priorDays = {};
    const recentEntryDays = new Set(), priorEntryDays = new Set();
    logs.forEach(row => {
      const day = dayOfRow(row, options.dayOf);
      const bucket = inWindow(day, recentStart, today) ? recentDays : inWindow(day, priorStart, priorEnd) ? priorDays : null;
      if (!bucket) return;
      (bucket === recentDays ? recentEntryDays : priorEntryDays).add(day);
      const tags = new Set([...(row.tags || []), ...(row.side_effects || [])].map(t => String(t).trim()).filter(Boolean));
      tags.forEach(tag => { (bucket[tag] = bucket[tag] || new Set()).add(day); });
    });
    const allTags = new Set([...Object.keys(recentDays), ...Object.keys(priorDays)]);
    const grouped = {};
    allTags.forEach(tag => {
      const domain = TAG_TO_DOMAIN[tag.toLowerCase()] || 'Side effects & other';
      (grouped[domain] = grouped[domain] || []).push({
        tag,
        recent_days: recentDays[tag] ? recentDays[tag].size : 0,
        prior_days: priorDays[tag] ? priorDays[tag].size : 0
      });
    });
    const order = ['Mood', 'Mental', 'Energy', 'Social', 'Side effects & other'];
    const domains = order.filter(d => grouped[d]).map(domain => ({
      domain,
      tags: grouped[domain].sort((a, b) => (b.recent_days + b.prior_days) - (a.recent_days + a.prior_days) || a.tag.localeCompare(b.tag))
    }));
    return {
      domains,
      recent_window: { start: recentStart, end: today, days_with_entries: recentEntryDays.size },
      prior_window: { start: priorStart, end: priorEnd, days_with_entries: priorEntryDays.size },
      n: recentEntryDays.size + priorEntryDays.size,
      reason: allTags.size ? null : 'no_tags_reported',
      calculation_version: CALCULATION_VERSION
    };
  }

  // Consecutive runs of the patient-selected dose per medication, as logged.
  function doseSegments(logs, options = {}) {
    const byDrug = {};
    logs.forEach(row => {
      const dose = row.dose_mg === null || row.dose_mg === undefined || row.dose_mg === '' ? null : Number(row.dose_mg);
      if (!row.drug || dose === null || !Number.isFinite(dose)) return;
      (byDrug[row.drug] = byDrug[row.drug] || []).push({ day: dayOfRow(row, options.dayOf), ts: String(row.occurred_at || row.ts || ''), dose, feel: finiteFeel(row) });
    });
    const drugs = [];
    Object.entries(byDrug).forEach(([drug, rows]) => {
      rows.sort((a, b) => a.ts.localeCompare(b.ts));
      const segments = [];
      rows.forEach(row => {
        const last = segments[segments.length - 1];
        if (last && last.dose_mg === row.dose) { last.last_day = row.day; last.rows.push(row); }
        else segments.push({ dose_mg: row.dose, first_day: row.day, last_day: row.day, rows: [row] });
      });
      if (new Set(segments.map(s => s.dose_mg)).size < 2) return;
      drugs.push({
        drug, drug_name: drugName(drug),
        segments: segments.map(s => ({ dose_mg: s.dose_mg, first_day: s.first_day, last_day: s.last_day, entries: s.rows.length, feel: summarize(s.rows.map(r => r.feel).filter(v => v !== null)) })),
        n: rows.length, reason: null, calculation_version: CALCULATION_VERSION
      });
    });
    return { drugs, n: drugs.reduce((s, d) => s + d.n, 0), reason: drugs.length ? null : 'no_dose_changes_in_logs', calculation_version: CALCULATION_VERSION };
  }

  function loggingPattern(logs, options = {}) {
    const today = options.today, length = options.days || 28;
    const start = validDateKey(today) ? addDays(today, -(length - 1)) : null;
    const buckets = { 'Morning (5am–12pm)':0, 'Afternoon (12–5pm)':0, 'Evening (5–10pm)':0, 'Night (10pm–5am)':0 };
    let n = 0;
    logs.forEach(row => {
      if (start && !inWindow(dayOfRow(row, options.dayOf), start, today)) return;
      const [h] = String(row.time || '').split(':').map(Number);
      if (!Number.isFinite(h)) return;
      n++;
      if (h >= 5 && h < 12) buckets['Morning (5am–12pm)']++;
      else if (h >= 12 && h < 17) buckets['Afternoon (12–5pm)']++;
      else if (h >= 17 && h < 22) buckets['Evening (5–10pm)']++;
      else buckets['Night (10pm–5am)']++;
    });
    return { buckets: Object.entries(buckets).map(([label, count]) => ({ label, count })), n, window_days: length, reason: n ? null : 'no_entries_in_window', calculation_version: CALCULATION_VERSION };
  }

  function recentNotes(logs, options = {}) {
    const limit = options.limit || 5;
    const notes = logs.filter(row => String(row.note || '').trim())
      .slice().sort((a, b) => String(b.occurred_at || b.ts || '').localeCompare(String(a.occurred_at || a.ts || '')))
      .slice(0, limit)
      .map(row => ({ day: dayOfRow(row, options.dayOf), time: row.time || null, drug: row.drug || null, drug_name: drugName(row.drug), phase: String(row.zone || '').replace(' ⭐', '') || null, feel: finiteFeel(row), note: String(row.note).trim(), monitoring_plan_id: row.monitoring_plan_id || null }));
    return { notes, n: notes.length, reason: notes.length ? null : 'no_notes', calculation_version: CALCULATION_VERSION };
  }

  function lastEntryDay(logs, dayOf) {
    return logs.map(row => dayOfRow(row, dayOf)).filter(validDateKey).sort().pop() || null;
  }

  // Workflow signals for the provider's review queue. Each one names its rule.
  function triageSignals(patient, options = {}) {
    const today = options.today, cfg = { ...TRIAGE_DEFAULTS, ...(options.config || {}) }, metrics = options.metrics;
    const signals = [];
    if (!validDateKey(today)) return { signals, n: 0, reason: 'invalid_today', calculation_version: CALCULATION_VERSION };
    const logs = patient.logs || [], plans = patient.plans || [];
    plans.forEach(plan => {
      const name = `${plan.drug_name || drugName(plan.drug_key)}${plan.dose_mg != null ? ' ' + plan.dose_mg + ' mg' : ''}`;
      if (plan.status === 'active' && validDateKey(plan.follow_up_date) && plan.follow_up_date <= today) {
        signals.push({ code:'follow_up_due', priority:1, label:'Follow-up date reached', detail:`${name} plan follow-up ${plan.follow_up_date}`, plan_id: plan.id });
      }
      if ((plan.status === 'completed' || plan.status === 'closed') && !plan.outcome) {
        signals.push({ code:'outcome_not_documented', priority:2, label:'Plan outcome not documented', detail:`${name} plan ${plan.status}; no outcome recorded`, plan_id: plan.id });
      }
      if (plan.status === 'active' && metrics && typeof metrics.computeVisitBrief === 'function') {
        const brief = metrics.computeVisitBrief({ plan, logs, patientToday: today, patientTimezone: plan.patient_timezone || null });
        const eligible = brief.check_in_status.eligible_plan_days.value, recorded = brief.check_in_status.check_in_recorded.value;
        if (eligible >= cfg.lowCompletionMinEligibleDays && recorded / eligible < cfg.lowCompletionRate) {
          signals.push({ code:'low_check_in_completion', priority:3, label:'Low plan check-in completion', detail:`${name}: ${recorded}/${eligible} eligible days with a check-in`, plan_id: plan.id });
        }
      }
      if (plan.status === 'pending' && plan.created_at) {
        const created = defaultDayOf(plan.created_at);
        const waited = created ? daysBetween(created, today) : 0;
        if (waited >= cfg.pendingAcceptanceDays) {
          signals.push({ code:'plan_pending_acceptance', priority:4, label:'Plan not yet accepted', detail:`${name} plan sent ${waited} days ago`, plan_id: plan.id });
        }
      }
    });
    const last = lastEntryDay(logs, options.dayOf);
    if (last) {
      const gap = daysBetween(last, today);
      if (gap >= cfg.noRecentEntriesDays) signals.push({ code:'no_recent_entries', priority:5, label:'No recent entries', detail:`Last entry ${last} (${gap} days ago)` });
    } else if (patient.link && patient.link.created_at) {
      const linked = defaultDayOf(patient.link.created_at);
      const since = linked ? daysBetween(linked, today) : 0;
      if (since >= cfg.noEntriesSinceLinkDays) signals.push({ code:'no_entries_since_linking', priority:5, label:'No entries since linking', detail:`Linked ${since} days ago; no entries synced` });
    }
    signals.sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
    return { signals, last_entry_day: last, n: signals.length, reason: null, calculation_version: CALCULATION_VERSION };
  }

  function panelSummary(patients, options = {}) {
    const summary = { linked_patients:0, active_plans:0, pending_plans:0, patients_needing_review:0, signals_by_code:{} };
    patients.forEach(patient => {
      summary.linked_patients++;
      (patient.plans || []).forEach(plan => {
        if (plan.status === 'active') summary.active_plans++;
        if (plan.status === 'pending') summary.pending_plans++;
      });
      const triage = triageSignals(patient, options);
      if (triage.signals.length) summary.patients_needing_review++;
      triage.signals.forEach(s => { summary.signals_by_code[s.code] = (summary.signals_by_code[s.code] || 0) + 1; });
    });
    return { ...summary, n: summary.linked_patients, reason: summary.linked_patients ? null : 'no_linked_patients', calculation_version: CALCULATION_VERSION };
  }

  // Monitoring-plan check-ins ask for an overall-day feel score, whereas everyday
  // entries rate the moment. Momentary analyses use everyday entries only.
  function everydayLogs(logs) {
    return (logs || []).filter(row => !row.monitoring_plan_id);
  }

  function computePatientOverview(patient, options = {}) {
    const logs = patient.logs || [];
    const everyday = everydayLogs(logs);
    return {
      period: periodComparison(everyday, options),
      phases: feelByPhase(everyday.filter(row => {
        const day = dayOfRow(row, options.dayOf);
        return !validDateKey(options.today) || !day || day >= addDays(options.today, -((options.phaseDays || 60) - 1));
      })),
      phase_window_days: options.phaseDays || 60,
      tags: tagDomainChanges(logs, options),
      doses: doseSegments(everyday, options),
      pattern: loggingPattern(everyday, options),
      notes: recentNotes(logs, options),
      triage: triageSignals(patient, options),
      everyday_entries: everyday.length,
      plan_check_ins: logs.length - everyday.length,
      n: logs.length,
      reason: logs.length ? null : 'no_logs',
      calculation_version: CALCULATION_VERSION
    };
  }

  function fmt1(value) { return value === null || value === undefined ? '—' : Number(value).toFixed(1); }

  // Plain-text pre-visit summary for EHR paste. Descriptive language only.
  function previsitSummaryText(patient, overview, options = {}) {
    const lines = [];
    const p = overview.period;
    lines.push('Grind-Zone pre-visit overview — patient-reported data (descriptive)');
    if (p.recent && p.prior) lines.push(`Window: ${p.prior.start} to ${p.recent.end}.`);
    const meds = (patient.medications || []).map(m => `${m.drug_name || drugName(m.drug_key)}${m.dose_mg != null ? ' ' + m.dose_mg + ' mg' : ' (dose not set)'}`);
    lines.push(`Medications (patient-entered in app): ${meds.length ? meds.join('; ') : 'none synced'}.`);
    if (p.recent && p.prior) {
      const windowText = (w, name) => w.n
        ? `${name} mean ${fmt1(w.mean)} (n=${w.n}, ${w.days_with_entries} days with entries)`
        : `no everyday entries in the ${name}`;
      lines.push(`Self-reported feel on everyday entries (1–10, not a validated scale): ${windowText(p.recent, 'last 14 days')}; ${windowText(p.prior, 'prior 14 days')}${p.delta === null ? (p.recent.n && p.prior.n ? '; too few entries to compare' : '') : `; difference ${p.delta >= 0 ? '+' : ''}${p.delta.toFixed(1)}`}.`);
    }
    overview.phases.drugs.forEach(d => {
      if (d.lowest_mean_phase && d.highest_mean_phase) {
        const low = d.phases.find(x => x.label === d.lowest_mean_phase), high = d.phases.find(x => x.label === d.highest_mean_phase);
        lines.push(`${d.drug_name}, by app-displayed phase (last ${overview.phase_window_days} days): highest mean in ${high.label} ${fmt1(high.mean)} (n=${high.n}); lowest mean in ${low.label} ${fmt1(low.mean)} (n=${low.n}).`);
      }
    });
    const tagLines = [];
    overview.tags.domains.forEach(domain => domain.tags.forEach(t => {
      if (t.recent_days || t.prior_days) tagLines.push({ ...t, domain: domain.domain, total: t.recent_days + t.prior_days });
    }));
    tagLines.sort((a, b) => b.total - a.total);
    if (tagLines.length) {
      lines.push(`Most-reported tags (distinct days, last 14 vs prior 14): ${tagLines.slice(0, 6).map(t => `${t.tag} ${t.recent_days} vs ${t.prior_days}`).join('; ')}.`);
    }
    overview.doses.drugs.forEach(d => {
      lines.push(`${d.drug_name} doses recorded in logs: ${d.segments.map(s => `${s.dose_mg} mg ${s.first_day}–${s.last_day} (${s.entries} entries, mean feel ${fmt1(s.feel.mean)})`).join(' → ')}.`);
    });
    (patient.plans || []).forEach(plan => {
      lines.push(`Monitoring plan: ${plan.drug_name || drugName(plan.drug_key)}${plan.dose_mg != null ? ' ' + plan.dose_mg + ' mg' : ''}, ${plan.treatment_change_date || '—'} to ${plan.end_date || 'open'}, status ${plan.status}${plan.outcome ? `, outcome: ${plan.outcome}` : ''}.`);
    });
    if (options.includeNotes !== false && overview.notes.notes.length) {
      lines.push(`Recent patient notes: ${overview.notes.notes.slice(0, 3).map(n => `${n.day}: "${n.note.length > 160 ? n.note.slice(0, 157) + '…' : n.note}"`).join(' ')}`);
    }
    const pattern = overview.pattern.buckets.filter(b => b.count).map(b => `${b.label.split(' ')[0].toLowerCase()} ${b.count}`).join(', ');
    if (pattern) lines.push(`Entries are patient-initiated; time of day (last ${overview.pattern.window_days} days): ${pattern}.`);
    lines.push('Derived from patient-reported observations; intended to support, not replace, clinical judgment.');
    return lines.join('\n');
  }

  return {
    CALCULATION_VERSION, MIN_OBSERVATIONS, TRIAGE_DEFAULTS, TAG_DOMAINS,
    drugName, addDays, defaultDayOf, everydayLogs,
    periodComparison, feelByPhase, tagDomainChanges, doseSegments, loggingPattern, recentNotes,
    triageSignals, panelSummary, computePatientOverview, previsitSummaryText
  };
});
