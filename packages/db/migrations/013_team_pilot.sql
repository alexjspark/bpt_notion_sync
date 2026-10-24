ALTER TABLE team_users ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','operator'));
CREATE TABLE team_invites (
 id uuid PRIMARY KEY, token_hash char(64) NOT NULL UNIQUE, email_hash char(64) NOT NULL,
 login text NOT NULL, label text NOT NULL, issued_by uuid NOT NULL REFERENCES team_users(id),
 expires_at timestamptz NOT NULL, consumed_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(login=lower(login))
);
CREATE UNIQUE INDEX team_one_pending_invite ON team_invites(login) WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE TABLE team_pilot_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL, session_ref char(64) NOT NULL,
 preview_id uuid NOT NULL, connection_id uuid NOT NULL, revision integer NOT NULL,
 envelope jsonb NOT NULL, snapshot jsonb NOT NULL, lease_token uuid, lease_until timestamptz,
 status text NOT NULL CHECK(status IN ('queued','preparing','prepared','approved','executing','dispatching','verified','uncertain','held')),
 expires_at timestamptz NOT NULL, consumed_at timestamptz, result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,user_id) REFERENCES team_users(tenant_id,id),
 FOREIGN KEY(tenant_id,preview_id) REFERENCES team_preview_runs(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES team_connections(tenant_id,id)
);
CREATE UNIQUE INDEX team_one_pilot_active ON team_pilot_runs(tenant_id) WHERE status IN ('queued','preparing','prepared','approved','executing','dispatching','uncertain');
