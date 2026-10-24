import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNotionReadOnly, restrictNotionCheckTransport } from '../scripts/notion-readonly-check.ts';
import type { NotionReadOnlyDependencies } from '../scripts/notion-readonly-check.ts';
import { runNotionReadOnlyCommand } from '../scripts/check-notion-readonly.ts';
import type { NotionRequest, NotionResponse, NotionTransport } from '../packages/engine/src/live-notion-client.ts';

// Every file and response in this suite is synthetic and supplied through DI.
// The default mount names below are virtual reader keys, never filesystem reads.
const databaseId = '11111111-1111-4111-8111-111111111111';
const dataSourceId = '22222222-2222-4222-8222-222222222222';
const trainerId = 'trainer-live-one';
const configFile = '/virtual/notion-check/config.json';
const tokenFile = '/virtual/notion-check/token';
const origin = 'https://api.notion.com/v1';
const databaseUrl = `${origin}/databases/${databaseId}`;
const sourceUrl = `${origin}/data_sources/${dataSourceId}`;
const queryUrl = `${sourceUrl}/query`;
const privateToken = 'SYNTHETIC_TOKEN_NEVER_PRINT';
const privateBody = 'SYNTHETIC_PRIVATE_RESPONSE_NEVER_PRINT';
const privateError = 'SYNTHETIC_RAW_ERROR_NEVER_PRINT';
const configuration = () => ({ version: 1, trainerId, notion: { members: {
  databaseId, dataSourceId, allowedTrainerIds: [trainerId],
  identity: { mode: 'exclusive-data-source-admin-url', trainerId, exclusiveOwnershipApproved: true,
    adminUrl: { id: 'admin', type: 'url' }, adminOrigin: 'https://admin.biz-pt.com', memberPathPrefix: '/manage/members/' },
  name: { id: 'name', type: 'title' }, status: { id: 'status', type: 'select' }, statuses: {}, createStatus: {},
} } });
function page(member = 'SYNTHETIC_MEMBER_A', id = 'synthetic-page-a') {
  return { object: 'page', id, parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: { Admin: { id: 'admin', type: 'url', url: `https://admin.biz-pt.com/manage/members/${member}` },
      Name: { id: 'name', type: 'title', title: [{ type: 'text', text: { content: privateBody } }] },
      Status: { id: 'status', type: 'select', select: null } } };
}
function response(request: NotionRequest): NotionResponse {
  if (request.method === 'GET' && request.url === databaseUrl) return { status: 200, body: { data_sources: [{ id: dataSourceId }] } };
  if (request.method === 'GET' && request.url === sourceUrl) return { status: 200, body: { properties: {
    Admin: { id: 'admin', type: 'url' }, Name: { id: 'name', type: 'title' },
    Status: { id: 'status', type: 'select', select: { options: [] } },
  } } };
  if (request.method === 'POST' && request.url === queryUrl) return { status: 200, body: { results: [page()], has_more: false, next_cursor: null } };
  assert.fail('UNEXPECTED_SYNTHETIC_TRANSPORT_REQUEST');
}
interface HarnessOptions {
  config?: unknown; configText?: string; token?: string; configPath?: string; tokenPath?: string;
  respond?: (request: NotionRequest, queryPass: number) => NotionResponse | Promise<NotionResponse>;
  readFailure?: 'config' | 'token';
}
function harness(options: HarnessOptions = {}) {
  const reads: string[] = [], requests: NotionRequest[] = [];
  const configPath = options.configPath ?? configFile, tokenPath = options.tokenPath ?? tokenFile;
  let queryPass = 0;
  const dependencies: NotionReadOnlyDependencies = {
    readText: async path => {
      reads.push(path);
      if (path === configPath) {
        if (options.readFailure === 'config') throw new Error(`${privateError}:${privateToken}`);
        return options.configText ?? JSON.stringify(options.config ?? configuration());
      }
      if (path === tokenPath) {
        if (options.readFailure === 'token') throw new Error(`${privateError}:${privateToken}`);
        return options.token ?? privateToken;
      }
      throw new Error('UNEXPECTED_VIRTUAL_FILE_READ');
    },
    transport: async request => {
      requests.push(structuredClone(request));
      if (request.url === queryUrl) queryPass++;
      return options.respond ? options.respond(request, queryPass) : response(request);
    },
  };
  return { dependencies, reads, requests, get queryPasses() { return queryPass; } };
}
function assertReport(report: unknown, status: string) {
  assert.ok(report && typeof report === 'object');
  const value = report as Record<string, unknown>;
  assert.deepEqual(Object.keys(value).sort(), ['externalWritesEnabled', 'identity', 'mode', 'permissions', 'schema', 'status']);
  assert.equal(value.mode, 'notion_readonly_check');
  assert.equal(value.status, status);
  assert.equal(value.externalWritesEnabled, false);
  for (const key of ['permissions', 'schema', 'identity']) assert.ok(['passed', 'not_verified'].includes(String(value[key])));
  if (status === 'passed') for (const key of ['permissions', 'schema', 'identity']) assert.equal(value[key], 'passed');
  const publicText = JSON.stringify(value);
  for (const secret of [privateToken, privateBody, privateError, 'SYNTHETIC_MEMBER_A', 'synthetic-page-a']) assert.equal(publicText.includes(secret), false);
}

