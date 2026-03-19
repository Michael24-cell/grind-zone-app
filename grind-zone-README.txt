================================================================================
GRIND-ZONE — Technical README
Medication Timing + Mood Tracking
================================================================================


WHAT IS THIS?
--------------------------------------------------------------------------------
Grind-Zone is a pharmacokinetic-aware medication timing and mood tracking tool.
Enter when you took your pill — see exactly what neurochemical zone you are in,
when your peak hits, and when effects wind down. Log how you feel throughout the
day and the app slowly calibrates to your personal timing curve.

Built for personal use. No existing tool explained what was actually happening in
your brain at 2pm vs 8am on a given medication regimen, or what two
co-administered drugs were doing to each other in real time.


STACK & ARCHITECTURE
--------------------------------------------------------------------------------
Frontend       Single-file vanilla HTML / CSS / JS — no framework, no build
               step, no npm

Backend        Supabase (Postgres + Auth)

Auth           OTP 6-digit code (passwordless email) via Supabase Auth

Database       Postgres: row-level security enforced at DB level, not app code

Local storage  localStorage key "gz2" — doses, active drugs, settings,
               adaptive state, dose day history, treatment start dates

Hosting        Static file — Netlify / Vercel / GitHub Pages ready

Dependencies   Supabase JS SDK via CDN only — zero other external dependencies


DATABASE SCHEMA
--------------------------------------------------------------------------------
Table: logs

  id           bigserial primary key
  user_id      uuid references auth.users
  drug         text — drug key or combo key ("wellbutrin+remeron",
               "lamictal+lexapro")
  feel         integer 1-10
  tags         text[]
  note         text
  time         text — HH:MM logged time
  dose_time    text — HH:MM dose time at moment of logging
  elapsed_h    float — hours since dose at log time
  zone         text — zone label at log time
  ts           timestamptz — default now(), updated on time edit
  dose_mg      integer — mg dose at log time (nullable)

Migration: ALTER TABLE logs ADD COLUMN IF NOT EXISTS dose_mg integer;

RLS:
  alter table logs enable row level security;
  create policy "Users see own logs" on logs
    for all using (auth.uid() = user_id);

Insert safety: if dose_mg column missing in production, app auto-retries
insert without that field — no data loss.

fetchLogsFromSupabase only overwrites local cache on successful non-null
response. A Supabase error never wipes the local log cache.


AUTHENTICATION
--------------------------------------------------------------------------------
signInWithOtp() without emailRedirectTo sends 6-digit OTP. verifyOtp()
exchanges it for a session. Omitting emailRedirectTo avoids magic link
redirect failures on mobile browsers entirely.

- Session survives page reloads and browser restarts
- Guest mode: all data stays in localStorage only
- Dose times always local regardless of auth state


MEDICATIONS & DOSE SELECTORS
--------------------------------------------------------------------------------
All drugs except Ritalin LA have inline dose selectors. setDose(key, mg)
updates ST.[drug]Dose, annotates the tab name (e.g. "Lexapro · 5mg"),
rebuilds tabs, re-renders zones. Each dose has distinct zone definitions.
initDrugNames() restores annotated names on launch from saved state.

Drug              Doses                       Mechanism           Half-life
---------------------------------------------------------------------------
Ritalin LA        fixed                       DARI — bimodal      2-3 hr
Concerta          18 / 27 / 36 / 54mg         DARI — OROS pump    3.5 hr
Wellbutrin XL     150 / 300 / 450mg           NDRI                21 hr
Lamictal          25/50/75/100/150/200mg      Na+ channel block   22-37 hr
Remeron           7.5 / 15 / 30mg             NaSSA — H1+a2       26-37 hr
Lexapro           5 / 10mg                    SSRI — SERT block   27-32 hr

Concerta    18mg sub-therapeutic for most adults. 27mg standard start.
            36mg standard adult. 54mg FDA maximum — morning only.

Wellbutrin  Hydroxybupropion AUC 16x parent. CYP2D6 inhibitor.
            450mg: seizure risk, cannot dose after noon.

Lamictal    No acute effect — cumulative over weeks. 98% bioavailability.
            75mg = 1.5x plasma of 50mg. Linear pharmacokinetics.

