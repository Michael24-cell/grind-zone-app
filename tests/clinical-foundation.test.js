const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const metrics = require('../clinical-metrics.js');

const plan = (overrides={}) => ({
  id:'plan-a', treatment_change_date:'2026-03-01', end_date:'2026-03-05', duration_days:5, status:'active', ...overrides
});

function row(day='2026-03-01', overrides={}) {
  return {
    id:`row-${day}`, monitoring_plan_id:'plan-a', patient_logical_day:day,
    took_medication:true, feel:7, side_effects:[], clinical_side_effects_answered:true,
    patient_timezone:'America/Los_Angeles', utc_offset_minutes:-480,
    dose_time:'08:00', noticed_working_at:'09:00', benefit_faded_at:'15:00',
    dose_occurred_at:`${day}T08:00:00-08:00`, onset_occurred_at:`${day}T09:00:00-08:00`, wearoff_occurred_at:`${day}T15:00:00-08:00`,
    occurred_at:`${day}T10:00:00-08:00`, submitted_at:`${day}T10:02:00-08:00`, ts:`${day}T10:00:00-08:00`,
    ...overrides
  };
}

function compute(logs=[], planOverrides={}, patientToday='2026-03-05') {
  return metrics.computeVisitBrief({plan:plan(planOverrides),logs,patientToday,patientTimezone:'America/Los_Angeles'});
}

test('empty plan has five eligible no-check-in days and no missed-dose category', () => {
  const value=compute([]);
  assert.equal(value.check_in_status.eligible_plan_days.value,5);
  assert.equal(value.check_in_status.check_in_recorded.value,0);
  assert.equal(value.check_in_status.no_check_in_recorded.value,5);
  assert.equal(JSON.stringify(value).includes('missed'),false);
});

for (const count of [1,2,3,5]) {
  test(`${count} observations produce deterministic descriptive n`, () => {
    const values=Array.from({length:count},(_,index)=>row('2026-03-01',{id:`obs-${index}`,feel:index+5,occurred_at:`2026-03-01T${String(10+index).padStart(2,'0')}:00:00-08:00`}));
    const value=compute(values);
    assert.equal(value.normalized.planDays[0].feelObservations.length,count);
    assert.equal(value.normalized.planDays[0].dailyFeelSummary.n,count);
  });
}

test('multiple feel observations on one day retain timestamps', () => {
  const value=compute([row('2026-03-01',{id:'a'}),row('2026-03-01',{id:'b',occurred_at:'2026-03-01T12:00:00-08:00'})]);
  assert.deepEqual(value.normalized.planDays[0].feelObservations.map(item=>item.occurredAt),['2026-03-01T18:00:00.000Z','2026-03-01T20:00:00.000Z']);
});

test('hours since dose uses full datetimes', () => {
  const value=compute([row()]);
  assert.equal(value.normalized.planDays[0].feelObservations[0].hoursSinceDose,2);
  assert.equal(value.timing.onset.mean,1);
  assert.equal(value.timing.coverage.mean,7);
});

test('hourly gaps are preserved without interpolation', () => {
  const value=compute([row('2026-03-01',{id:'h1',occurred_at:'2026-03-01T09:20:00-08:00'}),row('2026-03-02',{id:'h3',occurred_at:'2026-03-02T11:20:00-08:00'})]);
  assert.deepEqual(value.feel_by_hour.buckets.map(bucket=>bucket.n),[1,0,1]);
});

test('patient logical day is stable across provider timezone differences', () => {
  const value=compute([row('2026-03-01',{occurred_at:'2026-03-02T07:30:00Z',patient_timezone:'Pacific/Honolulu',utc_offset_minutes:-600})]);
  assert.equal(value.normalized.planDays[0].checkInRecorded,true);
  assert.equal(value.normalized.planDays[1].checkInRecorded,false);
});

test('DST transition calculates elapsed real time from offsets', () => {
  const value=compute([row('2026-03-08',{dose_occurred_at:'2026-03-08T01:30:00-08:00',occurred_at:'2026-03-08T03:30:00-07:00',onset_occurred_at:null,wearoff_occurred_at:null})],{treatment_change_date:'2026-03-08',end_date:'2026-03-08'},'2026-03-08');
  assert.equal(value.normalized.planDays[0].feelObservations[0].hoursSinceDose,1);
});

