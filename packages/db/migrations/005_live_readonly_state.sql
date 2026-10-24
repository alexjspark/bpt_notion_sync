-- Public readiness metadata only. Credentials, identities and provider responses never belong here.
CREATE TABLE IF NOT EXISTS live_readonly_state (
  trainer_id text PRIMARY KEY REFERENCES trainers(id) ON DELETE CASCADE,
  company_status text NOT NULL CHECK (company_status IN ('needs_login','needs_verification','ready','error')),
  notion_status text NOT NULL CHECK (notion_status IN ('needs_token','needs_verification','ready','error')),
  preview_key_ready boolean NOT NULL DEFAULT false,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
