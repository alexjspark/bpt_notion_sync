CREATE TABLE team_tenants (
 id uuid PRIMARY KEY, label text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE team_users (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES team_tenants(id), login text NOT NULL UNIQUE,
 password_hash text NOT NULL, active boolean NOT NULL DEFAULT true, auth_version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), CHECK(login=lower(login))
);
CREATE TABLE team_sessions (
 token_hash char(64) PRIMARY KEY, user_id uuid NOT NULL, tenant_id uuid NOT NULL, auth_version integer NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,user_id) REFERENCES team_users(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX team_sessions_user ON team_sessions(tenant_id,user_id);
CREATE TABLE team_login_attempts (
 login_hash char(64) PRIMARY KEY, failures integer NOT NULL DEFAULT 0, window_at timestamptz NOT NULL DEFAULT now(),
 blocked_until timestamptz
);
CREATE TABLE team_connections (
 tenant_id uuid PRIMARY KEY REFERENCES team_tenants(id), id uuid NOT NULL UNIQUE, revision integer NOT NULL DEFAULT 1,
 company_status text NOT NULL DEFAULT 'not_connected', company_binding jsonb, active_session_id uuid,
 notion_status text NOT NULL DEFAULT 'not_connected', notion_destination jsonb, secret_revision integer,
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), CHECK(revision>0)
);
CREATE TABLE team_secrets (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL, revision integer NOT NULL, purpose text NOT NULL,
 envelope jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,connection_id,revision,purpose),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES team_connections(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE team_browser_sessions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES team_tenants(id), provider_handle text NOT NULL,
 status text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX team_provider_handle_unique ON team_browser_sessions(provider_handle) WHERE provider_handle<>'';
ALTER TABLE team_connections ADD FOREIGN KEY(tenant_id,active_session_id) REFERENCES team_browser_sessions(tenant_id,id);
CREATE UNIQUE INDEX team_destination_unique ON team_connections((notion_destination->>'dataSourceId')) WHERE notion_status='verified';
CREATE TABLE team_preview_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES team_tenants(id), request_id uuid NOT NULL,
 connection_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0), snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 status text NOT NULL CHECK(status IN('queued','running','succeeded','held','failed')),
 lease_token uuid, lease_until timestamptz, result jsonb, reason_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES team_connections(tenant_id,id),
 CHECK((status='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'running' AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK(reason_code IS NULL OR reason_code~'^[A-Z][A-Z0-9_]{0,79}$')
);
CREATE UNIQUE INDEX team_one_active_run ON team_preview_runs(tenant_id) WHERE status IN('queued','running');
