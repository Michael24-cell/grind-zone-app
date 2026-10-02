export const APPROVED_DEMO_KEY = 'grind-zone-alex-v1';
export const REQUIRED_DISCLAIMER = 'This summary is derived from patient-reported observations during a defined monitoring period and is intended to support, not replace, clinical judgment.';
export const AI_NARRATIVE_ENABLED_FOR_REAL_PATIENTS = false;
export const RESEARCH_METRICS_ENABLED_FOR_REAL_PLANS = false;

const forbiddenKeys = /(^|_)(name|email|note|notes|patient_id|provider_id|practice|date|timestamp|occurred_at|submitted_at)($|_)/i;
const prohibitedLanguage = [
  /\b(effective|ineffective|failed|adequate|inadequate|normal|abnormal)\b/i,
  /\b(delayed onset|high variability|low variability|clinical confidence|peak concentration)\b/i,
  /\b(compliant|noncompliant|nonadherent|missed dose)\b/i,
  /\b(improving|declining|caused|because|due to|therefore)\b/i,
  /\b(recommend|should|increase|decrease|start|stop|split|change)\b.{0,28}\b(dose|medication|treatment)\b/i,
  /\b(dose|medication|treatment)\b.{0,28}\b(increase|decrease|start|stop|split|change)\b/i
];

export function sanitizeStructuredMetrics(value, depth = 0) {
  if (depth > 8) throw new Error('metrics_too_deep');
  if (value == null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    if (typeof value === 'string' && value.length > 160) throw new Error('metrics_string_too_long');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 160) throw new Error('metrics_array_too_large');
    return value.map(item => sanitizeStructuredMetrics(item, depth + 1));
  }
  if (typeof value !== 'object') throw new Error('invalid_metrics_value');
  if (Object.keys(value).length > 120) throw new Error('metrics_object_too_large');
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.test(key)) throw new Error(`prohibited_metric_key:${key}`);
    output[key] = sanitizeStructuredMetrics(item, depth + 1);
  }
  return output;
}

export function validateNarrative(narrative) {
  if (typeof narrative !== 'string') return { ok:false, error:'malformed_ai_response' };
  const text = narrative.trim();
  if (!text || text.length > 2400) return { ok:false, error:'malformed_ai_response' };
  const content = text.endsWith(REQUIRED_DISCLAIMER) ? text : `${text}\n\n${REQUIRED_DISCLAIMER}`;
  const violation = prohibitedLanguage.find(pattern => pattern.test(content));
  return violation ? { ok:false, error:'prohibited_language' } : { ok:true, narrative:content };
}

export async function withTimeout(promise, timeoutMs, timeoutFactory = () => new Error('timeout')) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutFactory()), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runDemoNarrativeRequest(input, dependencies) {
  if (!input?.providerUserId) return { status:401, body:{ error:'provider_authorization_required' } };
  if (input.demoKey !== APPROVED_DEMO_KEY) return { status:403, body:{ error:'synthetic_demo_not_approved' } };
  if (!await dependencies.providerExists(input.providerUserId)) return { status:403, body:{ error:'provider_authorization_required' } };
  if (!await dependencies.demoApproved(input.demoKey)) return { status:403, body:{ error:'synthetic_demo_not_approved' } };
  if (!await dependencies.consumeRateLimit(input.providerUserId, input.demoKey)) return { status:429, body:{ error:'rate_limited' } };
  let metrics;
  try { metrics = sanitizeStructuredMetrics(input.metrics); }
  catch (_) { return { status:400, body:{ error:'invalid_structured_metrics' } }; }
  try {
    const response = await withTimeout(dependencies.generate(metrics), dependencies.timeoutMs || 12000);
    if (!response || typeof response !== 'object') return { status:502, body:{ error:'malformed_ai_response' } };
    const validation = validateNarrative(response.narrative);
    if (!validation.ok) return validation.error === 'prohibited_language'
      ? { status:422, body:{ error:'validation_failed' } }
      : { status:502, body:{ error:'malformed_ai_response' } };
    return { status:200, body:{ narrative:validation.narrative, model_id:response.modelId, generated_at:dependencies.now().toISOString() } };
  } catch (error) {
    return error?.message === 'timeout' ? { status:504, body:{ error:'timeout' } } : { status:503, body:{ error:'unavailable' } };
  }
}

export function createCompletionPrototype() {
  const ledger = new Set(), rows = [];
  return {
    complete(token, metrics) {
      if (ledger.has(token)) return false;
      ledger.add(token); rows.push({ token, metrics }); return true;
    },
    rows
  };
}
