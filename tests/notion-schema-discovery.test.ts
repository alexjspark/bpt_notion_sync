import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverNotionSchema } from '../scripts/notion-schema-discovery.ts';
import { runNotionSchemaDiscoveryCommand } from '../scripts/discover-notion-schema.ts';
import { NOTION_API_VERSION } from '../packages/engine/src/live-notion-client.ts';
import type { NotionRequest, NotionResponse } from '../packages/engine/src/live-notion-client.ts';

const databaseId = '11111111-1111-4111-8111-111111111111';
const dataSourceId = '22222222-2222-4222-8222-222222222222';
const destination={databaseId,dataSourceId};
const databaseUrl = `https://api.notion.com/v1/databases/${databaseId}`;
const sourceUrl = `https://api.notion.com/v1/data_sources/${dataSourceId}`;
const tokenFile = '/virtual/schema-discovery/token';
const token = 'SYNTHETIC_SCHEMA_TOKEN_NEVER_PRINT';
const privateText = 'SYNTHETIC_PRIVATE_BODY_OR_ERROR_NEVER_PRINT';
const database = () => ({ object: 'database', id: databaseId, data_sources: [{ id: dataSourceId }] });
const source = () => ({ object: 'data_source', id: dataSourceId,
  parent: { type: 'database_id', database_id: databaseId },
  properties: {
    '회원명': { id: 'synthetic-title', name: '회원명', type: 'title', title: {} },
    '상태': { id: 'synthetic-status', name: '상태', type: 'select', select: { options: [
      { id: 'synthetic-new', name: '신규' }, { id: 'synthetic-request', name: '탈퇴요청' },
      { id: 'synthetic-other', name: '통화전 탈퇴 신청' },
    ] } },
    '어드민': { id: 'synthetic-admin', name: '어드민', type: 'url', url: {} },
  },
});
type Source = ReturnType<typeof source>;
type HarnessOptions = {
  token?: string; readFailure?: boolean;
  database?: unknown; source?: unknown;
  respond?: (request: NotionRequest) => NotionResponse | Promise<NotionResponse>;
};
function harness(options: HarnessOptions = {}) {
  const reads: string[] = [], requests: NotionRequest[] = [];
  return { reads, requests, dependencies: {destination,
    readText: async (path: string) => {
      reads.push(path); assert.equal(path, tokenFile);
      if (options.readFailure) throw new Error(`${privateText}:${token}`);
      return options.token ?? token;
    },
    transport: async (request: NotionRequest): Promise<NotionResponse> => {
      requests.push(structuredClone(request));
      if (options.respond) return options.respond(request);
      if (request.url === databaseUrl) return { status: 200, body: options.database ?? database() };
      if (request.url === sourceUrl) return { status: 200, body: options.source ?? source() };
      assert.fail('UNEXPECTED_SYNTHETIC_SCHEMA_REQUEST');
    },
  } };
}
function safeReport(result: Awaited<ReturnType<typeof discoverNotionSchema>>, status: string) {
  assert.equal(result.report.mode, 'notion_schema_discovery');
  assert.equal(result.report.status, status);
  assert.equal(result.report.schema, status === 'candidate_ready' ? 'candidate' : 'not_verified');
  assert.equal(result.report.identity, 'not_verified');
  assert.equal(result.report.externalWritesEnabled, false);
  assert.deepEqual(Object.keys(result.report).sort(), ['externalWritesEnabled', 'identity', 'mode', 'schema', 'status']);
  const output = JSON.stringify(result.report);
  for (const value of [token, privateText, tokenFile, 'synthetic-title', 'synthetic-admin', databaseId, dataSourceId]) assert.equal(output.includes(value), false);
  if (status !== 'candidate_ready') assert.equal(result.candidate, undefined);
}

test('schema discovery returns only a candidate from exact names, types and unique existing choices', async () => {
  const h = harness();
  const result = await discoverNotionSchema({ tokenFile,destination }, h.dependencies);
  safeReport(result, 'candidate_ready');
  assert.deepEqual(result.candidate, { databaseId, dataSourceId,
    properties: { name: { id: 'synthetic-title', type: 'title' }, status: { id: 'synthetic-status', type: 'select' }, adminUrl: { id: 'synthetic-admin', type: 'url' } },
    statusOptions: { new: { id: 'synthetic-new', name: '신규' }, withdrawalRequested: { id: 'synthetic-request', name: '탈퇴요청' } },
  });
  assert.deepEqual(h.reads, [tokenFile]);
  assert.deepEqual(h.requests.map(request => [request.method, request.url]), [['GET', databaseUrl], ['GET', sourceUrl]]);
  for (const request of h.requests) {
    assert.equal(request.body, undefined);
    assert.equal(request.headers.Authorization, `Bearer ${token}`);
    assert.equal(request.headers['Notion-Version'], NOTION_API_VERSION);
  }
});

test('missing or empty token never reaches any transport and reveals no reader error', async () => {
  for (const options of [{ readFailure: true }, { token: '' }, { token: ' \r\n\t ' }]) {
    const h = harness(options);
    safeReport(await discoverNotionSchema({ tokenFile,destination }, h.dependencies), 'needs_token');
    assert.equal(h.requests.length, 0);
  }
});

test('token and provider failures produce fixed reports without raw content or exceptions', async () => {
  for (const status of [401, 403]) {
    const h = harness({ respond: () => ({ status, body: { code: 'restricted_resource', message: `${privateText}:${token}` } }) });
    safeReport(await discoverNotionSchema({ tokenFile,destination }, h.dependencies), 'needs_token');
    assert.equal(h.requests.length, 1);
  }
  const h = harness({ respond: () => { throw new Error(`${privateText}:${token}`); } });
  safeReport(await discoverNotionSchema({ tokenFile,destination }, h.dependencies), 'needs_review');
});

