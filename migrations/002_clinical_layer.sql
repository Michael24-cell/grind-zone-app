-- ============================================================================
-- Grind-Zone migration 002: Clinical monitoring layer
-- Run after 001_provider_portal.sql in the Supabase SQL editor.
-- Adds patient medication sync, provider-created monitoring plans, and
-- optional clinical fields on the existing logs table. Existing logs data,
-- policies, and patient write behavior are not restructured.
-- ============================================================================

-- ── Patient medication selections ──────────────────────────────────────────
create table if not exists patient_medications (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  drug_key text not null,
  drug_name text not null,
  dose_mg numeric,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, drug_key)
);

alter table patient_medications enable row level security;

create policy "Patients manage own medications" on patient_medications
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Providers read linked patient medications" on patient_medications
  for select
  using (
    user_id in (
      select ppl.patient_user_id
      from patient_provider_links ppl
      join providers p on p.id = ppl.provider_id
      where p.user_id = auth.uid()
        and ppl.confirmed = true
    )
  );

create index if not exists idx_patient_medications_user
  on patient_medications(user_id);

-- ── Prescriber-created monitoring plans ────────────────────────────────────
create table if not exists monitoring_plans (
  id uuid default gen_random_uuid() primary key,
  provider_id uuid references providers(id) on delete cascade not null,
  patient_user_id uuid references auth.users(id) on delete cascade not null,
  drug_key text not null,
  drug_name text not null,
  dose_mg numeric,
  treatment_change_date date not null,
  duration_days integer not null default 14 check (duration_days between 1 and 90),
  end_date date not null,
  follow_up_date date,
  symptoms text[] not null default '{}',
  side_effects text[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending','active','completed','declined','closed')),
  patient_response_at timestamptz,
  accepted_at timestamptz,
  outcome text,
  outcome_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table monitoring_plans enable row level security;

-- Patients may review and respond to plans addressed to their own account.
create policy "Patients read own monitoring plans" on monitoring_plans
  for select using (auth.uid() = patient_user_id);

create policy "Patients update own monitoring plans" on monitoring_plans
  for update
  using (auth.uid() = patient_user_id)
  with check (auth.uid() = patient_user_id);

-- Providers manage only plans they created, and may only create a plan for a
-- patient who currently has a confirmed link to that provider.
create policy "Providers read own monitoring plans" on monitoring_plans
  for select using (
    provider_id in (select id from providers where user_id = auth.uid())
  );

create policy "Providers create linked patient plans" on monitoring_plans
  for insert with check (
    provider_id in (select id from providers where user_id = auth.uid())
    and exists (
      select 1 from patient_provider_links ppl
      where ppl.provider_id = monitoring_plans.provider_id
        and ppl.patient_user_id = monitoring_plans.patient_user_id
        and ppl.confirmed = true
    )
  );

create policy "Providers update own monitoring plans" on monitoring_plans
  for update
  using (provider_id in (select id from providers where user_id = auth.uid()))
  with check (provider_id in (select id from providers where user_id = auth.uid()));

create policy "Providers delete own monitoring plans" on monitoring_plans
  for delete
  using (provider_id in (select id from providers where user_id = auth.uid()));

create index if not exists idx_monitoring_plans_patient
  on monitoring_plans(patient_user_id, status);
create index if not exists idx_monitoring_plans_provider
  on monitoring_plans(provider_id, status);

-- RLS identifies which rows a patient may update. This trigger additionally
-- keeps provider-authored plan details immutable from the patient client while
-- allowing consent and automatic completion transitions.
create or replace function enforce_patient_plan_update_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() = old.patient_user_id
     and not exists (
       select 1 from providers p
       where p.id = old.provider_id and p.user_id = auth.uid()
     ) then
    if new.provider_id is distinct from old.provider_id
       or new.patient_user_id is distinct from old.patient_user_id
       or new.drug_key is distinct from old.drug_key
       or new.drug_name is distinct from old.drug_name
       or new.dose_mg is distinct from old.dose_mg
       or new.treatment_change_date is distinct from old.treatment_change_date
       or new.duration_days is distinct from old.duration_days
       or new.end_date is distinct from old.end_date
       or new.follow_up_date is distinct from old.follow_up_date
       or new.symptoms is distinct from old.symptoms
       or new.side_effects is distinct from old.side_effects
       or new.outcome is distinct from old.outcome
       or new.outcome_note is distinct from old.outcome_note then
      raise exception 'Patients may only respond to monitoring plans';
    end if;

    if not (
      new.status = old.status
      or (old.status = 'pending' and new.status in ('active','declined'))
      or (old.status = 'active' and new.status in ('completed','declined'))
    ) then
      raise exception 'Invalid patient monitoring plan status transition';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_patient_plan_update_fields on monitoring_plans;
create trigger trg_enforce_patient_plan_update_fields
  before update on monitoring_plans
  for each row execute function enforce_patient_plan_update_fields();

-- ── Structured fields on existing logs ─────────────────────────────────────
alter table logs
  add column if not exists monitoring_plan_id uuid references monitoring_plans(id) on delete set null,
  add column if not exists took_medication boolean,
  add column if not exists noticed_working_at time,
  add column if not exists benefit_faded_at time,
  add column if not exists side_effects text[] not null default '{}';

create index if not exists idx_logs_monitoring_plan
  on logs(monitoring_plan_id, ts);

-- No provider INSERT, UPDATE, or DELETE policy is added to logs. Because RLS
-- policies are permissive, this trigger also prevents an account with a
-- provider profile from using an existing patient self-write policy on logs.
create or replace function prevent_provider_log_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and exists (select 1 from providers p where p.user_id = auth.uid()) then
    raise exception 'Provider accounts have read-only access to logs';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_provider_log_writes on logs;
create trigger trg_prevent_provider_log_writes
  before insert or update or delete on logs
  for each row execute function prevent_provider_log_writes();

-- Existing patient logs policies remain intact. Providers continue to receive
-- only the SELECT access established by migration 001 for confirmed links.
