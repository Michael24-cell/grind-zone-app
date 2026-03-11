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

Database       Postgres — row-level security enforced at DB level, not app code

Local storage  localStorage key "gz2" — doses, active drugs, settings,
               adaptive state

Hosting        Static file — Netlify / Vercel / GitHub Pages ready
               (drag and drop)

Dependencies   Supabase JS SDK via CDN only — zero other external dependencies


DEPLOYMENT
--------------------------------------------------------------------------------
Single HTML file. No build process required. Deploy by dragging the file to
Netlify or pushing to any static host. The Supabase project URL and anon key
are embedded — only the redirect URL configuration in Supabase Auth needs
updating to match the live domain.

- No server — fully static
- Works offline after first load (all logic is client-side)
- Mobile browser compatible — no app store required
- OTP email template must include {{ .Token }} in Supabase Auth
  -> Authentication -> Email Templates -> Magic Link

* PLANNED: Zone notes AI summarization via Anthropic API — will send zone-
  specific log notes to Claude to surface patterns in plain language (e.g.
  "you often mention feeling rushed during this window"). Per-use API cost.
  Trigger: "Summarize my notes" button per zone, fires on demand only.


DATABASE SCHEMA
--------------------------------------------------------------------------------
Table: logs

  id           bigserial primary key
  user_id      uuid — references auth.users, enforces data isolation
  drug         text — drug key e.g. "ritalin", "wellbutrin",
               "wellbutrin+remeron" for combo state
  feel         integer 1-10 — subjective feeling score
  tags         text[] — array of selected mood/symptom tags
  note         text — freeform note
  time         text — HH:MM logged time (may differ from ts if retroactively
               edited)
  dose_time    text — HH:MM dose time at moment of logging
  elapsed_h    float — hours elapsed since dose at log time
  zone         text — zone label at log time (recalculated on time edit)
  ts           timestamptz — timestamp, default now(), updated on time edit

RLS setup:

  alter table logs enable row level security;
  create policy "Users see own logs" on logs
    for all using (auth.uid() = user_id);

auth.uid() = user_id is enforced on all operations. Users can never read or
modify another user's rows, even with a valid session token.


AUTHENTICATION
--------------------------------------------------------------------------------
Passwordless OTP via Supabase Auth. signInWithOtp() without emailRedirectTo
sends a 6-digit code to the user's email. The user types the code into the app
and verifyOtp() exchanges it for a session. Omitting emailRedirectTo is what
tells Supabase to send the OTP code rather than a magic link — this also avoids
mobile in-app browser redirect failures entirely.

- One auth event per device — session survives page reloads and browser restarts
- Guest mode: no auth, all data stays in localStorage only
- Dose times always stay local regardless of auth state — session-specific data
- Logs sync to Supabase when signed in, with localStorage cache for instant UI


MEDICATIONS COVERED
--------------------------------------------------------------------------------
Each drug has research-backed zone definitions derived from published
pharmacokinetic data including FDA labels, clinical pharmacology studies,
and peer-reviewed literature.

Drug              Doses                    Mechanism           Half-life
---------------------------------------------------------------------------
Ritalin LA        --                       DARI -- bimodal     2-3 hr
Concerta 27mg     --                       DARI -- OROS pump   3.5 hr
Wellbutrin XL     150 / 300 / 450mg        NDRI                21 hr
Lamictal          25/50/75/100/150/200mg   Na+ channel block   22-37 hr
Remeron 7.5mg     --                       NaSSA -- H1+a2      26-37 hr
Lexapro 10mg      --                       SSRI -- SERT block  27-32 hr

Ritalin LA      IR + delayed bead release. Two distinct peaks ~1.5hr and
                ~5hr post-dose.

Concerta        Ascending OROS curve. Tmax 6.8hr FDA-confirmed. Peak arrives
                mid-afternoon by design. No valley between peaks unlike
                Ritalin LA.

Wellbutrin XL   Tmax ~5hr. Hydroxybupropion is primary active metabolite
                (AUC 16x parent compound). Potent CYP2D6 inhibitor -- affects
                all co-administered drugs metabolized by that pathway.
                Seizure risk is dose-dependent -- ceiling at 450mg.

