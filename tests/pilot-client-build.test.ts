import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPilotClientBuildContext } from '../scripts/build-team-client.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
function runScript(script: string, args: string[], flags: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { SystemRoot: process.env.SystemRoot ?? '', ...flags },
  });
}

test('authorized Linux asset builders do not require a Docker runtime filesystem marker', () => {
  assert.doesNotThrow(() => assertPilotClientBuildContext('linux', 'true'));
});

test('asset compilation still requires exact build-only authorization on Linux', () => {
  for (const flag of [undefined, '', 'false', 'TRUE', '1']) {
    assert.throws(() => assertPilotClientBuildContext('linux', flag), /PILOT_BUILD_GATE_REQUIRED/);
  }
  for (const platform of ['win32', 'darwin', 'freebsd'] as const) {
    assert.throws(() => assertPilotClientBuildContext(platform, 'true'), /PILOT_BUILD_GATE_REQUIRED/);
  }
});

test('the builder CLI denies a missing build approval before compiling assets', () => {
  const result = runScript('scripts/build-team-client.ts', [], {});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'PILOT_CLIENT_BUNDLE_BUILD_FAILED');
});

test('build-only authorization cannot start the pilot runtime', () => {
  const result = runScript('scripts/team-pilot-start.ts', ['ingress'], { TEAM_CLIENT_BUILD_ONLY: 'true' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), '{"code":"TEAM_PILOT_START_BLOCKED"}');
});