import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function shutdownProcess(code: number) {
  const moduleUrl = new URL('../scripts/company-browser-shutdown.mjs', import.meta.url).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createBrowserShutdown } from ${JSON.stringify(moduleUrl)};
    const shutdown = createBrowserShutdown({ closeServer() {}, sockets: new Set(), children: [], graceMs: 30_000 });
    shutdown.stop(${code});
    // No referenced handles remain, reproducing the early natural exit.
  `], { encoding: 'utf8', timeout: 5000 });
}

test('failed browser startup exits nonzero even before an unreferenced grace timer', () => {
  const result = shutdownProcess(1);
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('normal browser shutdown exits zero without waiting for the grace timer', () => {
  const result = shutdownProcess(0);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});
