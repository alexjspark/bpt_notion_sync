import { createLiveReadOnlyRuntime, parseLiveReadOnlyConfig } from '../packages/engine/src/live-runtime.ts';
import { NOTION_API_ORIGIN, OfficialNotionClient } from '../packages/engine/src/live-notion-client.ts';
import type { NotionReadReviewCode } from '../packages/engine/src/live-runtime.ts';
import type { NotionTransport } from '../packages/engine/src/live-notion-client.ts';

export interface NotionReadOnlyDependencies {
  onReview?: (code: NotionReadReviewCode) => void;
  readText(path: string): Promise<string>;
  transport: NotionTransport;
}
export interface NotionReadOnlyReport {
  mode: 'notion_readonly_check';
  status: 'passed' | 'needs_token' | 'needs_verification' | 'invalid_configuration';
  permissions: 'passed' | 'not_verified';
  schema: 'passed' | 'not_verified';
  identity: 'passed' | 'not_verified';
  externalWritesEnabled: false;
}
/** Deliberately conservative: partial reads never certify an individual check. */
export function notionReadOnlyReport(status: NotionReadOnlyReport['status']): NotionReadOnlyReport {
  const result = status === 'passed' ? 'passed' : 'not_verified';
  return { mode: 'notion_readonly_check', status, permissions: result, schema: result, identity: result, externalWritesEnabled: false };
}

/** Only the approved master/schema and read-only identity query can reach the transport. */
export function restrictNotionCheckTransport(transport: NotionTransport, databaseId: string, dataSourceId: string): NotionTransport {
  const database = `${NOTION_API_ORIGIN}/v1/databases/${encodeURIComponent(databaseId)}`;
  const source = `${NOTION_API_ORIGIN}/v1/data_sources/${encodeURIComponent(dataSourceId)}`;
  return async request => {
    const allowed = (request.method === 'GET' && request.body === undefined && [database, source].includes(request.url))
      || (request.method === 'POST' && request.url === `${source}/query`);
    if (!allowed) throw new Error('NOTION_READONLY_ROUTE_REJECTED');
    return transport(request);
  };
}

export function parseNotionReadOnlyConfig(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONFIG_INVALID');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['version', 'trainerId', 'company', 'companyPreview', 'notion', 'contactSaveApproval', 'isolatedTestFixture'].includes(key)) || raw.notion === undefined) throw new Error('CONFIG_INVALID');
  const noSecrets = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(noSecrets); return; }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (/token|password|cookie|authorization|storageState/i.test(key)) throw new Error('CONFIG_INVALID');
      noSecrets(child);
    }
  };
  noSecrets(raw);
  // Property IDs/options must already be verified; this command does not discover or backfill them.
  // An unrelated, unverified company profile cannot cause company access or certify it.
  const config = parseLiveReadOnlyConfig({ version: raw.version, trainerId: raw.trainerId, notion: raw.notion });
  const members = config.notion!.members;
  const identity = members.identity;
  if (!identity || !['properties', 'exclusive-data-source-admin-url'].includes(identity.mode)) throw new Error('CONFIG_INVALID');
  if (identity.mode === 'exclusive-data-source-admin-url' && identity.exclusiveOwnershipApproved !== true) throw new Error('CONFIG_INVALID');
  const identityProperties = identity.mode === 'properties' ? [identity.trainerId, identity.companyMemberId] : [identity.adminUrl];
  for (const ref of [members.name, members.status, ...identityProperties,
    ...[members.weekday, members.time, members.firstTraining, members.callAt].filter(ref => ref !== undefined)]) {
    if (!ref || typeof ref.id !== 'string' || !ref.id || ref.id.startsWith('REPLACE_WITH_')) throw new Error('CONFIG_INVALID');
  }
  return config;
}

/** No defaults, local credential discovery, logging, database work, or worker ticks. */
export async function checkNotionReadOnly(
  options: { configFile: string; tokenFile: string }, dependencies: NotionReadOnlyDependencies,
): Promise<NotionReadOnlyReport> {
  let config: ReturnType<typeof parseNotionReadOnlyConfig>;
  try {
    if (!options.configFile || !options.tokenFile || options.configFile === options.tokenFile) return notionReadOnlyReport('invalid_configuration');
    config = parseNotionReadOnlyConfig(JSON.parse(await dependencies.readText(options.configFile)));
  } catch { return notionReadOnlyReport('invalid_configuration'); }
  const virtualConfig = 'notion-readonly-check:validated-config';
  const disabledHmac = 'notion-readonly-check:hmac-disabled';
  try {
    const members = config.notion!.members;
    const transport = restrictNotionCheckTransport(dependencies.transport, members.databaseId, members.dataSourceId);
    const runtime = await createLiveReadOnlyRuntime({ enabled: true, configFile: virtualConfig,
      notionTokenFile: options.tokenFile, previewKeyFile: disabledHmac, companyEndpoint: 'http://company-browser:9222' }, {
      readText: async path => {
        if (path === virtualConfig) return JSON.stringify(config);
        if (path === disabledHmac) throw new Error('HMAC_NOT_USED');
        if (path === options.tokenFile) return dependencies.readText(options.tokenFile);
        throw new Error('READ_PATH_REJECTED');
      },
      openCompanyPage: async () => { throw new Error('COMPANY_ACCESS_FORBIDDEN'); },
      dispatch: async () => { throw new Error('WORKER_DISPATCH_FORBIDDEN'); },
      onNotionReview: dependencies.onReview, strictNotionInventory:true,
      createNotionClient: token => new OfficialNotionClient({ token, transport, readPermit: { approved: true }, maxRateLimitRetries: 0 }),
    });
    await runtime!.preflight();
    return notionReadOnlyReport(runtime!.state.notionStatus === 'ready' ? 'passed'
      : runtime!.state.notionStatus === 'needs_token' ? 'needs_token' : 'needs_verification');
  } catch { return notionReadOnlyReport('needs_verification'); }
}
