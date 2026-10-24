ALTER TABLE team_connections ADD COLUMN expected_company_binding jsonb;
UPDATE team_connections SET expected_company_binding=company_binding WHERE company_binding IS NOT NULL;
ALTER TABLE team_browser_sessions ADD COLUMN owner_user_id uuid;
ALTER TABLE team_browser_sessions ADD COLUMN owner_auth_version integer;
ALTER TABLE team_browser_sessions ADD COLUMN auth_session_hash char(64);
ALTER TABLE team_browser_sessions ADD FOREIGN KEY(tenant_id,owner_user_id) REFERENCES team_users(tenant_id,id);
CREATE TABLE team_browser_allocations(
 tenant_id uuid NOT NULL, session_id uuid NOT NULL, connection_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN('queued','starting','ready','stopping','stopped','uncertain','failed')),
 account_binding jsonb, account_observed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,session_id),
 FOREIGN KEY(tenant_id,session_id) REFERENCES team_browser_sessions(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES team_connections(tenant_id,id)
);
CREATE TABLE team_browser_operations(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,session_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN('allocate','probe','stop')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','succeeded','uncertain','manual_review','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
 available_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz,
 reason_code text,updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,session_id,action),
 FOREIGN KEY(tenant_id,session_id) REFERENCES team_browser_sessions(tenant_id,id),
 CHECK((status='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR(status<>'running' AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK(reason_code IS NULL OR reason_code~'^[A-Z][A-Z0-9_]{0,79}$')
);
CREATE INDEX team_browser_operations_pending ON team_browser_operations(available_at) WHERE status IN('queued','uncertain');

CREATE TABLE team_runtime_health(role text PRIMARY KEY CHECK(role IN('runner','worker','gateway','egress')),ready boolean NOT NULL,heartbeat_at timestamptz NOT NULL);
