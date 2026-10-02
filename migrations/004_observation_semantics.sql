-- ============================================================================
-- Grind-Zone migration 004: patient observation semantics
-- Run after 003_monitoring_plan_ended_at.sql.
-- Additive only. This migration intentionally does not backfill historical
-- rows: legacy rows remain readable but analytics mark their timing semantics
-- incomplete rather than inventing a patient logical day or timezone.
-- ============================================================================

alter table logs
  add column if not exists patient_logical_day date,
  add column if not exists occurred_at timestamptz,
  add column if not exists submitted_at timestamptz,
  add column if not exists patient_timezone text,
  add column if not exists utc_offset_minutes integer,
  add column if not exists clinical_side_effects_answered boolean,
  add column if not exists dose_occurred_at timestamptz,
  add column if not exists onset_occurred_at timestamptz,
  add column if not exists wearoff_occurred_at timestamptz;

alter table monitoring_plans
  add column if not exists patient_timezone text,
  add column if not exists patient_utc_offset_minutes integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'logs_utc_offset_minutes_range'
  ) then
    alter table logs add constraint logs_utc_offset_minutes_range
      check (utc_offset_minutes is null or utc_offset_minutes between -840 and 840);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'monitoring_plans_patient_utc_offset_range'
  ) then
    alter table monitoring_plans add constraint monitoring_plans_patient_utc_offset_range
      check (patient_utc_offset_minutes is null or patient_utc_offset_minutes between -840 and 840);
  end if;
end $$;

create index if not exists idx_logs_plan_logical_day
  on logs(monitoring_plan_id, patient_logical_day);

comment on column logs.patient_logical_day is
  'Patient-context logical plan date captured at submission time; never regroup from provider timezone.';
comment on column logs.occurred_at is
  'Full timestamp for the patient-reported feel/check-in observation.';
comment on column logs.submitted_at is
  'Full timestamp when the check-in was submitted.';
comment on column logs.patient_timezone is
  'Patient IANA timezone reported by the capture client when available.';
comment on column logs.utc_offset_minutes is
  'UTC offset at occurred_at, in minutes east of UTC.';
comment on column logs.clinical_side_effects_answered is
  'True means the question was answered; true plus an empty side_effects array means none reported.';
comment on column logs.dose_occurred_at is
  'Full patient-context timestamp for the dose anchor; dose_time remains for legacy display.';
comment on column logs.onset_occurred_at is
  'Full patient-context timestamp for reported onset; noticed_working_at remains for legacy display.';
comment on column logs.wearoff_occurred_at is
  'Full patient-context timestamp for reported wear-off; benefit_faded_at remains for legacy display.';
comment on column monitoring_plans.patient_timezone is
  'Patient IANA timezone captured when the patient accepts the plan; used for current/closure day boundaries.';
comment on column monitoring_plans.patient_utc_offset_minutes is
  'Patient UTC offset captured when the patient accepts the plan; timezone fallback context only.';

-- Terminal-plan timestamps are assigned by the database. Patient clients may
-- change the allowed status fields from migration 002 but cannot author an
-- arbitrary closure timestamp.
create or replace function prevent_patient_ended_at_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() = old.patient_user_id
     and not exists (select 1 from providers p where p.id = old.provider_id and p.user_id = auth.uid())
     and new.ended_at is distinct from old.ended_at then
    raise exception 'Patients cannot edit monitoring plan closure timestamps';
  end if;
  if auth.uid() = old.patient_user_id
     and not exists (select 1 from providers p where p.id = old.provider_id and p.user_id = auth.uid())
     and (new.patient_timezone is distinct from old.patient_timezone
          or new.patient_utc_offset_minutes is distinct from old.patient_utc_offset_minutes)
     and not (old.status = 'pending' and new.status = 'active') then
    raise exception 'Patient timezone may only be captured when accepting a monitoring plan';
  end if;
  return new;
end;
$$;

create or replace function stamp_monitoring_plan_ended_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status in ('completed','declined','closed')
     and old.status is distinct from new.status
     and new.ended_at is null then
    new.ended_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_patient_ended_at_edit on monitoring_plans;
create trigger trg_prevent_patient_ended_at_edit
  before update on monitoring_plans
  for each row execute function prevent_patient_ended_at_edit();

drop trigger if exists trg_stamp_monitoring_plan_ended_at on monitoring_plans;
create trigger trg_stamp_monitoring_plan_ended_at
  before update on monitoring_plans
  for each row execute function stamp_monitoring_plan_ended_at();

-- Existing patient INSERT/UPDATE policies and the provider read-only trigger
-- remain unchanged. Providers receive no write policy on logs.
