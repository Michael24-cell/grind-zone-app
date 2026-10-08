-- ============================================================================
-- Grind-Zone migration 003: monitoring_plans.ended_at
-- Run after 002_clinical_layer.sql in the Supabase SQL editor.
-- Additive only — adds a timestamp of actual plan closure, distinct from
-- end_date (the planned/expected end date already on the table).
-- ============================================================================

ALTER TABLE monitoring_plans
  ADD COLUMN IF NOT EXISTS ended_at timestamptz;
