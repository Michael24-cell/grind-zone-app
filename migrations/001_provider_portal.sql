-- ============================================================================
-- Grind-Zone migration 001: Provider portal (providers, patient links, RLS)
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor > New query).
-- Safe to run once. Assumes the existing `logs` table has a `user_id uuid`
-- column referencing auth.users (confirmed from app code) with RLS already
-- enabled for patient access.
-- ============================================================================

-- ── Providers ───────────────────────────────────────────────────────────────
create table if not exists providers (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null unique,
  name text not null,
  practice_name text,
  code text unique not null,
  created_at timestamptz default now()
);

alter table providers enable row level security;

-- Providers create/read/update/delete only their own profile.
-- (FOR ALL: the USING clause is also applied as WITH CHECK for inserts.)
create policy "Providers manage own profile" on providers
  for all using (auth.uid() = user_id);

-- Patients need to resolve a share code to a provider name/practice before
-- linking. Any signed-in user may read provider rows (name, practice, code).
-- See "RLS assumptions" in the project notes: this means codes are not
-- secrets — they are invitations, like a Zoom meeting code.
create policy "Patients can look up providers by code" on providers
  for select using (auth.uid() is not null);

-- ── Patient ↔ provider links ────────────────────────────────────────────────
create table if not exists patient_provider_links (
  id uuid default gen_random_uuid() primary key,
  patient_user_id uuid references auth.users not null,
  provider_id uuid references providers not null,
  -- auth.users is not client-readable, so the patient app stamps its own
  -- email here at link time for display in the provider dashboard.
  patient_email text,
  confirmed boolean default false,
  created_at timestamptz default now(),
  unique(patient_user_id, provider_id)
);

alter table patient_provider_links enable row level security;

-- Patients create and delete only their own links (revocable consent).
create policy "Patients manage own links" on patient_provider_links
  for all using (auth.uid() = patient_user_id);

-- Providers can see who linked to them (read-only).
create policy "Providers read their patient links" on patient_provider_links
  for select using (
    provider_id in (select id from providers where user_id = auth.uid())
  );

create index if not exists idx_ppl_provider on patient_provider_links(provider_id);
create index if not exists idx_ppl_patient on patient_provider_links(patient_user_id);

-- ── Provider read access to linked patient logs ─────────────────────────────
-- Read-only: no INSERT/UPDATE/DELETE policy is added for providers, so the
-- provider portal can never write to the logs table. Access requires a
-- CONFIRMED link and disappears the moment the patient deletes the link row.
create policy "Providers read linked patient logs" on logs
  for select using (
    user_id in (
      select ppl.patient_user_id
      from patient_provider_links ppl
      join providers p on p.id = ppl.provider_id
      where p.user_id = auth.uid()
        and ppl.confirmed = true
    )
  );
