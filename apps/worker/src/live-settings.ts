export interface WorkerLiveSettings {
  enabled: true;
  configFile: '/run/config/live-readonly.json';
  notionTokenFile: '/run/secrets/notion_token';
  previewKeyFile: '/run/secrets/preview_hmac_key';
  companyEndpoint: 'http://company-browser:9222';
}

/** Configuration only: never inspects secret files or performs network access. */
export function workerLiveSettings(environment: Readonly<Record<string, string | undefined>>): WorkerLiveSettings | undefined {
  const enabled = environment.LIVE_MANUAL_SYNC_ENABLED;
  if (enabled === undefined || enabled === 'false') return undefined;
  if (enabled !== 'true') throw new Error('LIVE_WORKER_ENABLEMENT_INVALID');
  if (environment.APP_MODE !== 'mock' || environment.ADAPTER_MODE !== 'mock' || environment.EXTERNAL_CONNECTIONS_ENABLED !== 'false') {
    throw new Error('LIVE_WORKER_WRITE_GUARD_REQUIRED');
  }
  const fixed = {
    LIVE_READONLY_CONFIG_FILE: '/run/config/live-readonly.json',
    NOTION_TOKEN_FILE: '/run/secrets/notion_token',
    PREVIEW_HMAC_KEY_FILE: '/run/secrets/preview_hmac_key',
    COMPANY_CDP_ENDPOINT: 'http://company-browser:9222',
  } as const;
  for (const [name, expected] of Object.entries(fixed)) {
    if (environment[name] !== undefined && environment[name] !== expected) throw new Error('LIVE_WORKER_MOUNT_BINDING_INVALID');
  }
  return { enabled: true, configFile: fixed.LIVE_READONLY_CONFIG_FILE, notionTokenFile: fixed.NOTION_TOKEN_FILE,
    previewKeyFile: fixed.PREVIEW_HMAC_KEY_FILE, companyEndpoint: fixed.COMPANY_CDP_ENDPOINT };
}
