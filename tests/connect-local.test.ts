import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';

const { createConnectionInputServer, validNotionToken } = await import(new URL('../scripts/connect-local-server.mjs', import.meta.url).href);
const { isPrivateAclReport, preparePrivateSecretWriter } = await import(new URL('../scripts/connect-local-storage.mjs', import.meta.url).href);
const SYNTHETIC_TOKEN = `ntn_${'synthetic_only_'.repeat(4)}`;

async function setupServer(persist: (token: string) => Promise<void>, callbacks: Record<string, () => void> = {}) {
  const input = createConnectionInputServer({ persist, port: 0, ...callbacks });
  const { url, origin } = await input.listen();
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const html = await response.text();
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    assert.ok(csrf);
    return { ...input, get state() { return input.state; }, url, origin, csrf, response, html };
  } catch (error) { await stop(input); throw error; }
}

async function stop(input: { server: import('node:http').Server }) {
  input.server.closeAllConnections();
  if (input.server.listening) await new Promise<void>((done) => input.server.close(() => done()));
}

function requestOptions(origin: string, csrf: string, additional: Record<string, string> = {}) {
  return { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, notionToken: SYNTHETIC_TOKEN, ...additional }) };
}

async function temporaryDirectory() {
  const prefix = resolve(tmpdir());
  const directory = await mkdtemp(join(prefix, 'trainer-sync-connection-test-'));
  return { directory, async cleanup() {
    const target = resolve(directory);
    assert.equal(resolve(target, '..'), prefix);
    assert.ok(basename(target).startsWith('trainer-sync-connection-test-'));
    await rm(target, { recursive: true, force: true });
  } };
}

test('connection entry validates bounded token characters without transforming the key', () => {
  assert.equal(validNotionToken(SYNTHETIC_TOKEN), true);
  for (const input of [null, '', 'short', 'x'.repeat(513), `${SYNTHETIC_TOKEN}\n`, ` ${SYNTHETIC_TOKEN}`, '<script>not-a-key</script>', '한글'.repeat(30)]) assert.equal(validNotionToken(input), false);
});

test('private ACL check rejects broad groups, capability SIDs, untrusted owners and reparse points', () => {
  const currentSid = 'S-1-5-21-111-222-333-1001';
  const base = { currentSid, ownerSid: currentSid, reparsePoint: false, rules: [
    { sid: currentSid, access: 'Allow' }, { sid: 'S-1-5-18', access: 'Allow' }, { sid: 'S-1-5-32-544', access: 'Allow' },
  ] };
  assert.equal(isPrivateAclReport(base), true);
  for (const sid of ['S-1-1-0', 'S-1-5-32-545', 'S-1-15-3-123-456', 'S-1-5-21-111-222-333-1002']) assert.equal(isPrivateAclReport({ ...base, rules: [...base.rules, { sid, access: 'Allow' }] }), false);
  assert.equal(isPrivateAclReport({ ...base, ownerSid: 'S-1-1-0' }), false);
  assert.equal(isPrivateAclReport({ ...base, reparsePoint: true }), false);
  assert.equal(isPrivateAclReport({ ...base, rules: [{ sid: 'S-1-5-18', access: 'Allow' }] }), false);
  assert.equal(isPrivateAclReport({ ...base, rules: [...base.rules, { sid: 'S-1-1-0', access: 'Deny' }] }), true);
});

