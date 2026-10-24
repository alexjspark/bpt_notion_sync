import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManualSyncRequest } from '../lib/manual-sync-request.ts';

test('manual preview request cannot choose the tenant, activate credentials, or authorize writes', () => {
  assert.deepEqual(parseManualSyncRequest({action:'preview'}), {action:'preview'});
  for (const input of [null, [], {}, {action:'apply'}, {action:'preview',trainerId:'other'},
    {action:'preview',externalWritesEnabled:true}, {action:'preview',token:'synthetic-placeholder'}]) {
    assert.throws(() => parseManualSyncRequest(input), /MANUAL_SYNC_INVALID_REQUEST/);
  }
});
