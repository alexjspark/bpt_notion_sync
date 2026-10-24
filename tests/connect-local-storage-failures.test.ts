import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const { preparePrivateSecretWriter } = await import(new URL('../scripts/connect-local-storage.mjs', import.meta.url).href);
const SYNTHETIC_TOKEN = `ntn_${'synthetic_partial_failure_'.repeat(3)}`;
const SYNTHETIC_REPLACEMENT = `ntn_${'synthetic_must_not_replace_'.repeat(3)}`;
const INJECTED_ACL_FAILURE = 'SYNTHETIC_FINAL_ACL_REJECTED';

async function temporaryDirectory() {
  const prefix = resolve(tmpdir());
  const directory = await mkdtemp(join(prefix, 'trainer-sync-storage-failure-test-'));
  return {
    directory,
    async cleanup() {
      const target = resolve(directory);
      assert.equal(resolve(target, '..'), prefix);
      assert.ok(basename(target).startsWith('trainer-sync-storage-failure-test-'));
      await rm(target, { recursive: true, force: true });
    },
  };
}

test('final token ACL failure preserves both committed synthetic files and refuses retry or overwrite', async () => {
  const temp = await temporaryDirectory();
  try {
    const directory = join(temp.directory, 'private');
    const tokenPath = join(directory, 'notion-token.txt');
    const hmacPath = join(directory, 'preview-hmac.txt');
    let finalTokenChecks = 0;
    const writer = await preparePrivateSecretWriter({
      privateDirectory: directory,
      verifyPrivate: async (path: string) => {
        if (path === tokenPath) {
          finalTokenChecks++;
          throw new Error(INJECTED_ACL_FAILURE);
        }
      },
    });

    await assert.rejects(writer.persist(SYNTHETIC_TOKEN), { message: INJECTED_ACL_FAILURE });
    assert.equal(finalTokenChecks, 1);
    assert.deepEqual((await readdir(directory)).sort(), ['notion-token.txt', 'preview-hmac.txt']);
    const tokenBefore = await readFile(tokenPath, 'utf8');
    const hmacBefore = await readFile(hmacPath, 'utf8');
    assert.equal(tokenBefore, `${SYNTHETIC_TOKEN}\n`);
    assert.equal(Buffer.from(hmacBefore.trim(), 'base64url').length, 32);

    await assert.rejects(writer.persist(SYNTHETIC_REPLACEMENT), /SETUP_ALREADY_ATTEMPTED/);
    await assert.rejects(preparePrivateSecretWriter({ privateDirectory: directory, verifyPrivate: async () => {} }), /EXISTING_SECRET_PRESERVED/);
    assert.equal(finalTokenChecks, 1);
    assert.equal(await readFile(tokenPath, 'utf8'), tokenBefore);
    assert.equal(await readFile(hmacPath, 'utf8'), hmacBefore);
    assert.deepEqual((await readdir(directory)).sort(), ['notion-token.txt', 'preview-hmac.txt']);
  } finally { await temp.cleanup(); }
});

test('final HMAC ACL failure preserves only its committed synthetic file and refuses retry or overwrite', async () => {
  const temp = await temporaryDirectory();
  try {
    const directory = join(temp.directory, 'private');
    const tokenPath = join(directory, 'notion-token.txt');
    const hmacPath = join(directory, 'preview-hmac.txt');
    let finalHmacChecks = 0;
    let tokenPathChecked = false;
    const writer = await preparePrivateSecretWriter({
      privateDirectory: directory,
      verifyPrivate: async (path: string) => {
        if (path === tokenPath || path.startsWith(`${tokenPath}.setup-`)) tokenPathChecked = true;
        if (path === hmacPath) {
          finalHmacChecks++;
          throw new Error(INJECTED_ACL_FAILURE);
        }
      },
    });

    await assert.rejects(writer.persist(SYNTHETIC_TOKEN), { message: INJECTED_ACL_FAILURE });
    assert.equal(finalHmacChecks, 1);
    assert.equal(tokenPathChecked, false);
    assert.deepEqual(await readdir(directory), ['preview-hmac.txt']);
    const hmacBefore = await readFile(hmacPath, 'utf8');
    assert.equal(Buffer.from(hmacBefore.trim(), 'base64url').length, 32);

    await assert.rejects(writer.persist(SYNTHETIC_REPLACEMENT), /SETUP_ALREADY_ATTEMPTED/);
    await assert.rejects(preparePrivateSecretWriter({ privateDirectory: directory, verifyPrivate: async () => {} }), /EXISTING_SECRET_PRESERVED/);
    assert.equal(finalHmacChecks, 1);
    assert.equal(await readFile(hmacPath, 'utf8'), hmacBefore);
    assert.deepEqual(await readdir(directory), ['preview-hmac.txt']);
  } finally { await temp.cleanup(); }
});
