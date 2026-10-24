-- Manual real-connection previews are separate from the synthetic mock job queue.
-- No raw member values, provider cursors, credentials or provider error text belong here.
CREATE TABLE manual_sync_runs (
  id uuid PRIMARY KEY,
  trainer_id text NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'dry_run' CHECK (mode = 'dry_run'),
  status text NOT NULL CHECK (status IN ('needs_connection','queued','running','retry','succeeded','failed')),
  stage text NOT NULL CHECK (stage IN ('connection_required','queued','company_snapshot','notion_inventory','planning','complete')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  progress_percent integer NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  added_count integer CHECK (added_count = 0),
  skipped_count integer CHECK (skipped_count >= 0),
  failed_count integer CHECK (failed_count = 0),
  planned_add_count integer CHECK (planned_add_count >= 0),
  review_count integer CHECK (review_count >= 0),
  missing_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_capabilities) = 'array'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  preview_plan jsonb CHECK (preview_plan IS NULL OR jsonb_typeof(preview_plan) = 'object'),
  -- Only HMAC identities and fixed classification flags; never complete company rows.
  company_checkpoint jsonb CHECK (company_checkpoint IS NULL OR jsonb_typeof(company_checkpoint) = 'array'),
  preview_key_fingerprint text CHECK (preview_key_fingerprint IS NULL OR preview_key_fingerprint ~ '^[a-f0-9]{64}$'),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (trainer_id,id),
  UNIQUE (trainer_id,request_id),
  CHECK ((status = 'succeeded' AND preview_plan IS NOT NULL AND added_count IS NOT NULL AND added_count = 0
    AND failed_count IS NOT NULL AND failed_count = 0
    AND skipped_count IS NOT NULL AND planned_add_count IS NOT NULL AND review_count IS NOT NULL AND progress_percent = 100)
    OR (status <> 'succeeded' AND preview_plan IS NULL AND added_count IS NULL AND skipped_count IS NULL
      AND failed_count IS NULL AND planned_add_count IS NULL AND review_count IS NULL)),
  CHECK ((status = 'running' AND lease_until IS NOT NULL AND lease_token IS NOT NULL)
    OR (status <> 'running' AND lease_until IS NULL AND lease_token IS NULL))
);
CREATE UNIQUE INDEX manual_sync_one_active_per_trainer ON manual_sync_runs(trainer_id)
  WHERE status IN ('needs_connection','queued','running','retry');
CREATE INDEX manual_sync_claim_idx ON manual_sync_runs(available_at,created_at,id)
  WHERE status IN ('queued','retry');
CREATE INDEX manual_sync_history_idx ON manual_sync_runs(trainer_id,created_at DESC);

-- Every click UUID retains its result even if it joined an already-active run.
CREATE TABLE manual_sync_requests (
  trainer_id text NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trainer_id,request_id),
  FOREIGN KEY (trainer_id,run_id) REFERENCES manual_sync_runs(trainer_id,id) ON DELETE CASCADE
);
