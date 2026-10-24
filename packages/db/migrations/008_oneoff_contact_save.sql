CREATE TABLE oneoff_contact_saves(
 id uuid PRIMARY KEY, trainer_id text NOT NULL REFERENCES trainers(id) CHECK(trainer_id='trainer-live-one'),
 consent_key text NOT NULL UNIQUE CHECK(consent_key='2026-10-24-two-members-four-fields-v1'),
 status text NOT NULL CHECK(status IN('prepared','queued','running','succeeded','partial','needs_review')),
 targets jsonb NOT NULL CHECK(jsonb_array_length(targets)=2),report jsonb NOT NULL DEFAULT '{}'::jsonb,
 error_code text,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz
);
CREATE TABLE oneoff_contact_targets(
 run_id uuid NOT NULL REFERENCES oneoff_contact_saves(id),page_id text NOT NULL,uid text NOT NULL,
 expected_hashes jsonb NOT NULL,dispatched boolean NOT NULL DEFAULT false,dispatched_at timestamptz,
 sent_fields jsonb,outcome jsonb,PRIMARY KEY(run_id,page_id)
);