test('after-midnight wear-off is valid with a subsequent-date timestamp', () => {
  const value=compute([row('2026-03-01',{dose_occurred_at:'2026-03-01T23:00:00-08:00',occurred_at:'2026-03-02T00:30:00-08:00',onset_occurred_at:null,wearoff_occurred_at:'2026-03-02T01:00:00-08:00'})]);
  assert.equal(value.timing.coverage.mean,2);
});

test('retrospective submission uses occurred and submitted timestamps', () => {
  const value=compute([row('2026-03-01',{submitted_at:'2026-03-01T12:00:00-08:00'})]);
  assert.equal(value.normalized.planDays[0].feelObservations[0].retrospective,true);
  assert.equal(value.data_quality.retrospective_entries.value,1);
});

test('missing event or submission timestamp never infers retrospective status', () => {
  const value=compute([row('2026-03-01',{occurred_at:null,submitted_at:null})]);
  assert.equal(value.normalized.planDays[0].feelObservations[0].retrospective,null);
  assert.equal(value.data_quality.retrospective_entries.reason,'missing_event_or_submission_timestamp');
});

for (const [name, overrides, field] of [
  ['medication status',{took_medication:false},'medication_status'],
  ['dose times',{dose_occurred_at:'2026-03-01T08:15:00-08:00'},'dose_time'],
  ['onset times',{onset_occurred_at:'2026-03-01T09:15:00-08:00'},'onset_time'],
  ['wear-off times',{wearoff_occurred_at:'2026-03-01T16:00:00-08:00'},'wearoff_time'],
  ['contextual answers',{sleep_context:'poor'},'sleep_context']
]) {
  test(`conflicting ${name} is reported and canonical value excluded`, () => {
    const first=row('2026-03-01',{id:'first',sleep_context:name==='contextual answers'?'good':null});
    const value=compute([first,row('2026-03-01',{id:'second',sleep_context:first.sleep_context,...overrides})]);
    const day=value.normalized.planDays[0];
    assert.ok(day.conflicts.some(conflict=>conflict.field===field));
    assert.equal(day.completeness,'conflicting');
    if(field==='dose_time') assert.equal(day.doseAnchor,null);
    if(field==='onset_time') assert.equal(day.onsetObservation,null);
    if(field==='wearoff_time') assert.equal(day.wearoffObservation,null);
  });
}

test('answered true plus empty effects means none reported', () => {
  const value=compute([row()]);
  assert.equal(value.side_effect_days.denominator_days.value,1);
  assert.deepEqual(value.side_effect_days.effects,[]);
});

test('unanswered side-effect question is excluded from denominator', () => {
  const value=compute([row('2026-03-01',{clinical_side_effects_answered:false,side_effects:['Headache']})]);
  assert.equal(value.side_effect_days.denominator_days.value,0);
  assert.equal(value.side_effect_days.reason,'insufficient_answered_side_effect_data');
});

test('repeated effect in same-day logs counts once and rate cannot exceed 100%', () => {
  const value=compute([row('2026-03-01',{id:'a',side_effects:['Dry mouth','Dry mouth']}),row('2026-03-01',{id:'b',side_effects:['Dry mouth']})]);
  assert.equal(value.side_effect_days.effects[0].distinct_day_count,1);
  assert.equal(value.side_effect_days.effects[0].denominator_days,1);
  assert.equal(value.side_effect_days.effects[0].rate,1);
});

test('active plan excludes future days', () => {
  const value=compute([],{end_date:'2026-03-10',duration_days:10},'2026-03-03');
  assert.equal(value.check_in_status.eligible_plan_days.value,3);
  assert.equal(value.normalized.planDays.filter(day=>day.eligibility==='future').length,7);
});

test('closed plan excludes post-closure dates', () => {
  const value=compute([],{end_date:'2026-03-10',duration_days:10,closed_date:'2026-03-04',status:'closed'},'2026-03-10');
  assert.equal(value.check_in_status.eligible_plan_days.value,4);
  assert.equal(value.normalized.planDays.filter(day=>day.eligibility==='after_close').length,6);
});