test('read-only check validates schema and two complete matching identity passes without writes or extra file access', async () => {
  const h = harness();
  assertReport(await checkNotionReadOnly({ configFile, tokenFile }, h.dependencies), 'passed');
  assert.deepEqual(h.reads, [configFile, tokenFile]);
  assert.equal(h.queryPasses, 2);
  assert.equal(h.requests.length, 6);
  assert.deepEqual(h.requests.map(request => [request.method, request.url]), [
    ['GET', databaseUrl], ['GET', sourceUrl], ['POST', queryUrl],
    ['GET', databaseUrl], ['GET', sourceUrl], ['POST', queryUrl],
  ]);
  assert.ok(h.requests.every(request => request.method === 'POST' || request.body === undefined));
});

test('shared company configuration is ignored and neither company nor HMAC paths are read', async () => {
  const config = { ...configuration(), company: { profile: { deliberatelyUnverified: true }, binding: { deliberatelyUnverified: true } } };
  const h = harness({ config });
  assertReport(await checkNotionReadOnly({ configFile, tokenFile }, h.dependencies), 'passed');
  assert.deepEqual(h.reads, [configFile, tokenFile]);
  assert.ok(h.requests.every(request => request.url.startsWith(`${origin}/`)));
});

test('missing and blank tokens require a key without transport access or raw reader errors', async () => {
  for (const options of [{ readFailure: 'token' as const }, { token: ' \r\n\t ' }]) {
    const h = harness(options);
    assertReport(await checkNotionReadOnly({ configFile, tokenFile }, h.dependencies), 'needs_token');
    assert.deepEqual(h.reads, [configFile, tokenFile]);
    assert.equal(h.requests.length, 0);
  }
});

test('403 permission denial exposes only a fixed public report', async () => {
  const h = harness({ respond: () => ({ status: 403, body: { code: 'restricted_resource', message: `${privateBody}:${privateToken}` } }) });
  assertReport(await checkNotionReadOnly({ configFile, tokenFile }, h.dependencies), 'needs_token');
  assert.equal(h.requests.length, 1);
});

test('schema mismatch, duplicate identity and membership churn each block verification', async () => {
  const cases: HarnessOptions[] = [
    { respond: request => request.url === sourceUrl ? { status: 200, body: { properties: {} } } : response(request) },
    { respond: request => request.url === queryUrl ? { status: 200, body: { results: [page(), page('SYNTHETIC_MEMBER_A', 'synthetic-page-b')], has_more: false, next_cursor: null } } : response(request) },
    { respond: (request, pass) => request.url === queryUrl ? { status: 200, body: { results: [page(pass === 1 ? 'SYNTHETIC_MEMBER_A' : 'SYNTHETIC_MEMBER_B')], has_more: false, next_cursor: null } } : response(request) },
  ];
  for (const options of cases) {
    const h = harness(options);
    assertReport(await checkNotionReadOnly({ configFile, tokenFile }, h.dependencies), 'needs_verification');
    assert.deepEqual(h.reads, [configFile, tokenFile]);
  }
});

test('transport exceptions containing credentials and member content never reach public output', async () => {
  const h = harness({ respond: () => { throw new Error(`${privateError}:${privateToken}:${privateBody}`); } });
  const result = await runNotionReadOnlyCommand([], { LIVE_READONLY_CONFIG_FILE: configFile, NOTION_TOKEN_FILE: tokenFile }, h.dependencies);
  assert.equal(result.exitCode, 1);
  assertReport(JSON.parse(result.output), 'needs_verification');
  for (const marker of [privateError, privateToken, privateBody]) assert.equal(result.output.includes(marker), false);
});