Remeron     Paradoxical sedation: 7.5mg most sedating (pure H1), 30mg
            least sedating (NE activation offsets H1). Antidepressant
            strongest at higher doses. Sex-adjusted half-life: female
            ~37hr / male ~26hr. Residual Sedation and Clearing zones
            extend 1.5-3hr for female.

Lexapro     5mg: ~65-70% SERT occupancy, milder side effects, valid
            maintenance dose. 10mg: ~80% SERT occupancy. Steady state
            7-10 days. Effects cumulative — no acute peak.


COMBINATION ENGINES
--------------------------------------------------------------------------------

Wellbutrin + Remeron
  Four pharmacodynamic phases mapped from the pair of active zone labels:
  Morning synergy / Daytime peak / Evening transition / Sleep phase.
  Research: Blier 2010, STAR*D, CO-MED, Millan 2000.

Lamictal + Lexapro
  Four combined treatment arc stages:
  Both building (<3 wks) / Foundation setting (3-6 wks) /
  Full combination (6-12 wks) / Maintenance (12+ wks).
  Research: Nierenberg 2006, Barbee 2004, Geddes 2016.

  When Lam+Lex combo is active, individual treatment arc banners suppressed.
  The combo panel is authoritative for both drugs.

Combo logs saved under virtual key "wellbutrin+remeron" or "lamictal+lexapro".
Combo tab appears in log page once combo entries exist.
Zone counts, Yours panel, and adaptive calibration all include combo logs
for each constituent drug.


TREATMENT ARC SYSTEM (Lexapro + Lamictal)
--------------------------------------------------------------------------------
Tracks pharmacological progress for slow-build drugs. Banner shown on home
page for each drug (or replaced by combo panel when both are active).

Day counting uses: explicit calendar marks + log entries.
ST.doseDays (dose time entries) count toward streak only, NOT arc days.
Arc days require confirmed dose events (log or explicit mark).
Unknown past days between start and today assumed taken (generous default).

Lexapro stages (takenDays):
  day1_3 / week1_2 / week2_4 / week4_8 / established (42+)
  gap_minor (2-4 missed) / gap_significant (5+ missed)

Lamictal stages (takenDays):
  titrating (1-14) / establishing (14-42) / building (42-90) / established (90+)
  gap_warning (2-4 missed) / retitrate_needed (5+ consecutive missed)
  LAMICTAL_RESTART_THRESHOLD_DAYS = 5

Retroactive calendar marking:
  Tapping a past day for Lexapro/Lamictal opens floating mark menu.
  Marks saved to ST.treatmentDates[drug][YYYY-MM-DD].
  ST.treatmentStart[drug] tracks earliest confirmed date.
  Explicit "taken" marks show green in calendar without a log entry.


STREAK & DOSE TRACKING
--------------------------------------------------------------------------------
ST.doseDays[drugKey][YYYY-MM-DD] = true stamped in onDose() per drug.

A day counts as "tracked" if it has a log entry OR a dose time entry.
Streak, week dots, calendar, and "days tracked total" all use merged set.
Arc day count uses only confirmed events (see above).
Streak panel renders with zero logs as long as dose entries exist.

Adherence cards (log page):
  Streak         Consecutive tracked days back from today.
  This week      7-day dot grid. Green = tracked, red = missed past day.
  Total days     Distinct tracked days (logs + dose entries).

Outcome comparison (10+ logs):
  Avg feel on 7+ day streaks vs days after a gap.
  Renders only when diff 0.4+ and both groups have 3+ entries.


ZONE NOTES — RESEARCH vs YOURS BLEND
--------------------------------------------------------------------------------
Yours view blends research content with personal data progressively.
Research notes are never removed — they fade as personal data accumulates.

  1 log    Personal stat block + progress bar. Research at 80% opacity.
  2 logs   Personal stats active (avg feel, trend). Research at 80%.
  3+ logs  Personal leads: avg, timing, top tags. Research dims to 65%.
  6+ logs  Verdict sentence added. Research collapses to toggle at 45%.
  10+ logs Personal fully primary.

Zone header badge shows "N logs" before opening zone.
Log counts include combo logs for each drug.