test('medication not taken and uncertain remain distinct', () => {
  const value=compute([row('2026-03-01',{took_medication:false,dose_occurred_at:null,onset_occurred_at:null,wearoff_occurred_at:null}),row('2026-03-02',{took_medication:null,dose_occurred_at:null,onset_occurred_at:null,wearoff_occurred_at:null})]);
  assert.equal(value.check_in_status.check_in_recorded.medication_not_taken.value,1);
  assert.equal(value.check_in_status.check_in_recorded.medication_status_uncertain.value,1);
});

test('onset before dose is invalid and excluded', () => {
  const value=compute([row('2026-03-01',{onset_occurred_at:'2026-03-01T07:30:00-08:00'})]);
  assert.equal(value.normalized.planDays[0].onsetObservation,null);
  assert.ok(value.normalized.planDays[0].invalidObservations.some(item=>item.type==='onset_before_dose'));
});

test('legacy row remains readable but excluded and marked incomplete', () => {
  const legacy=row('2026-03-01',{patient_logical_day:null,patient_timezone:null,utc_offset_minutes:null,occurred_at:null,submitted_at:null,dose_occurred_at:null,onset_occurred_at:null,wearoff_occurred_at:null});
  const value=compute([legacy]);
  assert.equal(value.normalized.legacyRows.length,1);
  assert.equal(value.data_quality.legacy_rows.reason,'legacy_timing_semantics_incomplete');
  assert.equal(value.check_in_status.check_in_recorded.value,0);
});

test('combination and other rows filter strictly by monitoring plan id', () => {
  const value=compute([row('2026-03-01',{drug:'wellbutrin+remeron'}),row('2026-03-02',{monitoring_plan_id:'other-plan',drug:'wellbutrin+remeron'})]);
  assert.equal(value.check_in_status.check_in_recorded.value,1);
});

test('child check-in totals equal parent totals', () => {
  const value=compute([row('2026-03-01'),row('2026-03-02',{took_medication:false}),row('2026-03-03',{took_medication:null})]);
  const recorded=value.check_in_status.check_in_recorded;
  assert.equal(recorded.medication_taken.value+recorded.medication_not_taken.value+recorded.medication_status_uncertain.value,recorded.value);
  assert.equal(recorded.value+value.check_in_status.no_check_in_recorded.value,value.check_in_status.eligible_plan_days.value);
});

test('every top-level metric result carries calculation version, n, and reason', () => {
  const value=compute([]);
  for(const metric of [value,value.check_in_status,value.side_effect_days,value.data_quality,value.timing,value.feel_by_hour,value.day_level_observations]){
    assert.equal(metric.calculation_version,metrics.CALCULATION_VERSION);
    assert.ok(Object.hasOwn(metric,'n'));
    assert.ok(Object.hasOwn(metric,'reason'));
  }
});

test('synthetic demo AI succeeds with approved server checks', async () => {
  const policy=await import('../supabase/functions/_shared/demo-policy.mjs');
  const result=await policy.runDemoNarrativeRequest({providerUserId:'provider',demoKey:policy.APPROVED_DEMO_KEY,metrics:{plan:{length_days:14}}},{
    providerExists:async()=>true,demoApproved:async()=>true,consumeRateLimit:async()=>true,timeoutMs:100,
    generate:async()=>({narrative:'Patient reported observations on 12 eligible days.',modelId:'test-model'}),now:()=>new Date('2026-03-01T00:00:00Z')
  });
  assert.equal(result.status,200);
  assert.ok(result.body.narrative.endsWith(policy.REQUIRED_DISCLAIMER));
  assert.equal(result.body.model_id,'test-model');
});

test('server rejects client-spoofed demo flag', async () => {
  const policy=await import('../supabase/functions/_shared/demo-policy.mjs');
  const result=await policy.runDemoNarrativeRequest({providerUserId:'provider',demoKey:'real-plan',is_demo:true,metrics:{}},{providerExists:async()=>true,demoApproved:async()=>true,consumeRateLimit:async()=>true,generate:async()=>({}),now:()=>new Date()});
  assert.equal(result.status,403);
});