test('malicious or malformed configuration is rejected before any token read or API request', async () => {
  const wrongDatabase = configuration(); wrongDatabase.notion.members.databaseId = 'foreign-database';
  const wrongSource = configuration(); wrongSource.notion.members.dataSourceId = 'foreign-source';
  const wrongTenant = configuration(); wrongTenant.notion.members.allowedTrainerIds = ['trainer-other'];
  const wrongOrigin = configuration(); wrongOrigin.notion.members.identity.adminOrigin = 'https://foreign.example';
  const nestedSecret = configuration() as unknown as Record<string, unknown>;
  nestedSecret.company = { nested: { authorization: privateToken } };
  const template = configuration();
  (template.notion.members as unknown as Record<string, unknown>).template = { templateId: 'synthetic-write-template' };
  const cases: HarnessOptions[] = [
    { config: { ...configuration(), unexpected: privateBody } }, { config: nestedSecret },
    { config: wrongDatabase }, { config: wrongSource }, { config: wrongTenant }, { config: wrongOrigin }, { config: template },
    { configText: '{synthetic-invalid-json' }, { readFailure: 'config' },
  ];
  for (const options of cases) {
    const h = harness(options);
    assertReport(await checkNotionReadOnly({ configFile, tokenFile }, h.dependencies), 'invalid_configuration');
    assert.deepEqual(h.reads, [configFile]);
    assert.equal(h.requests.length, 0);
  }
});

test('CLI uses only declared default or environment paths and returns one JSON report', async () => {
  for (const env of [{}, { LIVE_READONLY_CONFIG_FILE: configFile, NOTION_TOKEN_FILE: tokenFile }]) {
    const expectedConfig = env.LIVE_READONLY_CONFIG_FILE ?? '/run/config/live-readonly.json';
    const expectedToken = env.NOTION_TOKEN_FILE ?? '/run/secrets/notion_token';
    const h = harness({ configPath: expectedConfig, tokenPath: expectedToken });
    const result = await runNotionReadOnlyCommand([], env, h.dependencies);
    assert.equal(result.exitCode, 0);
    assertReport(JSON.parse(result.output), 'passed');
    assert.deepEqual(h.reads, [expectedConfig, expectedToken]);
  }
});

test('unconfirmed ownership and example property placeholders fail before token access', async () => {
  const unconfirmed = configuration();
  (unconfirmed.notion.members.identity as unknown as Record<string, unknown>).exclusiveOwnershipApproved = false;
  const placeholder = configuration(); placeholder.notion.members.name.id = 'REPLACE_WITH_VERIFIED_TITLE_PROPERTY_ID';
  const missing = configuration(); missing.notion.members.status.id = '';
  for (const config of [unconfirmed, placeholder, missing]) {
    const h = harness({ config });
    assertReport(await checkNotionReadOnly({ configFile, tokenFile }, h.dependencies), 'invalid_configuration');
    assert.deepEqual(h.reads, [configFile]);
    assert.equal(h.requests.length, 0);
  }
});

test('unexpected CLI arguments are rejected before reading even virtual files', async () => {
  for (const args of [['--help'], ['--token', privateToken], ['unexpected']]) {
    const h = harness();
    const result = await runNotionReadOnlyCommand(args, {}, h.dependencies);
    assert.equal(result.exitCode, 1);
    assertReport(JSON.parse(result.output), 'invalid_configuration');
    assert.deepEqual(h.reads, []);
    assert.equal(h.requests.length, 0);
    assert.equal(result.output.includes(privateToken), false);
  }
});

test('transport guard allows only the three exact approved read endpoints', async () => {
  const forwarded: NotionRequest[] = [];
  const inner: NotionTransport = async request => { forwarded.push(request); return { status: 200, body: {} }; };
  const guarded = restrictNotionCheckTransport(inner, databaseId, dataSourceId);
  for (const request of [
    { method: 'GET', url: databaseUrl, headers: {} }, { method: 'GET', url: sourceUrl, headers: {} },
    { method: 'POST', url: queryUrl, headers: {}, body: { page_size: 100 } },
  ] satisfies NotionRequest[]) await guarded(request);
  assert.equal(forwarded.length, 3);
});