test('approved database and data source identities and parent relationship must match', async () => {
  const cases = [
    { database: { ...database(), id: 'foreign-database' } },
    { database: { ...database(), data_sources: [{ id: 'foreign-source' }] } },
    { source: { ...source(), id: 'foreign-source' } },
    { source: { ...source(), parent: { type: 'database_id', database_id: 'foreign-database' } } },
  ];
  for (const options of cases) {
    const h = harness(options);
    safeReport(await discoverNotionSchema({ tokenFile,destination }, h.dependencies), 'needs_review');
    assert.ok(h.requests.every(request => request.method === 'GET' && [databaseUrl, sourceUrl].includes(request.url)));
  }
});

test('exact property names and types cannot be replaced with fuzzy names or another select type', async () => {
  const cases: unknown[] = [];
  for (const name of ['회원명', '상태', '어드민'] as const) {
    const changed = source();
    const properties = changed.properties as unknown as Record<string, unknown>;
    properties[`${name} `] = properties[name]; delete properties[name]; cases.push(changed);
  }
  cases.push({ ...source(), properties: { ...source().properties, '회원명': { ...source().properties['회원명'], type: 'rich_text' } } });
  cases.push({ ...source(), properties: { ...source().properties, '상태': { ...source().properties['상태'], type: 'status' } } });
  cases.push({ ...source(), properties: { ...source().properties, '어드민': { ...source().properties['어드민'], type: 'rich_text' } } });
  for (const changed of cases) {
    const h = harness({ source: changed }); safeReport(await discoverNotionSchema({ tokenFile,destination }, h.dependencies), 'needs_review');
  }
});

test('duplicate property identities or ambiguous exact-name matches cannot produce a binding', async () => {
  const duplicateId = source(); duplicateId.properties['어드민'].id = duplicateId.properties['회원명'].id;
  const duplicateName = source() as Source & { properties: Record<string, unknown> };
  duplicateName.properties['synthetic-alias'] = { id: 'synthetic-other-admin', name: '어드민', type: 'url', url: {} };
  for (const changed of [duplicateId, duplicateName]) {
    const h = harness({ source: changed }); safeReport(await discoverNotionSchema({ tokenFile,destination }, h.dependencies), 'needs_review');
  }
});

test('required status choices are exact, unique and have actual nonempty IDs', async () => {
  const variants = [
    [{ id: 'synthetic-new', name: '신규' }, { id: 'synthetic-request', name: '탈퇴 요청' }],
    [{ id: 'synthetic-new', name: '신규' }, { id: 'synthetic-request', name: '통화전 탈퇴 신청' }],
    [{ id: 'synthetic-new', name: '신규' }, { id: 'synthetic-new-again', name: '신규' }, { id: 'synthetic-request', name: '탈퇴요청' }],
    [{ id: 'synthetic-new', name: '신규' }, { id: 'synthetic-request', name: '탈퇴요청' }, { id: 'synthetic-request-again', name: '탈퇴요청' }],
    [{ id: '', name: '신규' }, { id: 'synthetic-request', name: '탈퇴요청' }],
    [{ id: 'synthetic-new', name: '신규' }, { id: '', name: '탈퇴요청' }],
    [{ id: 'synthetic-same', name: '신규' }, { id: 'synthetic-same', name: '탈퇴요청' }],
  ];
  for (const options of variants) {
    const changed = source(); changed.properties['상태'].select.options = options;
    const h = harness({ source: changed }); safeReport(await discoverNotionSchema({ tokenFile,destination }, h.dependencies), 'needs_review');
  }
});

test('unrelated schema labels and unknown choices are never copied into candidate or public output', async () => {
  const changed = source() as Source & { properties: Record<string, unknown> };
  changed.properties[privateText] = { id: 'synthetic-private-extra', name: privateText, type: 'rich_text', rich_text: {} };
  changed.properties['상태'].select.options.push({ id: 'synthetic-unknown', name: privateText });
  const h = harness({ source: changed });
  const result = await discoverNotionSchema({ tokenFile,destination }, h.dependencies);
  safeReport(result, 'candidate_ready');
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.deepEqual(Object.keys(result.candidate!.statusOptions).sort(), ['new', 'withdrawalRequested']);
});

test('schema CLI rejects arguments without reads and prints only a fixed report, never its candidate', async () => {
  const h = harness();
  const result = await runNotionSchemaDiscoveryCommand([], { NOTION_TOKEN_FILE: tokenFile }, h.dependencies);
  assert.equal(result.exitCode, 0);
  safeReport({ report: JSON.parse(result.output), candidate: result.candidate }, 'candidate_ready');
  assert.ok(result.candidate);
  for (const value of [token, privateText, tokenFile, databaseId, dataSourceId, 'synthetic-title', 'synthetic-new']) assert.equal(result.output.includes(value), false);
  for (const args of [['--token', token], ['--help']]) {
    const rejected = harness();
    const invalid = await runNotionSchemaDiscoveryCommand(args, { NOTION_TOKEN_FILE: tokenFile }, rejected.dependencies);
    assert.equal(invalid.exitCode, 1);
    safeReport({ report: JSON.parse(invalid.output), candidate: invalid.candidate }, 'invalid_configuration');
    assert.deepEqual(rejected.reads, []);
    assert.equal(rejected.requests.length, 0);
    assert.equal(invalid.output.includes(token), false);
  }
});