test('AI structured-metrics gate rejects raw notes or identifying fields', async () => {
  const policy=await import('../supabase/functions/_shared/demo-policy.mjs');
  const result=await policy.runDemoNarrativeRequest({providerUserId:'provider',demoKey:policy.APPROVED_DEMO_KEY,metrics:{raw_notes:['private text']}},{providerExists:async()=>true,demoApproved:async()=>true,consumeRateLimit:async()=>true,generate:async()=>({narrative:'unused',modelId:'test'}),now:()=>new Date()});
  assert.equal(result.status,400); assert.equal(result.body.error,'invalid_structured_metrics');
});

test('AI timeout returns friendly timeout code', async () => {
  const policy=await import('../supabase/functions/_shared/demo-policy.mjs');
  const result=await policy.runDemoNarrativeRequest({providerUserId:'provider',demoKey:policy.APPROVED_DEMO_KEY,metrics:{}},{providerExists:async()=>true,demoApproved:async()=>true,consumeRateLimit:async()=>true,timeoutMs:5,generate:()=>new Promise(()=>{}),now:()=>new Date()});
  assert.equal(result.status,504); assert.equal(result.body.error,'timeout');
});

test('synthetic AI per-provider rate-limit denial is enforced', async () => {
  const policy=await import('../supabase/functions/_shared/demo-policy.mjs');
  const result=await policy.runDemoNarrativeRequest({providerUserId:'provider',demoKey:policy.APPROVED_DEMO_KEY,metrics:{}},{providerExists:async()=>true,demoApproved:async()=>true,consumeRateLimit:async()=>false,generate:async()=>({narrative:'unused',modelId:'test'}),now:()=>new Date()});
  assert.equal(result.status,429); assert.equal(result.body.error,'rate_limited');
});

test('malformed AI response is rejected', async () => {
  const policy=await import('../supabase/functions/_shared/demo-policy.mjs');
  const result=await policy.runDemoNarrativeRequest({providerUserId:'provider',demoKey:policy.APPROVED_DEMO_KEY,metrics:{}},{providerExists:async()=>true,demoApproved:async()=>true,consumeRateLimit:async()=>true,generate:async()=>({wrong:'shape'}),now:()=>new Date()});
  assert.equal(result.status,502);
});

test('prohibited AI language is rejected', async () => {
  const policy=await import('../supabase/functions/_shared/demo-policy.mjs');
  const result=await policy.runDemoNarrativeRequest({providerUserId:'provider',demoKey:policy.APPROVED_DEMO_KEY,metrics:{}},{providerExists:async()=>true,demoApproved:async()=>true,consumeRateLimit:async()=>true,generate:async()=>({narrative:'The medication was effective and the dose should increase.',modelId:'test'}),now:()=>new Date()});
  assert.equal(result.status,422); assert.equal(result.body.error,'validation_failed');
});

test('duplicate synthetic plan completion event creates one row', async () => {
  const policy=await import('../supabase/functions/_shared/demo-policy.mjs');
  const prototype=policy.createCompletionPrototype();
  assert.equal(prototype.complete('demo:closure:v1',{n:1}),true);
  assert.equal(prototype.complete('demo:closure:v1',{n:2}),false);
  assert.equal(prototype.rows.length,1);
});

test('provider synthetic Visit Brief renders all sections and three actual-data charts', () => {
  const html=fs.readFileSync(require.resolve('../provider.html'),'utf8');
  let script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match=>match[1]).filter(Boolean).at(-1);
  script=script.replace(/\ninit\(\);\s*$/,'');
  script+='\nconst __patient=buildDemoPatient(); const __brief=visitBriefHTML(__patient,__patient.plans[0],0); globalThis.__qa={sections:(__brief.match(/<section/g)||[]).length,svgs:(__brief.match(/<svg/g)||[]).length,hasExpected:/expected coverage|expected PK|coverage gap/i.test(__brief),hasPatientReported:__brief.includes("Patient-reported")};';
  const context={supabase:{createClient:()=>({})},GrindZoneClinicalMetrics:metrics,console,setTimeout,clearTimeout,Intl,Date,Math,JSON,Number,String,Array,Object,Set,Map,RegExp,Promise};
  vm.createContext(context); vm.runInContext(script,context);
  assert.ok(context.__qa.sections>=10);
  assert.equal(context.__qa.svgs,3);
  assert.equal(context.__qa.hasExpected,false);
  assert.equal(context.__qa.hasPatientReported,true);
});
