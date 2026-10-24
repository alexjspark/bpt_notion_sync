import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { persistNotionSchemaCandidate, runNotionSchemaDiscoveryCommand } from '../scripts/discover-notion-schema.ts';
const databaseId='11111111-1111-4111-8111-111111111111',dataSourceId='22222222-2222-4222-8222-222222222222';

const name = '\ud68c\uc6d0\uba85', status = '\uc0c1\ud0dc', admin = '\uc5b4\ub4dc\ubbfc';
const newStatus = '\uc2e0\uaddc', requested = '\ud0c8\ud1f4\uc694\uccad';
const syntheticToken = 'SYNTHETIC_AUTH_ONLY_NEVER_PRINT';
const rawExtra = 'SYNTHETIC_UNRELATED_METADATA_NEVER_EXPORT';
async function cleanup(directory: string) {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  assert.ok(directory.includes('trainer-schema-'));
  await rm(directory, { recursive: true, force: true });
}
function harness() {
  const reads: string[] = [], writes: { name: string; contents: string }[] = [];
  const dependencies = {destination:{databaseId,dataSourceId},
    readText: async (path: string) => { reads.push(path); return syntheticToken; },
    writeCandidate: async (name: string, contents: string) => { writes.push({ name, contents }); },
    transport: async (request: { url: string }) => ({ status: 200, body: request.url.includes('/databases/')
      ? { id: databaseId, data_sources: [{ id: dataSourceId }] }
      : { id: dataSourceId, parent: { type: 'database_id', database_id: databaseId }, properties: {
        [name]: { id: 'synthetic-name', name, type: 'title' },
        [status]: { id: 'synthetic-status', name: status, type: 'select', select: { options: [
          { id: 'synthetic-new', name: newStatus }, { id: 'synthetic-request', name: requested },
          { id: 'synthetic-other', name: rawExtra },
        ] } },
        [admin]: { id: 'synthetic-admin', name: admin, type: 'url' },
        [rawExtra]: { id: 'synthetic-private', name: rawExtra, type: 'rich_text' },
      } } }),
  };
  return { reads, writes, dependencies };
}

test('candidate export retains only reviewed metadata and cannot approve identity or writes', async () => {
  const h = harness();
  const result = await runNotionSchemaDiscoveryCommand([], { NOTION_TOKEN_FILE: '/virtual/token', NOTION_SCHEMA_CANDIDATE_NAME: 'schema-candidate.json' }, h.dependencies);
  assert.equal(result.exitCode, 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]!.name, 'schema-candidate.json');
  const document = JSON.parse(h.writes[0]!.contents);
  assert.deepEqual(Object.keys(document).sort(), ['candidate', 'report', 'version']);
  assert.equal(document.report.identity, 'not_verified');
  assert.equal(document.report.externalWritesEnabled, false);
  assert.equal(document.candidate.properties.adminUrl.id, 'synthetic-admin');
  assert.equal(document.candidate.exclusiveOwnershipApproved, undefined);
  for (const text of [syntheticToken, rawExtra, '/virtual/token']) {
    assert.equal(h.writes[0]!.contents.includes(text), false);
    assert.equal(result.output.includes(text), false);
  }
  for (const text of [databaseId, dataSourceId, 'synthetic-admin', 'schema-candidate.json']) assert.equal(result.output.includes(text), false);
});

test('invalid candidate destinations and absent writer fail before authentication', async () => {
  for (const candidateName of ['', '../token.json', 'nested/file.json', 'C:\\private\\token.json', '.hidden.json', 'x.txt', 'A.json', 'con.json', 'nul.other.json', 'com1.json', 'lpt9.json', 'a'.repeat(80) + '.json']) {
    const h = harness();
    const result = await runNotionSchemaDiscoveryCommand([], { NOTION_SCHEMA_CANDIDATE_NAME: candidateName }, h.dependencies);
    assert.equal(JSON.parse(result.output).status, 'invalid_configuration');
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.writes, []);
  }
  const h = harness();
  const { writeCandidate: omitted, ...withoutWriter } = h.dependencies;
  const result = await runNotionSchemaDiscoveryCommand([], { NOTION_SCHEMA_CANDIDATE_NAME: 'candidate.json' }, withoutWriter);
  assert.equal(JSON.parse(result.output).status, 'invalid_configuration');
  assert.deepEqual(h.reads, []);
});

test('candidate persistence errors expose only a fixed report and no candidate', async () => {
  const h = harness();
  const result = await runNotionSchemaDiscoveryCommand([], { NOTION_SCHEMA_CANDIDATE_NAME: 'candidate.json' }, {
    ...h.dependencies, writeCandidate: async () => { throw new Error(syntheticToken + ':' + rawExtra); },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.output).status, 'needs_review');
  assert.equal(result.candidate, undefined);
  assert.equal(result.output.includes(syntheticToken), false);
  assert.equal(result.output.includes(rawExtra), false);
});

test('candidate file persistence preserves an existing file without overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trainer-schema-candidate-'));
  try {
    await persistNotionSchemaCandidate('candidate.json', '{"version":1}\n', directory);
    await assert.rejects(persistNotionSchemaCandidate('candidate.json', 'replacement', directory));
    assert.equal(await readFile(join(directory, 'candidate.json'), 'utf8'), '{"version":1}\n');
    await assert.rejects(persistNotionSchemaCandidate('../escape.json', 'metadata', directory));
    await symlink(join(directory, 'candidate.json'), join(directory, 'alias.json'), 'file');
    await assert.rejects(persistNotionSchemaCandidate('alias.json', 'replacement', directory));
    assert.equal(await readFile(join(directory, 'candidate.json'), 'utf8'), '{"version":1}\n');
  } finally { await cleanup(directory); }
});

test('candidate persistence rejects an existing directory symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trainer-schema-link-'));
  try {
    const destination = join(directory, 'real'), linked = join(directory, 'linked');
    await persistNotionSchemaCandidate('existing.json', 'metadata', destination);
    await symlink(destination, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(persistNotionSchemaCandidate('candidate.json', 'metadata', linked));
  } finally { await cleanup(directory); }
});
