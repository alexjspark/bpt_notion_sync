import test from 'node:test';
import assert from 'node:assert/strict';
import { workerLiveSettings } from '../apps/worker/src/live-settings.ts';

const enabled = { LIVE_MANUAL_SYNC_ENABLED: 'true', APP_MODE: 'mock', ADAPTER_MODE: 'mock', EXTERNAL_CONNECTIONS_ENABLED: 'false' };

test('ordinary mock worker stays inert and enabled read lane uses only the fixed worker mounts', () => {
  assert.equal(workerLiveSettings({}), undefined);
  assert.equal(workerLiveSettings({ LIVE_MANUAL_SYNC_ENABLED: 'false' }), undefined);
  assert.deepEqual(workerLiveSettings(enabled), { enabled: true, configFile: '/run/config/live-readonly.json',
    notionTokenFile: '/run/secrets/notion_token', previewKeyFile: '/run/secrets/preview_hmac_key', companyEndpoint: 'http://company-browser:9222' });
});

test('read-only worker refuses changed guards or truthy enablement before accessing any credentials', () => {
  for (const value of ['TRUE', '1', 'yes', '']) assert.throws(() => workerLiveSettings({ ...enabled, LIVE_MANUAL_SYNC_ENABLED: value }), /LIVE_WORKER_ENABLEMENT_INVALID/);
  for (const patch of [{ APP_MODE: 'live' }, { ADAPTER_MODE: 'real' }, { EXTERNAL_CONNECTIONS_ENABLED: 'true' }, { EXTERNAL_CONNECTIONS_ENABLED: undefined }]) {
    assert.throws(() => workerLiveSettings({ ...enabled, ...patch }), /LIVE_WORKER_WRITE_GUARD_REQUIRED/);
  }
});

test('read-only worker rejects alternate secret/config mounts and external browser endpoints', () => {
  for (const patch of [{ NOTION_TOKEN_FILE: '/app/key.txt' }, { PREVIEW_HMAC_KEY_FILE: '/app/hmac' },
    { LIVE_READONLY_CONFIG_FILE: '/app/config.json' }, { COMPANY_CDP_ENDPOINT: 'http://example.invalid:9222' }]) {
    assert.throws(() => workerLiveSettings({ ...enabled, ...patch }), /LIVE_WORKER_MOUNT_BINDING_INVALID/);
  }
});