Lamictal        Linear pharmacokinetics -- dose-proportional plasma levels.
                No acute effect -- cumulative over weeks. 98% bioavailability.
                75mg is a genuine mid-range clinical dose, common in bipolar
                II augmentation (1.5x plasma of 50mg).

Remeron 7.5mg   Sex-adjusted zones: female ~37hr half-life, male ~26hr.
                Residual Sedation and Clearing zones extend 1.5-3hr for
                female. Most sedating at lowest dose due to pure H1 blockade
                without competing alpha-2 stimulation.

Lexapro 10mg    Tmax 5hr. Steady state 7-10 days at 2.2-2.5x single-dose
                levels. Effects are cumulative -- no acute peak feel. SERT
                near-saturation even at 10mg. 5-HT1A autoreceptor
                desensitization is the mechanism behind delayed onset
                (weeks 2-4).


ALGORITHMIC LOGIC
--------------------------------------------------------------------------------

Pharmacokinetic Zone Engine
  Each drug has a zones array of objects with start, end (elapsed hours),
  label, power score, and zone type flags (peak, second, third).
  getZone(doseH, zones, elapsedOverride) finds the matching zone by comparing
  elapsed hours against zone boundaries. The optional elapsedOverride param
  is used when recalculating zone after a retroactive time edit. All timelines
  update every 30 seconds via a ticker.

Adaptive Peak Calibration
  After 6 logged entries with elapsed time data, the app begins shifting zone
  boundaries to match the user's personal peak timing.

  Algorithm:
  1. Buckets feel scores into 0.2-hour (12-minute) elapsed-time windows.
     Chosen over the previous 0.5hr to resolve shifts above the 20-minute
     minimum threshold.

  2. Adds 8 phantom "anchor" entries at the pharmacokinetic default peak
     (feel=8) -- resists early drift. Adjacent buckets get 40% weight anchors
     for smooth falloff.

  3. Applies exponential decay weighting: newest = 1.0, each older entry
     multiplied by 0.88. Recent experience counts more.

  4. Threshold for peak bucket inclusion: Math.floor(topScore) - 1.
     If the best bucket averages 8.3, all buckets scoring 7.0+ are included
     in the centroid. If best is 7.1, all 6.0+ are included.
     This respects integer feel boundaries -- a logged 7 always counts when
     the peak is in the 8s. Previous 85% rule was scale-dependent and could
     inconsistently cut off same-integer scores.

  5. Calculates weighted centroid of qualifying buckets, derives shift from
     pharmacokinetic default, clamps to per-drug maximum.

  6. Confidence score derived from log count and high-feel entry count --
     shown in calibration banner with shift direction and "view curve ->"
     link to the Your Curve page.

  Per-drug shift ceilings:
    Ritalin    +/-2hr  (second peak range 3-10hr)
    Concerta   +/-2hr  (FDA Tmax SD +/-1.8hr)
    Wellbutrin +/-2hr  (flagged "highly variable" by FDA)
    Lamictal   +/-1.5hr
    Remeron    +/-1.5hr
    Lexapro    +/-1hr

Your Curve Page
  Separate page accessible via "view curve ->" in the adaptive calibration
  banner. Shows one card per active drug with log data. Each card contains:

  - SVG chart with three layers:
      Grey line     pharmacokinetic default curve
      Color line    your personal calibrated curve (when adapted)
      Scatter dots  every individual log entry, colored by feel score
  - Dashed vertical line at your personal peak, lighter dashed at default
    peak -- shift is visible at a glance
  - Shift summary, confidence %, entry count below chart
  - Progress bar toward calibration if under 6 entries

  renderCurvePage() builds all active-drug cards. curveCardHTML(drugKey)
  generates the SVG and stats for one drug. Zone power levels are mapped to
  a 1-9 numeric scale to draw the curve shape.

