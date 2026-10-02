# Clinical foundation deployment notes

This increment is reviewable local code only. No migration was applied, no Edge Function was deployed, and no production configuration was changed.

## Review and validation

From the repository root:

```sh
node --test tests/*.test.js
python3 -m http.server 8642
```

`provider-insights.js` (provider panel triage and the pre-visit overview) must be deployed alongside `provider.html` and `clinical-metrics.js`. It reads existing columns only and needs no migration. Triage thresholds in `TRIAGE_DEFAULTS` are workflow reminders, not clinical alerts.

Then review:

- Patient app: `http://localhost:8642/app.html`
- Provider portal: `http://localhost:8642/provider.html`
- Provider synthetic preview: choose **Preview the clinical demo** on the provider sign-in screen.

The synthetic preview renders locally. AI generation and synthetic research completion require a signed-in provider plus deployed Functions.

## Database migration order

After review, apply migrations in order through the Supabase SQL editor or your normal controlled migration process:

1. `migrations/003_monitoring_plan_ended_at.sql` if it has not already been applied.
2. `migrations/004_observation_semantics.sql`
3. `migrations/005_synthetic_demo_foundation.sql`

Migration 004 deliberately performs no historical backfill. Existing rows remain readable and are labeled legacy/incomplete by analytics when patient logical-day or full-timestamp semantics are absent.

Migration 005 creates a synthetic individual-plan metrics prototype. Client roles receive no table privileges or RLS policies. Writes occur only through the service-role Edge Function and an idempotent database function.

## Edge Function configuration

Functions to review and deploy:

```sh
supabase functions deploy generate-demo-narrative
supabase functions deploy complete-demo-research
```

Required server secrets/configuration:

```text
ANTHROPIC_API_KEY=<server-side key>
AI_MODEL_ID=claude-sonnet-4-6
AI_TIMEOUT_MS=12000
```

Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to hosted Functions. The service-role key must never be added to `app.html`, `provider.html`, local storage, or any browser request.

Before enabling the demo Function, verify the configured model identifier exists for the selected Anthropic account. The frontend does not hard-code model behavior.

## Intentional gates

- `AI_NARRATIVE_ENABLED_FOR_REAL_PATIENTS = false`
- `RESEARCH_METRICS_ENABLED_FOR_REAL_PLANS = false`
- The server accepts only `grind-zone-alex-v1`, verifies a signed-in provider profile, and checks the server-owned approved-demo registry.
- AI receives structured synthetic metrics only—no names, emails, exact dates, provider identity, practice identity, or raw notes.
- Real-patient AI requires separate external-service, retention, security, privacy, and compliance review.
- Real-plan research writes remain unavailable.

## Deferred evidence-dependent work

Medication-specific expected ranges, clinical thresholds, validated scales, PK comparisons, food-effect analysis, causal interpretations, and treatment recommendations remain intentionally unavailable pending a separately reviewed evidence registry and analytics-profile package.
