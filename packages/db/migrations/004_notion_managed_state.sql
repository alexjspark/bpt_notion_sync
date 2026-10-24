-- Durable Notion ownership and write journals. Never persist raw template/survey text,
-- credentials, HMAC keys, provider payloads, or arbitrary configuration here.
CREATE FUNCTION notion_managed_blocks_are_safe(blocks jsonb, personalized boolean) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE entry record;
BEGIN
  IF jsonb_typeof(blocks) <> 'object' THEN RETURN false; END IF;
  FOR entry IN SELECT key,value FROM jsonb_each(blocks) LOOP
    IF jsonb_typeof(entry.value) <> 'object' THEN RETURN false; END IF;
    IF personalized THEN
      IF entry.key !~ '^[A-Za-z0-9_-]{1,128}$'
        OR entry.value - ARRAY['originalFingerprint','currentFingerprint']::text[] <> '{}'::jsonb
        OR NOT (entry.value ?& ARRAY['originalFingerprint','currentFingerprint'])
        OR jsonb_typeof(entry.value->'originalFingerprint') <> 'string'
        OR jsonb_typeof(entry.value->'currentFingerprint') <> 'string'
        OR entry.value->>'originalFingerprint' !~ '^[a-f0-9]{64}$'
        OR entry.value->>'currentFingerprint' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
    ELSE
      IF entry.key !~ '^(0|[1-9][0-9]{0,5})$'
        OR entry.value - ARRAY['blockId','fingerprint']::text[] <> '{}'::jsonb
        OR NOT (entry.value ?& ARRAY['blockId','fingerprint'])
        OR jsonb_typeof(entry.value->'blockId') <> 'string'
        OR jsonb_typeof(entry.value->'fingerprint') <> 'string'
        OR entry.value->>'blockId' !~ '^[A-Za-z0-9_-]{1,128}$'
        OR entry.value->>'fingerprint' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE notion_managed_state (
  trainer_id text NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  state_key text NOT NULL,
  state jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trainer_id,state_key),
  CHECK (state_key ~ '^notion:(member|calendar):[^:]+:[^:]+$'),
  CHECK (jsonb_typeof(state) = 'object'),
  CHECK (state - ARRAY['revision','pageId','pendingWrite','surveyBlocks','personalizedBlocks']::text[] = '{}'::jsonb),
  CHECK (NOT state ? 'revision' OR (jsonb_typeof(state->'revision') = 'number' AND state->>'revision' = revision::text)),
  CHECK (state ? 'revision' OR revision = 0),
  CHECK (NOT state ? 'pageId' OR (jsonb_typeof(state->'pageId') = 'string' AND state->>'pageId' ~ '^[A-Za-z0-9_-]{1,128}$')),
  CHECK (NOT state ? 'pendingWrite' OR (
    jsonb_typeof(state->'pendingWrite') = 'object'
    AND (state->'pendingWrite') - 'operation' = '{}'::jsonb
    AND (state->'pendingWrite') ? 'operation'
    AND jsonb_typeof(state->'pendingWrite'->'operation') = 'string'
    AND (state->'pendingWrite'->>'operation') IN ('create-member','personalize-block','rename-child-page','append-survey','update-survey','create-calendar','update-calendar')
  )),
  CHECK (NOT state ? 'surveyBlocks' OR notion_managed_blocks_are_safe(state->'surveyBlocks',false)),
  CHECK (NOT state ? 'personalizedBlocks' OR notion_managed_blocks_are_safe(state->'personalizedBlocks',true)),
  CHECK (state_key NOT LIKE 'notion:calendar:%' OR NOT (state ?| ARRAY['surveyBlocks','personalizedBlocks']))
);
