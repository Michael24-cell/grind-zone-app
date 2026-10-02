(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GrindZoneClinicalMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CALCULATION_VERSION = 'clinical-observations-v1';
  const RETROSPECTIVE_MINUTES = 15;

  function result(value, n, reason) {
    return { value, n, reason: reason || null, calculation_version: CALCULATION_VERSION };
  }

  function validDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function dateFromKey(key) {
    if (!validDateKey(key)) return null;
    const [year, month, day] = key.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12));
  }

  function dateKey(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function addDays(key, amount) {
    const date = dateFromKey(key);
    if (!date) return null;
    date.setUTCDate(date.getUTCDate() + Number(amount || 0));
    return dateKey(date);
  }

  function dateRange(start, end) {
    if (!validDateKey(start) || !validDateKey(end) || start > end) return [];
    const out = [];
    for (let day = start; day <= end; day = addDays(day, 1)) out.push(day);
    return out;
  }

  function minDateKey(values) {
    const valid = values.filter(validDateKey).sort();
    return valid.length ? valid[0] : null;
  }

  function zonedDateKey(value, timezone) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return null;
    if (timezone) {
      try {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(date).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
        return `${parts.year}-${parts.month}-${parts.day}`;
      } catch (_) {}
    }
    return date.toISOString().slice(0, 10);
  }

  function localTime(value, timezone) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return null;
    if (timezone) {
      try {
        return new Intl.DateTimeFormat('en-US', {
          timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false
        }).format(date).replace(/^24:/, '00:');
      } catch (_) {}
    }
    return date.toISOString().slice(11, 16);
  }

  function parseInstant(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function hoursBetween(start, end) {
    const a = parseInstant(start), b = parseInstant(end);
    return a && b ? (b.getTime() - a.getTime()) / 36e5 : null;
  }

  function unique(values) {
    return [...new Set(values.filter(value => value !== undefined && value !== null && value !== ''))];
  }

  function canonical(rows, fields, conflictField, conflicts) {
    const values = unique(rows.flatMap(row => fields.map(field => row[field])));
    if (values.length > 1) {
      conflicts.push({ field: conflictField, values });
      return null;
    }
    return values.length ? values[0] : null;
  }

  function canonicalBoolean(rows, field, conflictField, conflicts) {
    const values = unique(rows.map(row => row[field]).filter(value => typeof value === 'boolean'));
    if (values.length > 1) {
      conflicts.push({ field: conflictField, values });
      return null;
    }
    return values.length ? values[0] : null;
  }

  function canonicalContext(rows, field, conflicts) {
    return canonical(rows, [field], field, conflicts);
  }

  function pausedOn(plan, day) {
    if ((plan.paused_dates || []).includes(day)) return true;
    return (plan.paused_ranges || []).some(range => range && validDateKey(range.start) && validDateKey(range.end) && day >= range.start && day <= range.end);
  }

  function dominantTimezone(logs) {
    const counts = {};
    logs.forEach(row => {
      if (row.patient_timezone) counts[row.patient_timezone] = (counts[row.patient_timezone] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
  }

  function normalizePlanDays(input) {
    const plan = input?.plan || {};
    const allLogs = Array.isArray(input?.logs) ? input.logs : [];
    const logs = allLogs.filter(row => row.monitoring_plan_id === plan.id);
    const start = plan.treatment_change_date;
    const plannedEnd = plan.end_date || (validDateKey(start) ? addDays(start, Number(plan.duration_days || 1) - 1) : null);
    const timezone = input.patientTimezone || plan.patient_timezone || dominantTimezone(logs);
    const patientToday = input.patientToday || zonedDateKey(input.now || new Date(), timezone);
    const closedDate = plan.closed_date || zonedDateKey(plan.ended_at, timezone);
    const eligibleEnd = minDateKey([patientToday, plannedEnd, closedDate].filter(Boolean));
    const groups = {};
    const legacyRows = [];
    const outOfPlanRows = [];

    logs.forEach(row => {
      if (!validDateKey(row.patient_logical_day)) {
        legacyRows.push({ ...row, legacy_reason: 'missing_patient_logical_day' });
        return;
      }
      if (validDateKey(start) && row.patient_logical_day < start || validDateKey(plannedEnd) && row.patient_logical_day > plannedEnd) {
        outOfPlanRows.push(row);
      }
      (groups[row.patient_logical_day] = groups[row.patient_logical_day] || []).push(row);
    });

    const planDays = dateRange(start, plannedEnd).map(day => {
      let eligibility = 'eligible';
      if (day < start) eligibility = 'before_plan';
      else if (day > patientToday) eligibility = 'future';
      else if (closedDate && day > closedDate) eligibility = 'after_close';
      else if (pausedOn(plan, day)) eligibility = 'paused';
      const rows = groups[day] || [];
      const conflicts = [];
      const invalidObservations = [];
      const medication = canonicalBoolean(rows, 'took_medication', 'medication_status', conflicts);
      const medicationStatus = medication === true ? 'taken' : medication === false ? 'not_taken' : rows.length ? 'uncertain' : null;
      const doseOccurredAt = canonical(rows, ['dose_occurred_at'], 'dose_time', conflicts);
      const onsetOccurredAt = canonical(rows, ['onset_occurred_at'], 'onset_time', conflicts);
      const wearoffOccurredAt = canonical(rows, ['wearoff_occurred_at'], 'wearoff_time', conflicts);
      const sideEffectsAnswered = canonicalBoolean(rows, 'clinical_side_effects_answered', 'side_effects_answered', conflicts);
      const sleepContext = canonicalContext(rows, 'sleep_context', conflicts);
      const mealContext = canonicalContext(rows, 'meal_context', conflicts);
      const rowTimezone = canonical(rows, ['patient_timezone'], 'patient_timezone', conflicts) || timezone;
      const rowOffset = canonical(rows, ['utc_offset_minutes'], 'utc_offset_minutes', conflicts);

      const doseAnchor = doseOccurredAt && parseInstant(doseOccurredAt) ? {
        occurredAt: doseOccurredAt,
        localTime: localTime(doseOccurredAt, rowTimezone),
        timezone: rowTimezone,
        utcOffsetMinutes: rowOffset == null ? null : Number(rowOffset)
      } : null;
      if (rows.length && !doseAnchor && rows.some(row => row.dose_time)) invalidObservations.push({ type: 'legacy_clock_only_dose' });

      function timingObservation(kind, occurredAt) {
        if (!occurredAt) return null;
        if (!parseInstant(occurredAt)) {
          invalidObservations.push({ type: `invalid_${kind}_timestamp`, occurredAt });
          return null;
        }
        if (!doseAnchor) {
          invalidObservations.push({ type: `${kind}_without_full_dose_timestamp`, occurredAt });
          return null;
        }
        const elapsed = hoursBetween(doseAnchor.occurredAt, occurredAt);
        if (elapsed < 0) {
          invalidObservations.push({ type: `${kind}_before_dose`, occurredAt });
          return null;
        }
        return { occurredAt, localTime: localTime(occurredAt, rowTimezone), hoursSinceDose: elapsed };
      }

      const onsetObservation = timingObservation('onset', onsetOccurredAt);
      const wearoffObservation = timingObservation('wearoff', wearoffOccurredAt);
      const feelObservations = rows.map((row, index) => {
        const score = Number(row.feel);
        if (!Number.isFinite(score)) return null;
        const occurred = parseInstant(row.occurred_at);
        const submitted = parseInstant(row.submitted_at);
        const elapsed = doseAnchor && occurred ? hoursBetween(doseAnchor.occurredAt, occurred.toISOString()) : null;
        const valid = !!occurred && elapsed !== null && elapsed >= 0;
        if (!occurred) invalidObservations.push({ type: 'feel_missing_occurred_at', rowId: row.id ?? index });
        else if (doseAnchor && elapsed < 0) invalidObservations.push({ type: 'feel_before_dose', rowId: row.id ?? index });
        const lagMinutes = occurred && submitted ? (submitted.getTime() - occurred.getTime()) / 6e4 : null;
        return {
          score,
          occurredAt: occurred ? occurred.toISOString() : null,
          submittedAt: submitted ? submitted.toISOString() : null,
          localTime: occurred ? localTime(occurred, row.patient_timezone || rowTimezone) : null,
          utcOffsetMinutes: row.utc_offset_minutes == null ? null : Number(row.utc_offset_minutes),
          hoursSinceDose: valid ? elapsed : null,
          retrospective: lagMinutes == null ? null : lagMinutes >= RETROSPECTIVE_MINUTES,
          submissionLagMinutes: lagMinutes,
          valid,
          sourceRowId: row.id ?? null
        };
      }).filter(Boolean);

      const scores = feelObservations.map(observation => observation.score);
      const sideEffects = unique(rows.flatMap(row => Array.isArray(row.side_effects) ? row.side_effects : []));
      const checkInRecorded = rows.length > 0;
      let completeness = 'no_check_in';
      if (checkInRecorded) {
        completeness = conflicts.length ? 'conflicting' : (
          medicationStatus !== 'uncertain' && feelObservations.length && sideEffectsAnswered !== null && invalidObservations.length === 0 ? 'complete' : 'partial'
        );
      }
      return {
        monitoringPlanId: plan.id,
        patientLogicalDay: day,
        key: `${plan.id}:${day}`,
        eligibility,
        checkInRecorded,
        medicationStatus,
        doseAnchor,
        onsetObservation,
        wearoffObservation,
        feelObservations,
        dailyFeelSummary: summarize(scores),
        sideEffectsAnswered,
        sideEffects,
        sleepContext,
        mealContext,
        conflicts,
        invalidObservations,
        completeness,
        sourceRows: rows
      };
    });

    return {
      planDays,
      legacyRows,
      outOfPlanRows,
      patientTimezone: timezone,
      patientToday,
      closedDate,
      eligibleEnd,
      timingSemanticsReason:timezone ? null : 'patient_timezone_unavailable',
      inclusiveDates: true,
      n: planDays.length,
      reason: validDateKey(start) && validDateKey(plannedEnd) ? null : 'invalid_plan_dates',
      calculation_version: CALCULATION_VERSION
    };
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position), upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }

  function summarize(values) {
    const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return { mean:null, median:null, sd:null, iqr:null, min:null, max:null, n:0, reason:'no_valid_observations', calculation_version:CALCULATION_VERSION };
    const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
    const variance = n > 1 ? sorted.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (n - 1) : null;
    const q1 = quantile(sorted, .25), q3 = quantile(sorted, .75);
    return {
      mean, median:quantile(sorted,.5), sd:variance == null ? null : Math.sqrt(variance), iqr:q3-q1,
      min:sorted[0], max:sorted[n-1], n, reason:n < 2 ? 'single_observation' : null,
      calculation_version:CALCULATION_VERSION
    };
  }

  function eligibleDays(planDays) {
    return (planDays || []).filter(day => day.eligibility === 'eligible');
  }

  function checkInMedicationStatus(planDays) {
    const days = eligibleDays(planDays);
    const recorded = days.filter(day => day.checkInRecorded);
    const taken = recorded.filter(day => day.medicationStatus === 'taken').length;
    const notTaken = recorded.filter(day => day.medicationStatus === 'not_taken').length;
    const uncertain = recorded.length - taken - notTaken;
    return {
      eligible_plan_days: result(days.length, days.length, days.length ? null : 'no_eligible_plan_days'),
      check_in_recorded: {
        ...result(recorded.length, days.length, days.length ? null : 'no_eligible_plan_days'),
        medication_taken: result(taken, recorded.length, recorded.length ? null : 'no_check_ins_recorded'),
        medication_not_taken: result(notTaken, recorded.length, recorded.length ? null : 'no_check_ins_recorded'),
        medication_status_uncertain: result(uncertain, recorded.length, recorded.length ? null : 'no_check_ins_recorded')
      },
      no_check_in_recorded: result(days.length - recorded.length, days.length, days.length ? null : 'no_eligible_plan_days'),
      n: days.length,
      reason: days.length ? null : 'no_eligible_plan_days',
      calculation_version: CALCULATION_VERSION
    };
  }

  function sideEffectDays(planDays) {
    const days = eligibleDays(planDays);
    const denominatorDays = days.filter(day => day.medicationStatus === 'taken' && day.sideEffectsAnswered === true);
    const unansweredDays = days.filter(day => day.medicationStatus === 'taken' && day.sideEffectsAnswered !== true).length;
    const counts = {};
    denominatorDays.forEach(day => unique(day.sideEffects || []).forEach(effect => counts[effect] = (counts[effect] || 0) + 1));
    const effects = Object.entries(counts).map(([effect, count]) => ({
      effect,
      distinct_day_count: count,
      denominator_days: denominatorDays.length,
      rate: denominatorDays.length ? Math.min(1, count / denominatorDays.length) : null,
      unanswered_side_effect_question_days: unansweredDays,
      n: denominatorDays.length,
      reason: denominatorDays.length ? null : 'insufficient_answered_side_effect_data',
      calculation_version: CALCULATION_VERSION
    })).sort((a, b) => b.distinct_day_count - a.distinct_day_count || a.effect.localeCompare(b.effect));
    return {
      effects,
      denominator_days: result(denominatorDays.length, days.length, denominatorDays.length ? null : 'insufficient_answered_side_effect_data'),
      unanswered_side_effect_question_days: result(unansweredDays, days.filter(day => day.medicationStatus === 'taken').length, null),
      n: denominatorDays.length,
      reason: denominatorDays.length ? null : 'insufficient_answered_side_effect_data',
      calculation_version: CALCULATION_VERSION
    };
  }

  function availability(days, predicate) {
    const count = days.filter(predicate).length;
    return { count, percentage:days.length ? count / days.length : null, n:days.length, reason:days.length ? null : 'no_eligible_plan_days', calculation_version:CALCULATION_VERSION };
  }

  function dataQuality(planDays, legacyRows) {
    const days = eligibleDays(planDays);
    const states = { complete:0, partial:0, no_check_in:0, conflicting:0 };
    days.forEach(day => states[day.completeness]++);
    const observations = days.flatMap(day => day.feelObservations || []);
    const invalidCount = days.reduce((sum, day) => sum + day.invalidObservations.length, 0);
    return {
      day_states: states,
      check_in_completion: availability(days, day => day.checkInRecorded),
      medication_status_availability: availability(days, day => ['taken','not_taken'].includes(day.medicationStatus)),
      dose_time_availability: availability(days, day => !!day.doseAnchor),
      feel_observation_availability: availability(days, day => day.feelObservations.length > 0),
      onset_availability: availability(days, day => !!day.onsetObservation),
      wearoff_availability: availability(days, day => !!day.wearoffObservation),
      side_effect_answeredness: availability(days, day => day.sideEffectsAnswered === true),
      contextual_field_availability: availability(days, day => day.sleepContext != null || day.mealContext != null),
      retrospective_entries: result(observations.filter(item => item.retrospective === true).length, observations.filter(item => item.retrospective !== null).length, observations.some(item => item.retrospective !== null) ? null : 'missing_event_or_submission_timestamp'),
      invalid_observations: result(invalidCount, observations.length, invalidCount ? 'invalid_observations_present' : null),
      conflicting_days: result(days.filter(day => day.conflicts.length).length, days.length, null),
      legacy_rows: result((legacyRows || []).length, (legacyRows || []).length, (legacyRows || []).length ? 'legacy_timing_semantics_incomplete' : null),
      n: days.length,
      reason: days.length ? null : 'no_eligible_plan_days',
      calculation_version: CALCULATION_VERSION
    };
  }

  function timingDescriptors(planDays) {
    const days = eligibleDays(planDays);
    const onset = days.map(day => day.onsetObservation?.hoursSinceDose).filter(Number.isFinite);
    const coverage = days.map(day => day.wearoffObservation?.hoursSinceDose).filter(Number.isFinite);
    return { onset:summarize(onset), coverage:summarize(coverage), n:onset.length+coverage.length, reason:onset.length||coverage.length?null:'no_valid_timing_observations', calculation_version:CALCULATION_VERSION };
  }

  function feelByHour(planDays) {
    const observations = eligibleDays(planDays).flatMap(day => day.feelObservations || []).filter(item => item.valid && Number.isFinite(item.hoursSinceDose));
    if (!observations.length) return { buckets:[], n:0, reason:'no_valid_feel_timing_observations', calculation_version:CALCULATION_VERSION };
    const grouped = {};
    observations.forEach(item => {
      const bucket = Math.floor(item.hoursSinceDose);
      (grouped[bucket] = grouped[bucket] || []).push(item.score);
    });
    const keys = Object.keys(grouped).map(Number).sort((a,b)=>a-b);
    const buckets = [];
    for (let hour=keys[0]; hour<=keys[keys.length-1]; hour++) {
      const summary = summarize(grouped[hour] || []);
      buckets.push({ hour_start:hour, hour_end:hour+1, limited:summary.n>0&&summary.n<2, ...summary });
    }
    return { buckets, n:observations.length, reason:null, calculation_version:CALCULATION_VERSION };
  }

  function dayLevelObservations(planDays) {
    const days = eligibleDays(planDays).map(day => ({
      patient_logical_day:day.patientLogicalDay,
      ...day.dailyFeelSummary,
      medication_status:day.medicationStatus,
      data_quality_state:day.completeness,
      check_in_recorded:day.checkInRecorded,
      calculation_version:CALCULATION_VERSION
    }));
    return { days, n:days.filter(day => day.n > 0).length, reason:days.some(day=>day.n>0)?null:'no_feel_observations', calculation_version:CALCULATION_VERSION };
  }

  function computeVisitBrief(input) {
    const normalized = normalizePlanDays(input);
    const planDays = normalized.planDays;
    return {
      normalized,
      check_in_status:checkInMedicationStatus(planDays),
      side_effect_days:sideEffectDays(planDays),
      data_quality:dataQuality(planDays, normalized.legacyRows),
      timing:timingDescriptors(planDays),
      feel_by_hour:feelByHour(planDays),
      day_level_observations:dayLevelObservations(planDays),
      n:planDays.filter(day => day.eligibility === 'eligible').length,
      reason:planDays.some(day => day.eligibility === 'eligible') ? null : 'no_eligible_plan_days',
      calculation_version:CALCULATION_VERSION
    };
  }

  return {
    CALCULATION_VERSION,
    RETROSPECTIVE_MINUTES,
    addDays,
    dateRange,
    zonedDateKey,
    hoursBetween,
    summarize,
    normalizePlanDays,
    checkInMedicationStatus,
    sideEffectDays,
    dataQuality,
    timingDescriptors,
    feelByHour,
    dayLevelObservations,
    computeVisitBrief
  };
});
