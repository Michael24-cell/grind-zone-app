-- ============================================================================
-- Grind-Zone migration 005: synthetic-demo AI/research foundation
-- Run after 004_observation_semantics.sql.
-- Prototype tables contain synthetic individual-plan metrics only. They are
-- not described as anonymous, aggregate, de-identified, or production-ready.
-- No client role receives table access. Edge Functions use the service role.
-- ============================================================================

create table if not exists approved_synthetic_demo_plans (
  demo_key text primary key,
  enabled boolean not null default true,
  fixture_version text not null,
  created_at timestamptz not null default now()
);

insert into approved_synthetic_demo_plans (demo_key, enabled, fixture_version)
values ('grind-zone-alex-v1', true, 'alex-14-day-v1')
on conflict (demo_key) do update
set enabled = excluded.enabled, fixture_version = excluded.fixture_version;

create table if not exists synthetic_demo_ai_rate_limits (
  id bigint generated always as identity primary key,
  provider_user_id uuid not null,
  demo_key text not null references approved_synthetic_demo_plans(demo_key),
  requested_at timestamptz not null default now()
);

create index if not exists idx_synthetic_demo_ai_rate_provider_time
  on synthetic_demo_ai_rate_limits(provider_user_id, requested_at desc);

create table if not exists synthetic_plan_completion_ledger (
  completion_token text primary key,
  demo_key text not null references approved_synthetic_demo_plans(demo_key),
  provider_user_id uuid not null,
  completed_at timestamptz not null default now()
);

create table if not exists synthetic_research_plan_metrics (
  id bigint generated always as identity primary key,
  completion_token text not null unique references synthetic_plan_completion_ledger(completion_token),
  demo_key text not null references approved_synthetic_demo_plans(demo_key),
  fixture_version text not null,
  calculation_version text not null,
  descriptive_metrics jsonb not null,
  created_at timestamptz not null default now()
);

alter table approved_synthetic_demo_plans enable row level security;
alter table synthetic_demo_ai_rate_limits enable row level security;
alter table synthetic_plan_completion_ledger enable row level security;
alter table synthetic_research_plan_metrics enable row level security;

revoke all on approved_synthetic_demo_plans from public, anon, authenticated;
revoke all on synthetic_demo_ai_rate_limits from public, anon, authenticated;
revoke all on synthetic_plan_completion_ledger from public, anon, authenticated;
revoke all on synthetic_research_plan_metrics from public, anon, authenticated;

-- Atomic per-provider rate limiter for synthetic AI generation. The advisory
-- transaction lock prevents concurrent requests from stepping past the cap.
create or replace function consume_synthetic_demo_ai_rate_limit(
  p_provider_user_id uuid,
  p_demo_key text,
  p_window_minutes integer default 60,
  p_max_requests integer default 5
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  request_count integer;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  if not exists (select 1 from approved_synthetic_demo_plans where demo_key=p_demo_key and enabled=true) then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtext(p_provider_user_id::text));
  select count(*) into request_count
  from synthetic_demo_ai_rate_limits
  where provider_user_id=p_provider_user_id
    and requested_at >= now() - make_interval(mins => greatest(1,p_window_minutes));
  if request_count >= greatest(1,p_max_requests) then return false; end if;
  insert into synthetic_demo_ai_rate_limits(provider_user_id,demo_key)
  values(p_provider_user_id,p_demo_key);
  return true;
end;
$$;

revoke all on function consume_synthetic_demo_ai_rate_limit(uuid,text,integer,integer) from public, anon, authenticated;
grant execute on function consume_synthetic_demo_ai_rate_limit(uuid,text,integer,integer) to service_role;

-- Atomic, service-role-only completion. The ledger is separate from the
-- research table and its primary key makes duplicate completion events no-ops.
create or replace function complete_synthetic_demo_plan(
  p_demo_key text,
  p_completion_token text,
  p_provider_user_id uuid,
  p_fixture_version text,
  p_calculation_version text,
  p_descriptive_metrics jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'service role required';
  end if;

  if not exists (
    select 1 from approved_synthetic_demo_plans
    where demo_key = p_demo_key and enabled = true and fixture_version = p_fixture_version
  ) then
    raise exception 'synthetic demo is not approved';
  end if;

  insert into synthetic_plan_completion_ledger(completion_token, demo_key, provider_user_id)
  values (p_completion_token, p_demo_key, p_provider_user_id)
  on conflict (completion_token) do nothing;
  get diagnostics inserted_count = row_count;

  if inserted_count = 0 then return false; end if;

  insert into synthetic_research_plan_metrics(
    completion_token, demo_key, fixture_version, calculation_version, descriptive_metrics
  ) values (
    p_completion_token, p_demo_key, p_fixture_version, p_calculation_version, p_descriptive_metrics
  );
  return true;
end;
$$;

revoke all on function complete_synthetic_demo_plan(text,text,uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function complete_synthetic_demo_plan(text,text,uuid,text,text,jsonb) to service_role;
