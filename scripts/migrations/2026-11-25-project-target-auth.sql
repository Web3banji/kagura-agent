-- Phase 2.5: project target authentication configuration
-- Operator action required: run this migration against the application database.
-- Do not execute automatically. Back up the database before applying.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS target_auth_mode TEXT NOT NULL DEFAULT 'unconfigured';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS target_auth_evidence JSONB;

-- Optional: constrain allowed values (application also validates).
-- ALTER TABLE projects
--   ADD CONSTRAINT projects_target_auth_mode_check
--   CHECK (target_auth_mode IN ('public','protected','unconfigured'));

-- Backfill existing rows to unconfigured (default already applied).
UPDATE projects SET target_auth_mode = 'unconfigured' WHERE target_auth_mode IS NULL;