test('transport guard rejects mutation, other resources, credentials, queries and wrong methods before forwarding', async () => {
  let forwarded = 0;
  const guarded = restrictNotionCheckTransport(async () => { forwarded++; return { status: 200, body: {} }; }, databaseId, dataSourceId);
  const invalid: Array<{ method: string; url: string; body?: unknown }> = [
    { method: 'POST', url: `${origin}/pages`, body: {} }, { method: 'PATCH', url: `${origin}/pages/synthetic-page`, body: {} },
    { method: 'PATCH', url: `${origin}/blocks/synthetic-block`, body: {} }, { method: 'GET', url: `${origin}/pages/synthetic-page` },
    { method: 'GET', url: `${origin}/blocks/synthetic-block/children` }, { method: 'GET', url: `${origin}/databases/foreign-database` },
    { method: 'GET', url: `${origin}/data_sources/foreign-source` }, { method: 'POST', url: `${origin}/data_sources/foreign-source/query` },
    { method: 'GET', url: databaseUrl.replace('api.notion.com', 'foreign.example') },
    { method: 'GET', url: databaseUrl.replace('https://', 'https://synthetic-user@') },
    { method: 'GET', url: `${databaseUrl}?page_size=100` }, { method: 'GET', url: `${sourceUrl}#fragment` },
    { method: 'GET', url: databaseUrl, body: {} }, { method: 'GET', url: sourceUrl, body: null },
    { method: 'POST', url: databaseUrl }, { method: 'PATCH', url: sourceUrl }, { method: 'GET', url: queryUrl },
    { method: 'PATCH', url: queryUrl, body: {} }, { method: 'DELETE', url: queryUrl },
  ];
  for (const request of invalid) await assert.rejects(async () => { await guarded({ ...request, headers: {} } as NotionRequest); });
  assert.equal(forwarded, 0);
});

import { notionReadReviewCode } from '../packages/engine/src/live-runtime.ts';
import { NotionHttpError, NotionReviewRequiredError } from '../packages/engine/src/live-notion-client.ts';

test('read-only diagnostics accept only branded exact codes and never provider values', () => {
  assert.equal(notionReadReviewCode(new NotionReviewRequiredError('NOTION_DUPLICATE_MEMBER_ID')), 'NOTION_DUPLICATE_MEMBER_ID');
  assert.equal(notionReadReviewCode(new NotionReviewRequiredError(privateToken)), 'NOTION_READ_REVIEW_REQUIRED');
  assert.equal(notionReadReviewCode({ code: 'NOTION_DUPLICATE_MEMBER_ID', message: privateBody }), 'NOTION_READ_REVIEW_REQUIRED');
  assert.equal(notionReadReviewCode(new NotionHttpError(400, privateToken)), 'NOTION_HTTP_READ_FAILED');
  assert.equal(notionReadReviewCode(new Error(privateError)), 'NOTION_READ_REVIEW_REQUIRED');
});

test('optional diagnostic callback reports a schema failure without changing the fixed public report', async () => {
  const h = harness({ respond: request => request.url === sourceUrl ? { status: 200, body: { properties: {} } } : response(request) });
  const diagnostics: string[] = [];
  const report = await checkNotionReadOnly({ configFile, tokenFile }, { ...h.dependencies, onReview: code => { diagnostics.push(code); } });
  assertReport(report, 'needs_verification');
  assert.deepEqual(diagnostics, ['NOTION_SCHEMA_BINDING_MISSING']);
  assert.equal(JSON.stringify(diagnostics).includes(privateToken), false);
});
test('missing admin URL identity blocks verification with a fixed actionable reason', async () => {
  const invalidPage = page();
  (invalidPage.properties.Admin as unknown as Record<string, unknown>).url = null;
  const h = harness({ respond: request => request.url === queryUrl
    ? { status: 200, body: { results: [invalidPage], has_more: false, next_cursor: null } } : response(request) });
  const diagnostics: string[] = [];
  const report = await checkNotionReadOnly({ configFile, tokenFile }, { ...h.dependencies, onReview: code => { diagnostics.push(code); } });
  assertReport(report, 'needs_verification');
  assert.deepEqual(diagnostics, ['NOTION_ADMIN_URL_REQUIRED']);
  assert.equal(JSON.stringify(diagnostics).includes('SYNTHETIC_MEMBER_A'), false);
});