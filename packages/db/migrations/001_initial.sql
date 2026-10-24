CREATE TABLE IF NOT EXISTS trainers (
  id text PRIMARY KEY,
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{"dailyTime":null,"timezone":"Asia/Seoul","horizonMonths":3,"notionPollMinutes":5,"mockScheduleEnabled":false}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS members (
  trainer_id text NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  company_member_id text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trainer_id,company_member_id),
  CHECK (data->>'trainerId' = trainer_id AND data->>'companyMemberId' = company_member_id)
);
CREATE TABLE IF NOT EXISTS schedules (
  trainer_id text NOT NULL,
  event_key text NOT NULL,
  company_member_id text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trainer_id,event_key),
  FOREIGN KEY (trainer_id,company_member_id) REFERENCES members(trainer_id,company_member_id) ON DELETE CASCADE,
  CHECK (data->>'trainerId' = trainer_id AND data->>'companyMemberId' = company_member_id AND data->>'key' = event_key)
);
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  trainer_id text NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('company_sync','notion_poll')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry','succeeded','failed')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','schedule')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text,
  dedupe_key text
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_job_per_kind ON jobs (trainer_id,kind) WHERE status IN ('queued','running','retry');
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (available_at,created_at) WHERE status IN ('queued','retry');
CREATE TABLE IF NOT EXISTS tenant_locks (
  trainer_id text PRIMARY KEY REFERENCES trainers(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  lease_until timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduler_state (
  trainer_id text NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  kind text NOT NULL,
  next_due timestamptz NOT NULL,
  PRIMARY KEY (trainer_id,kind)
);
CREATE TABLE IF NOT EXISTS mock_notion_pages (
  trainer_id text NOT NULL,
  company_member_id text NOT NULL,
  page_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('template_pending','template_ready','complete')),
  ready_at timestamptz NOT NULL DEFAULT now(),
  body jsonb NOT NULL DEFAULT '[]',
  member_data jsonb NOT NULL DEFAULT '{}',
  manual_content text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trainer_id,company_member_id),
  UNIQUE (trainer_id,page_id),
  FOREIGN KEY (trainer_id,company_member_id) REFERENCES members(trainer_id,company_member_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mock_notion_events (
  trainer_id text NOT NULL,
  event_key text NOT NULL,
  company_member_id text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trainer_id,event_key),
  FOREIGN KEY (trainer_id,company_member_id) REFERENCES members(trainer_id,company_member_id) ON DELETE CASCADE,
  CHECK (data->>'trainerId' = trainer_id AND data->>'companyMemberId' = company_member_id AND data->>'key' = event_key)
);
CREATE TABLE IF NOT EXISTS issues (
  id uuid PRIMARY KEY,
  trainer_id text NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  company_member_id text,
  code text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (trainer_id,company_member_id) REFERENCES members(trainer_id,company_member_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS issues_tenant_idx ON issues (trainer_id,company_member_id);