Wellbutrin + Remeron Interaction Engine
  When both drugs have dose times entered, the app detects the current combo
  phase and renders a live interaction panel. The engine maps the pair of
  active zone labels to one of four pharmacodynamic phases:

  Morning synergy    Wellbutrin building + Remeron residual. Both drugs
                     elevating NE simultaneously via different mechanisms
                     (a2 blockade + reuptake inhibition).

  Daytime peak       Wellbutrin at full effect + Remeron at baseline.
                     Chronic receptor-level changes active in background.
                     Full NE/DA activation.

  Evening transition Both tapering. Cumulative steady-state effects fully
                     established. Natural wind-down window.

  Sleep phase        Remeron peaking overnight. Deep sedation, slow-wave
                     sleep enhancement, Wellbutrin cleared.

  Research basis: Blier et al. 2010 (46% vs 25% remission double-blind RCT),
  STAR*D, CO-MED trial, Millan 2000 a2 blockade mechanism, Stahl bupropion
  NE/DA review.

  Combo logs saved under virtual key "wellbutrin+remeron" -- zone stored is
  the combo phase name. Combo tab appears in log page once combo entries exist.

3AM Day Rollover
  Logical day boundaries at 3am instead of midnight.

  Two-layer rollover system:
  1. Live ticker: checks every 30 seconds, clears doses and shows banner.
  2. Startup check: compares ST.lastDoseDay to todayKey() on launch, clears
     silently if different. Handles app-closed-overnight case.

  ST.lastDoseDay stamped in onDose() and loadFromUrl().

Sex-Adjusted Remeron Zones
  Selector on Remeron tab adjusts zone durations. Female ~37hr / male ~26hr.
  Residual Sedation: 5-8hr male / 5-9.5hr female.
  Clearing: 8-11hr male / 9.5-14hr female.
  getEffectiveZones() applies sex adjustment before adaptive shifts.


ZONE NOTES — RESEARCH vs YOURS TOGGLE
--------------------------------------------------------------------------------
Each zone dropdown has a Research / Yours tab toggle once any logs exist
for that zone.

  Research tab    Default pharmacokinetic notes, always available.

  Yours tab       Builds progressively based on log count in that zone:

    1 log         Tab appears labeled "Yours 1/3" with progress bar.
                  Still defaults to Research view.

    2 logs        Defaults to Yours. Shows avg feel + feel trend label
                  (mostly good / often rough / mixed).

    3+ logs       Adds top tags with frequency counts and color-coded pills.
                  Adds timing note (avg elapsed hours when logging here).

    4+ logs       Most recent note shown as italic quote. Additional notes
                  collapsed under "+N more" link that expands inline.

    6+ logs       One-sentence interpretation added: "This tends to be a
                  good window for you" / "This zone has been rough" /
                  "Your experience here varies" -- derived from avg feel
                  above 6.5, below 4.5, or in between.

  Zone header shows a small "N logs" badge when data exists so you can
  see at a glance which zones you have personal data for before opening.

