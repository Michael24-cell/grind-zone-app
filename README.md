# Grind-Zone

Medication timing and mood tracker built around real pharmacokinetic data. Enter when you took a dose, see what neurochemical zone you're in right now, and log how you feel — the app calibrates its zone timing to your own data over time.

No build step, no framework — static HTML/CSS/JS, deployed on Vercel, backed by Supabase (Postgres + Auth).

## Apps in this repo

| File | What it is |
|---|---|
| [`index.html`](index.html) | Landing page — "I'm a patient" / "I'm a provider" chooser, routes to the two apps below |
| [`app.html`](app.html) | Patient app — dose timing, zones, feeling log, history, settings |
| [`provider.html`](provider.html) | Provider portal — read-only view of logs patients have explicitly shared |

## Patient app ([app.html](app.html))

- **Medications covered:** Ritalin LA, Wellbutrin XL, Lamictal, Concerta 27mg, Remeron 7.5mg, Lexapro 10mg — each with its own pharmacokinetic zone curve (onset, peaks, trough, taper, baseline, etc.)
- **Dose timing:** enter a dose time and see live zone status, a same-day timeline, and a reverse calculator ("what time should I dose to peak by X?")
- **Combination tracking:** live interaction panel when Wellbutrin+Remeron or Lamictal+Lexapro are both active — what the drugs are doing to each other right now, based on published pharmacodynamics research
- **Feeling log:** rate how you feel (1–10) with tags and notes; grouped by day or by cycle, with a 30-day calendar strip and pattern insights
- **Adaptive calibration:** after enough logged entries, zone timing quietly shifts to match your personal peak timing (confidence %, entry counts, and a reset are all visible in-app)
- **Prescriber tools:** print-ready prescriber report (30-day summary) and raw CSV export from Settings
- **Provider linking:** enter a code from your prescriber to share logs with their provider-portal view; revocable anytime
- **In-app guide:** "How Grind-Zone works" walkthrough, reachable from the empty dashboard state and from Settings
- **Accounts:** passwordless email OTP via Supabase, or guest mode (logs stay local only); dark mode; bottom-tab navigation (Home / Log / History / Settings)

## Provider portal ([provider.html](provider.html))

- Passwordless email OTP sign-in for providers (separate from patient accounts)
- First-login setup generates a unique share code per provider/practice
- Dashboard lists linked patients with feel-score stats, tag trends, and a per-patient report view
- Read-only — providers only see logs patients have explicitly linked and shared, revocable by the patient at any time
- Row-level security enforced in Postgres, not just app code — see [`migrations/001_provider_portal.sql`](migrations/001_provider_portal.sql) for the `providers` / `patient_provider_links` schema and RLS policies

## Stack

- **Frontend:** vanilla HTML/CSS/JS, no build step, no npm dependencies (Supabase JS SDK loaded via CDN)
- **Backend:** Supabase — Postgres + Auth (OTP), row-level security
- **Hosting:** Vercel, static deploy

See [`grind-zone-README.txt`](grind-zone-README.txt) for deeper technical notes (DB schema, deployment details, adaptive calibration math).