test('connection page uses loopback binding, masked input and restrictive no-store headers', async () => {
  const input = await setupServer(async () => { throw new Error('Unexpected write'); });
  try {
    assert.equal(input.server.address().address, '127.0.0.1');
    assert.equal(input.response.status, 200);
    assert.match(input.response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(input.response.headers.get('referrer-policy'), 'same-origin');
    assert.match(input.response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(input.html, /type="password"/);
    assert.doesNotMatch(input.html, /<script|https?:\/\/|ntn_synthetic/);
    assert.equal((await fetch(`${input.origin}/`)).status, 404);
    assert.equal((await fetch(`${input.url}?notionToken=${SYNTHETIC_TOKEN}`)).status, 404);
  } finally { await stop(input); }
});

test('connection entry rejects foreign origins, forged host, missing CSRF and unexpected fields', async () => {
  let calls = 0;
  const input = await setupServer(async () => { calls++; });
  try {
    const wrongOrigin = requestOptions('https://example.invalid', input.csrf);
    assert.equal((await fetch(input.url, wrongOrigin)).status, 403);
    assert.equal((await fetch(input.url, requestOptions('null', input.csrf))).status, 403);
    assert.equal((await fetch(input.url, { ...requestOptions(input.origin, input.csrf), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 403);
    const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(input.url, { method: 'POST', headers: { ...requestOptions(input.origin, input.csrf).headers, Host: 'example.invalid' } }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
      req.once('error', reject);
      req.end(requestOptions(input.origin, input.csrf).body.toString());
    });
    assert.equal(forgedHostStatus, 404);
    assert.equal((await fetch(input.url, requestOptions(input.origin, 'wrong'))).status, 400);
    assert.equal((await fetch(input.url, requestOptions(input.origin, input.csrf, { trainerId: 'other' }))).status, 400);
    const duplicate = new URLSearchParams({ csrf: input.csrf, notionToken: SYNTHETIC_TOKEN }); duplicate.append('notionToken', SYNTHETIC_TOKEN);
    assert.equal((await fetch(input.url, { ...requestOptions(input.origin, input.csrf), body: duplicate })).status, 400);
    assert.equal((await fetch(input.url, { ...requestOptions(input.origin, input.csrf), headers: { Origin: input.origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal(calls, 0);
  } finally { await stop(input); }
});

test('connection entry rejects oversized and malformed bodies before storage', async () => {
  let calls = 0;
  const input = await setupServer(async () => { calls++; });
  try {
    assert.equal((await fetch(input.url, requestOptions(input.origin, input.csrf, { notionToken: 'x'.repeat(3000) }))).status, 400);
    assert.equal((await fetch(input.url, requestOptions(input.origin, input.csrf, { notionToken: `${SYNTHETIC_TOKEN}\n` }))).status, 400);
    assert.equal(calls, 0);
  } finally { await stop(input); }
});

test('concurrent valid entries persist once, never echo the key, and close the listener', async () => {
  let calls = 0;
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const input = await setupServer(async (token) => { assert.equal(token, SYNTHETIC_TOKEN); calls++; entered(); await gate; });
  try {
    const first = fetch(input.url, requestOptions(input.origin, input.csrf));
    // Queue a second complete request while the first writer is awaiting its storage operation.
    await writing;
    const second = await fetch(input.url, requestOptions(input.origin, input.csrf));
    assert.equal(second.status, 409);
    unblock();
    const response = await first;
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(SYNTHETIC_TOKEN));
    assert.equal(calls, 1);
    assert.equal(input.server.listening, false);
  } finally { unblock(); await stop(input); }
});

test('uncertain storage failure is generic and closes input without retrying', async () => {
  let calls = 0;
  const input = await setupServer(async (token) => { calls++; throw new Error(`sensitive-error:${token}`); });
  try {
    const response = await fetch(input.url, requestOptions(input.origin, input.csrf));
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.ok(!body.includes(SYNTHETIC_TOKEN));
    assert.ok(!body.includes('sensitive-error'));
    assert.equal(calls, 1);
    assert.equal(input.server.listening, false);
  } finally { await stop(input); }
});

test('stop during storage preserves the active response and records saved before delivery', async () => {
  const events: string[] = [];
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const input = await setupServer(async () => { entered(); await gate; }, {
    onStorageStarted() { events.push('saving'); },
    onSaved() { events.push('saved'); },
  });
  try {
    const pending = fetch(input.url, requestOptions(input.origin, input.csrf));
    await writing;
    assert.equal(input.state, 'saving');
    const stopped = input.stop();
    assert.equal(input.server.listening, false);
    unblock();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /ntn_synthetic/);
    await stopped;
    assert.deepEqual(events, ['saving', 'saved']);
    assert.equal(input.state, 'saved');
  } finally { unblock(); await stop(input); }
});

test('stop during partial storage failure delivers generic failure and records uncertainty once', async () => {
  const events: string[] = [];
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const input = await setupServer(async () => { entered(); await gate; throw new Error('synthetic partial commit'); }, {
    onStorageStarted() { events.push('saving'); },
    onStorageFailure() { events.push('uncertain'); },
  });
  try {
    const pending = fetch(input.url, requestOptions(input.origin, input.csrf));
    await writing;
    const stopped = input.stop();
    unblock();
    const response = await pending;
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.ok(!body.includes('synthetic partial commit'));
    assert.ok(!body.includes(SYNTHETIC_TOKEN));
    await stopped;
    assert.deepEqual(events, ['saving', 'uncertain']);
    assert.equal(input.state, 'uncertain');
  } finally { unblock(); await stop(input); }
});

test('private writer preserves existing files and stores only synthetic token plus fresh HMAC', async () => {
  const temp = await temporaryDirectory();
  try {
    const checked: string[] = [];
    const writer = await preparePrivateSecretWriter({ privateDirectory: join(temp.directory, 'private'), verifyPrivate: async (path: string) => { checked.push(path); } });
    await writer.persist(SYNTHETIC_TOKEN);
    assert.equal(await readFile(writer.notionTokenPath, 'utf8'), `${SYNTHETIC_TOKEN}\n`);
    const hmac = (await readFile(writer.previewHmacPath, 'utf8')).trim();
    assert.equal(Buffer.from(hmac, 'base64url').length, 32);
    assert.ok(checked.includes(writer.notionTokenPath));
    assert.ok(checked.includes(writer.previewHmacPath));
    assert.deepEqual((await readdir(join(temp.directory, 'private'))).sort(), ['notion-token.txt', 'preview-hmac.txt']);
    await assert.rejects(writer.persist(SYNTHETIC_TOKEN), /SETUP_ALREADY_ATTEMPTED/);
    await assert.rejects(preparePrivateSecretWriter({ privateDirectory: join(temp.directory, 'private'), verifyPrivate: async () => {} }), /EXISTING_SECRET_PRESERVED/);
    assert.equal(await readFile(writer.notionTokenPath, 'utf8'), `${SYNTHETIC_TOKEN}\n`);
  } finally { await temp.cleanup(); }
});

test('private writer fails closed before accepting a key if the ACL cannot be verified', async () => {
  const temp = await temporaryDirectory();
  try {
    await assert.rejects(preparePrivateSecretWriter({ privateDirectory: join(temp.directory, 'private'), verifyPrivate: async () => { throw new Error('PRIVATE_PATH_ACL_REQUIRED'); } }), /PRIVATE_PATH_ACL_REQUIRED/);
    assert.deepEqual(await readdir(join(temp.directory, 'private')), []);
  } finally { await temp.cleanup(); }
});