* PLANNED: "Summarize my notes" button per zone -- sends all notes written
  in that zone to the Anthropic API and returns a plain-language pattern
  summary (e.g. "you often mention feeling rushed or scattered during this
  window"). Fires on demand to avoid unnecessary API cost.


PATTERN DETECTION (Log Page)
--------------------------------------------------------------------------------
Collapsible "Your patterns" section on the log page. Unlocks at 8+ entries
for the selected drug. Three cards surface when enough data exists:

Tag patterns
  Compares tag frequency between high-feel days (7+) and low-feel days (4
  and under). Tags appearing in 25%+ of either group with 2+ occurrences
  surface as "On good days: focused 5x calm 3x" / "On rough days: anxious
  4x tired 3x". Color-coded with TAG_COLORS.

Timing patterns
  Buckets logged entries into 1-hour elapsed-time windows. Compares avg feel
  per window. Surfaces best and worst windows when 2+ windows have 2+ entries.
  Example: "Best window: 3-4hr after dose -- 7.8 avg".

Dose-time patterns
  Splits entries into before-9am doses vs 9am+ doses. Only renders if
  difference is 0.5+ points and each group has 3+ entries. States which
  timing tends to land better for this person.

All three cards are independent -- only the ones with sufficient data appear.
The panel stays collapsed by default; state persists within the session.


ADHERENCE & STREAK TRACKING (Log Page)
--------------------------------------------------------------------------------
Three-card panel at top of log page, per selected drug.

Streak card
  Counts consecutive days with at least one log entry back from today.
  Color scale: yellow (1 day) -> amber (3+) -> light green (7+) ->
  dark green (14+) -> darker green (14+ with fire emoji).
  If today has no log yet, streak counts from yesterday.

This week card
  Shows 7 dot indicators for the last 7 days.
  Green check = logged, red X = missed past day, grey = today/future.

Total days card
  Count of distinct days with any log for this drug.

Streak outcome bar (10+ logs required)
  Appears below the three cards when data shows a real pattern (0.4+ point
  difference). Compares avg feel on days within a 7+ day streak vs days
  after a gap. Example: "On 7+ day streaks you avg 7.2 vs 5.8 after gaps".
  Only renders when the comparison is statistically meaningful.

Monthly calendar view
  Strip/Month toggle above the 30-day calendar strip. Month view is a full
  7-column grid with left/right arrows to navigate previous months.
  Green tint = logged (intensity scales with avg feel).
  Red tint = missed past day.
  Grey = upcoming.
  Tapping any day filters the log list same as the strip.


LOG SYSTEM
--------------------------------------------------------------------------------

Features:
- Feel score 1-10 with 32 mood/symptom tags organized in 4 groups and
  freeform note
- Log time editable retroactively -- elapsed hours and zone recalculate
- By day view: last 10 days newest-first, most recent 3 days open
- By cycle view: entries grouped by zone
- 30-day calendar strip or full monthly grid view
- Filters: all / high (7+) / mid (4-6) / low (1-3) / has tags / has notes
- Adaptive calibration banner with "view curve ->" link

Tags (32 total, organized by group):

  Mood (13):    calm, content, grounded, steady, baseline, motivated,
                euphoric, moody, irritable, emotional, low, flat, blunted

  Mental (8):   focused, productive, clear, creative, scattered,
                overthinking, spacy, foggy

  Energy (10):  energized, tired, tense, restless, wired, crashed,
                headache, dry mouth, suppressed appetite, nauseous

  Social (3):   talkative, social battery low, withdrawn

  Previously removed as redundant: jittery (-> restless), hyperfocused
  (-> focused), sluggish (-> tired).

Data flow:
  saveLog()               Writes to Supabase + caches locally
  fetchLogsFromSupabase() Fetches on log page open, overwrites local cache
  saveEditTime()          Updates local entry, syncs to Supabase
  deleteLog()             Removes from Supabase and local cache
  Guest mode              All operations localStorage only


PERFORMANCE
--------------------------------------------------------------------------------
- 30-second ticker rerenders only nowBanner and timeline
- Logs rendered from localStorage cache instantly -- Supabase fetch updates
  in background (optimistic UI)
- Adaptive curve recalculates on render -- pure math, negligible cost
- Calendar strip scrollLeft set after render to avoid layout thrash
- By-day view caps at 10 days; by-cycle groups rather than paginates
- Single file, no build step -- zero overhead from module bundlers
- goPage('main') always rebuilds tabs and resyncs activeDrug on return


DOSE SELECTOR
--------------------------------------------------------------------------------
Wellbutrin XL and Lamictal have inline dose selectors. Selecting a dose
updates ST.wellbutrinDose or ST.lamictalDose, calls setDose() which updates
the name, rebuilds tabs, re-renders zones. Each dose has separate zone
definitions. Selections persist in localStorage.

Wellbutrin XL:
  150mg  Starting dose -- gentler curve, less anxiety/jitter risk
  300mg  Standard therapeutic -- hydroxybupropion AUC ~16x parent compound
  450mg  Max dose -- seizure risk increases, CYP2D6 inhibition significant,
         most patients cannot dose after noon

Lamictal:
  25mg   Titration -- sub-therapeutic, safety phase only
  50mg   Early therapeutic range
  75mg   Mid-range sweet spot -- 1.5x plasma of 50mg, real effect
  100mg  Standard maintenance -- full therapeutic plasma range (1-4 mg/L)
  150mg  Upper standard -- most patients dose at night
  200mg  Maximum standard dose -- never stop abruptly (seizure risk)


DISCLAIMER
--------------------------------------------------------------------------------
Not medical advice. Pharmacokinetic timings are based on published data and
vary between individuals. Adaptive calibration reflects logged subjective
experience, not clinical guidance. The combination interaction engine describes
pharmacodynamic mechanisms from published research -- it does not constitute
clinical recommendations. Always follow your prescriber's instructions.

================================================================================
