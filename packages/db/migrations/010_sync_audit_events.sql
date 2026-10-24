-- Only new redacted diagnostics are retained/rotated. Never prune approval/dispatch/idempotency ledgers.
CREATE TABLE sync_audit_settings(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),pseudonym_key text NOT NULL);
INSERT INTO sync_audit_settings(singleton,pseudonym_key) VALUES(true,gen_random_uuid()::text||gen_random_uuid()::text);
CREATE TABLE sync_audit_events(
 id bigserial PRIMARY KEY,run_id uuid NOT NULL,occurred_at timestamptz NOT NULL,level text NOT NULL CHECK(level IN('info','warn','error')),
 run_kind text NOT NULL CHECK(run_kind IN('preview','contact_once','profile_once','isolated_test','mock_job')),
 stage text NOT NULL CHECK(stage IN('ui_request','queued','claim','collect','map','plan','write','readback','complete','retry','error')),
 outcome text NOT NULL CHECK(outcome IN('started','succeeded','held','failed','uncertain','skipped')),
 event jsonb NOT NULL CHECK(octet_length(event::text)<=4096)
);
CREATE INDEX sync_audit_events_run_time ON sync_audit_events(run_id,occurred_at,id);
CREATE INDEX sync_audit_events_retention ON sync_audit_events(occurred_at);
