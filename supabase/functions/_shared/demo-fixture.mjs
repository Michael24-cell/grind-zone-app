export const DEMO_FIXTURE_VERSION = 'alex-14-day-v1';

// Server-owned synthetic source records. The research Function computes from
// these records and never accepts client-computed research metrics.
export function syntheticDemoSource() {
  const days = Array.from({ length:14 }, (_, index) => ({
    plan_day:index + 1,
    check_in_recorded:![7,13].includes(index + 1),
    medication_status:![7,13].includes(index + 1)?'taken':null,
    feel:![7,13].includes(index + 1)?[6,7,7,8,7,6,7,8,7,6,7,7][index-(index>6?1:0)-(index>12?1:0)]:null,
    side_effects_answered:![6,7,13].includes(index + 1),
    side_effects:index%3===0?['Reduced appetite']:index%5===0?['Dry mouth']:[]
  }));
  return { demo_key:'grind-zone-alex-v1', plan_length_days:14, plan_status:'completed', days };
}

export function computeSyntheticResearchMetrics(source) {
  const checkIns=source.days.filter(day=>day.check_in_recorded);
  const denominator=source.days.filter(day=>day.medication_status==='taken'&&day.side_effects_answered);
  const effects={};
  denominator.forEach(day=>[...new Set(day.side_effects)].forEach(effect=>effects[effect]=(effects[effect]||0)+1));
  const feels=checkIns.map(day=>day.feel).filter(Number.isFinite);
  return {
    plan_length_days:source.plan_length_days,
    plan_status:source.plan_status,
    eligible_days:source.days.length,
    check_in_days:checkIns.length,
    medication_taken_days:checkIns.filter(day=>day.medication_status==='taken').length,
    feel_observations:{n:feels.length,mean:feels.length?feels.reduce((sum,value)=>sum+value,0)/feels.length:null,min:feels.length?Math.min(...feels):null,max:feels.length?Math.max(...feels):null},
    side_effect_denominator_days:denominator.length,
    side_effect_days:Object.entries(effects).map(([effect,days])=>({effect,days,denominator:denominator.length}))
  };
}
