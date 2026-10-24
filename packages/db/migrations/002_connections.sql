-- Public mock configuration only. Never store passwords, API tokens or browser sessions here.
CREATE TABLE IF NOT EXISTS connections (
  trainer_id text NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('company','notion')),
  mode text NOT NULL DEFAULT 'mock' CHECK (mode = 'mock'),
  enabled boolean NOT NULL DEFAULT false CHECK (enabled = false),
  public_config jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trainer_id,provider)
);
