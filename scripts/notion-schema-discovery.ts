import{parseNotionDestination}from'../packages/engine/src/runtime-scopes.ts';import type{NotionDestinationScope}from'../packages/engine/src/runtime-scopes.ts';
import { NOTION_API_ORIGIN, NotionHttpError, OfficialNotionClient } from '../packages/engine/src/live-notion-client.ts';
import type { NotionTransport } from '../packages/engine/src/live-notion-client.ts';

export interface NotionSchemaDependencies {
  destination?:NotionDestinationScope;
  readText(path: string): Promise<string>;
  transport: NotionTransport;
}
export interface NotionSchemaCandidate {
  databaseId: string;
  dataSourceId: string;
  properties: {
    name: { id: string; type: 'title' };
    status: { id: string; type: 'select' };
    adminUrl: { id: string; type: 'url' };
  };
  statusOptions: {
    new: { id: string; name: '신규' };
    withdrawalRequested: { id: string; name: '탈퇴요청' };
  };
}
export interface NotionSchemaDiscoveryReport {
  mode: 'notion_schema_discovery';
  status: 'candidate_ready' | 'needs_token' | 'needs_review' | 'invalid_configuration';
  schema: 'candidate' | 'not_verified';
  identity: 'not_verified';
  externalWritesEnabled: false;
}
export function notionSchemaDiscoveryReport(status: NotionSchemaDiscoveryReport['status']): NotionSchemaDiscoveryReport {
  return { mode: 'notion_schema_discovery', status, schema: status === 'candidate_ready' ? 'candidate' : 'not_verified',
    identity: 'not_verified', externalWritesEnabled: false };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SCHEMA_REVIEW_REQUIRED');
  return value as Record<string, unknown>;
}
function sameId(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.replaceAll('-', '').toLowerCase() === expected.replaceAll('-', '').toLowerCase();
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new Error('SCHEMA_REVIEW_REQUIRED');
  return value;
}
/** No query, page, template, block or write endpoint can reach the supplied transport. */
export function restrictNotionSchemaTransport(transport: NotionTransport, destination:NotionDestinationScope): NotionTransport {
  destination=parseNotionDestination(destination);
  const routes = new Set([
    `${NOTION_API_ORIGIN}/v1/databases/${destination.databaseId}`,
    `${NOTION_API_ORIGIN}/v1/data_sources/${destination.dataSourceId}`,
  ]);
  return async request => {
    if (request.method !== 'GET' || request.body !== undefined || !routes.has(request.url)) throw new Error('SCHEMA_ROUTE_REJECTED');
    return transport(request);
  };
}
/** Pure parser: candidate metadata only. It cannot grant identity ownership or activate configuration. */
export function interpretNotionSchema(database: unknown, source: unknown, destination:NotionDestinationScope): NotionSchemaCandidate {
  destination=parseNotionDestination(destination);
  const db = record(database), data = record(source);
  if (!sameId(db.id, destination.databaseId) || !Array.isArray(db.data_sources)
    || db.data_sources.map(record).filter(item => sameId(item.id, destination.dataSourceId)).length !== 1
    || !sameId(data.id, destination.dataSourceId) || !sameId(record(data.parent).database_id, destination.databaseId)
    || record(data.parent).type !== 'database_id') throw new Error('SCHEMA_REVIEW_REQUIRED');
  const properties = Object.entries(record(data.properties)).map(([key, value]) => ({ key, value: record(value) }));
  const pick = <T extends 'title' | 'select' | 'url'>(name: string, type: T): { id: string; type: T } => {
    const matches = properties.filter(item => item.key === name || item.value.name === name);
    if (matches.length !== 1 || matches[0]!.key !== name || matches[0]!.value.name !== name || matches[0]!.value.type !== type) throw new Error('SCHEMA_REVIEW_REQUIRED');
    return { id: id(matches[0]!.value.id), type };
  };
  const name = pick('회원명', 'title'), status = pick('상태', 'select'), adminUrl = pick('어드민', 'url');
  if (new Set([name.id, status.id, adminUrl.id]).size !== 3) throw new Error('SCHEMA_REVIEW_REQUIRED');
  const statusValue = properties.find(item => item.key === '상태')!.value;
  const options = record(statusValue.select).options;
  if (!Array.isArray(options)) throw new Error('SCHEMA_REVIEW_REQUIRED');
  const actual = options.map(record);
  const option = <T extends '신규' | '탈퇴요청'>(expected: T): { id: string; name: T } => {
    const matches = actual.filter(item => item.name === expected);
    if (matches.length !== 1) throw new Error('SCHEMA_REVIEW_REQUIRED');
    const optionId = id(matches[0]!.id);
    if (actual.filter(item => item.id === optionId).length !== 1) throw new Error('SCHEMA_REVIEW_REQUIRED');
    return { id: optionId, name: expected };
  };
  return { databaseId: destination.databaseId, dataSourceId: destination.dataSourceId,
    properties: { name, status, adminUrl }, statusOptions: { new: option('신규'), withdrawalRequested: option('탈퇴요청') } };
}
/** The caller supplies the approved secret-file reader. No credential discovery, DB work, or worker dispatch. */
export async function discoverNotionSchema(options: { tokenFile: string; destination:NotionDestinationScope }, dependencies: NotionSchemaDependencies): Promise<{
  report: NotionSchemaDiscoveryReport; candidate?: NotionSchemaCandidate;
}> {
  let destination:NotionDestinationScope;try{destination=parseNotionDestination(options.destination);}catch{return{report:notionSchemaDiscoveryReport('invalid_configuration')};}
  if (!options.tokenFile || typeof options.tokenFile !== 'string') return { report: notionSchemaDiscoveryReport('invalid_configuration') };
  let token: string;
  try { token = (await dependencies.readText(options.tokenFile)).trim(); } catch { return { report: notionSchemaDiscoveryReport('needs_token') }; }
  if (!token || /[\r\n]/u.test(token)) return { report: notionSchemaDiscoveryReport('needs_token') };
  try {
    const client = new OfficialNotionClient({ token, transport: restrictNotionSchemaTransport(dependencies.transport,destination), readPermit: { approved: true }, maxRateLimitRetries: 0 });
    const database = await client.read(`/databases/${destination.databaseId}`);
    // Verify the fixed parent link before making the second and final request.
    if (!sameId(database.id, destination.databaseId) || !Array.isArray(database.data_sources)
      || database.data_sources.map(record).filter(item => sameId(item.id, destination.dataSourceId)).length !== 1) throw new Error('SCHEMA_REVIEW_REQUIRED');
    const source = await client.read(`/data_sources/${destination.dataSourceId}`);
    return { report: notionSchemaDiscoveryReport('candidate_ready'), candidate: interpretNotionSchema(database, source,destination) };
  } catch (error) { return { report: notionSchemaDiscoveryReport(error instanceof NotionHttpError && [401, 403].includes(error.status) ? 'needs_token' : 'needs_review') }; }
}
