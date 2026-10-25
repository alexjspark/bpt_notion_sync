import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEAM_LOGIN_CLIENT_SOURCE, TEAM_LOGIN_BUNDLE } from '../packages/engine/src/team-login-client.ts';

/** Asset compilation is allowed in Linux image builders, which need not expose /.dockerenv. */
export function assertPilotClientBuildContext(
  platform: NodeJS.Platform = process.platform,
  buildOnly: string | undefined = process.env.TEAM_CLIENT_BUILD_ONLY,
) {
  if (platform !== 'linux' || buildOnly !== 'true') throw Error('PILOT_BUILD_GATE_REQUIRED');
}

async function buildPilotClient() {
  assertPilotClientBuildContext();
  await build({ stdin: { contents: TEAM_LOGIN_CLIENT_SOURCE, resolveDir: '/usr/share', sourcefile: 'team-login.client.js' }, bundle: true, minify: true, platform: 'browser', format: 'esm', target: 'es2022', outfile: fileURLToPath(TEAM_LOGIN_BUNDLE), logLevel: 'silent', legalComments: 'inline', banner: { js: '/*! noVNC client; Mozilla Public License 2.0. Sources: /usr/share/novnc; copyright: /usr/share/doc/novnc/copyright; license: /usr/share/common-licenses/MPL-2.0. */' } });
  const bytes = await readFile(TEAM_LOGIN_BUNDLE);
  if (!bytes.length || bytes.length > 1024 * 1024) throw Error('PILOT_BUNDLE_SIZE_INVALID');
  console.log(JSON.stringify({ publicClientBundleBytes: bytes.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void buildPilotClient().catch(() => { console.error('PILOT_CLIENT_BUNDLE_BUILD_FAILED'); process.exitCode = 1; });
}