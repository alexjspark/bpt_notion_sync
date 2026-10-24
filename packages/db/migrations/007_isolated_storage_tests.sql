-- Explicit isolated TEST writes only. No real contact values, secrets or provider bodies belong in this journal.
CREATE TABLE isolated_storage_tests(
 id uuid PRIMARY KEY,
 trainer_id text NOT NULL REFERENCES trainers(id) CHECK(trainer_id='trainer-live-one'),
 suite_key text NOT NULL CHECK(suite_key='2026-10-24-single-page'),
 test_id text NOT NULL UNIQUE CHECK(test_id ~ '^trainersync-test-[0-9a-f-]{36}$'),
 status text NOT NULL CHECK(status IN('queued','running','succeeded','failed','needs_review')),
 phase text NOT NULL,
 page_id text CHECK(page_id IS NULL OR page_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 create_attempted boolean NOT NULL DEFAULT false,
 report jsonb NOT NULL DEFAULT '{}'::jsonb,
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(trainer_id,suite_key)
);
CREATE TABLE isolated_storage_operations(
 id bigserial PRIMARY KEY,run_id uuid NOT NULL REFERENCES isolated_storage_tests(id),phase text NOT NULL,
 method text NOT NULL CHECK(method IN('POST','PATCH')),target_kind text NOT NULL CHECK(target_kind IN('new-test-page','test-page','test-body')),
 property_ids jsonb NOT NULL DEFAULT '[]'::jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