ADAPTIVE PEAK CALIBRATION
--------------------------------------------------------------------------------
Activates at 6 logged entries with elapsed time data.

  0.2hr (12-min) buckets. 8 phantom anchors at PK default peak (feel=8).
  Exponential decay weight: newest=1.0, each older * 0.88.
  Peak threshold: floor(topScore) - 1.
  Weighted centroid clamped to per-drug maximum shift.

Shift ceilings: Ritalin ±2hr, Concerta ±2hr, Wellbutrin ±2hr,
                Lamictal ±1.5hr, Remeron ±1.5hr, Lexapro ±1hr

Your Curve page: SVG with default curve (grey), personal curve (color),
scatter dots per log entry, shift summary, confidence %.


CALENDAR
--------------------------------------------------------------------------------
Strip view    30-day horizontal. Dose-entry days show as empty green cells.
Month view    7-column grid with month navigation arrows.
              Green = logged. Red = explicitly marked missed.
              Grey = no data or future. Past days with no data are GREY not red.

Date math: appDay() uses local getFullYear/getMonth/getDate — NOT
toISOString() which shifts dates in non-UTC timezones.


LOG SYSTEM
--------------------------------------------------------------------------------
32 tags in 4 groups. Feel 1-10. Freeform note. Time editable retroactively.
By-day (10 days) and by-cycle (grouped by zone) views.
Filters: all / high / mid / low / has tags / has notes.

Data flow: saveLog() -> Supabase + local cache.
fetchLogsFromSupabase() on page open — safe overwrite only.
deleteLog() / saveEditTime() sync both stores.


PATTERN DETECTION
--------------------------------------------------------------------------------
8+ entries required. Three independent cards:
  Tag patterns      High-feel vs low-feel tag frequency comparison.
  Timing patterns   Best/worst 1-hour elapsed-time windows.
  Dose-time         Before/after 9am split (0.5+ point diff, 3+ per group).


DARK MODE
--------------------------------------------------------------------------------
Full toggle, persisted. bgZ() forces color:#1a1a1a inline on all highlighted
zone headers (peak/peach/grey backgrounds) — inline styles cannot be
overridden by dark mode CSS, ensuring readable text on light backgrounds.


KEY STATE (localStorage "gz2")
--------------------------------------------------------------------------------
ST.doses{}           Dose times per drug
ST.active[]          Active drug keys
ST.dark              Dark mode
ST.lastDoseDay       Logical date of last dose entry
ST.adaptiveOff{}     Per-drug adaptive disable flag
ST.logs[]            Local log cache
ST.sex               'female' | 'male' | null
ST.wellbutrinDose / lamictalDose / lexaproDose / concertaDose / remeronDose
ST.treatmentDates{}  Per drug per date: 'taken' | 'missed'
ST.treatmentStart{}  Per drug: earliest confirmed dose date (YYYY-MM-DD)
ST.doseDays{}        Per drug per date: true when dose time entered
                     (streak tracking only — not arc day count)


ALGORITHMIC NOTES
--------------------------------------------------------------------------------
getEffectiveZones(drugKey)    Sex adjustment then adaptive shift. All zone
                               rendering goes through this function.

getTreatmentDateMap(drugKey)  Merges explicit marks + log-inferred days.
                               doseDays excluded intentionally.

Combo log counting            Any log count must include combo keys:
  filter(e => e.drug===drugKey ||
              e.drug===COMBO_KEY ||
              e.drug===COMBO_KEY_LL)
  Applies to: logCountForZone, getAdaptiveNote, yoursHTML, getPersonalCurve.

3AM rollover                  appDay() subtracts 1 day when hours < 3.


DEPLOYMENT NOTES
--------------------------------------------------------------------------------
- OTP email template must include {{ .Token }} in Supabase
  Auth -> Email Templates -> Magic Link
- No build step — drag single HTML file to Netlify/Vercel
- Supabase URL and anon key embedded in file
- Run dose_mg migration on existing database before deploying


DISCLAIMER
--------------------------------------------------------------------------------
Not medical advice. Pharmacokinetic timings are based on published data and
vary between individuals. Adaptive calibration reflects logged subjective
experience, not clinical guidance. The combination interaction engine describes
pharmacodynamic mechanisms from published research — it does not constitute
clinical recommendations. Always follow your prescriber's instructions.

================================================================================
