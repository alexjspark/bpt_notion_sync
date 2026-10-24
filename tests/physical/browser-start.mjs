import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { companyCdpUpgradeRequest } from '../../scripts/company-browser-cdp-upgrade.mjs';
import { classifyBrowserStartupFailure } from '../../scripts/company-browser-diagnostics.mjs';
import { createBrowserShutdown } from '../../scripts/company-browser-shutdown.mjs';

if(process.env.TEAM_PHYSICAL_TEST_ONLY!=='true'||!/^[a-f0-9-]{36}$/.test(process.env.TEAM_TEST_RUN_ID??''))throw Error('PHYSICAL_TEST_SCOPE_REQUIRED');
const internalHost=process.env.TEAM_BROWSER_INTERNAL_HOST??'company-browser';
if(!/^ts-team-browser-[a-f0-9]{32}$/.test(internalHost))throw Error('COMPANY_INTERNAL_HOST_INVALID');
const profile = '/var/lib/trainer-sync/company-profile';
const profileStat = statSync(profile);
if (profileStat.uid !== process.getuid() || (profileStat.mode & 0o077) !== 0) {
  console.error('COMPANY_PROFILE_NOT_PRIVATE');
  process.exit(1);
}
// These preferences are created only for the new, dedicated profile. No existing
// user profile or credentials are inspected or copied.
const defaultDirectory = `${profile}/Default`;
const preferences = `${defaultDirectory}/Preferences`;
if (!existsSync(preferences)) {
  mkdirSync(defaultDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(preferences, JSON.stringify({
    credentials_enable_service: false,
    profile: { password_manager_enabled: false },
    autofill: { profile_enabled: false, credit_card_enabled: false },
  }), { flag: 'wx', mode: 0o600 });
}

const chromiumDirectory = readdirSync('/ms-playwright').find(name => /^chromium-\d+$/.test(name));
const chromium = chromiumDirectory && [
  `/ms-playwright/${chromiumDirectory}/chrome-linux64/chrome`,
  `/ms-playwright/${chromiumDirectory}/chrome-linux/chrome`,
].find(existsSync);
if (!chromium) { console.error('COMPANY_BROWSER_BINARY_NOT_FOUND'); process.exit(1); }

let browserChild;
const children = [];
const sockets = new Set();
const shutdown = createBrowserShutdown({ closeServer: () => cdpProxy.close(), sockets, children, getBrowser: () => browserChild, onDiagnostic: code => console.error(JSON.stringify({ code })) });
const stop = shutdown.stop;
function start(command, args, browserDiagnostics = false) {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', browserDiagnostics ? 'pipe' : 'ignore'], env: process.env });
  let startupStderr = '';
  if (browserDiagnostics) child.stderr.on('data', chunk => {
    // Bounded memory only; the raw text is never logged or written to disk.
    if (startupStderr.length < 8192) startupStderr += chunk.toString().slice(0, 8192 - startupStderr.length);
  });
  children.push(child);
  child.on('error', () => {
    console.error(browserDiagnostics ? 'COMPANY_BROWSER_STARTUP_FAILED' : 'COMPANY_DISPLAY_SERVICE_FAILED');
    startupStderr = '';
    stop(1);
  });
  child.on('exit', (exitCode, signal) => {
    if (!shutdown.isStopping()) {
      if (browserDiagnostics) console.error(JSON.stringify({ code: 'COMPANY_BROWSER_STARTUP_FAILED', exitCode: Number.isInteger(exitCode) ? exitCode : null, signal: ['SIGKILL','SIGTERM','SIGABRT','SIGSEGV'].includes(signal) ? signal : null, observedFragments: classifyBrowserStartupFailure(startupStderr) }));
      else console.error('COMPANY_DISPLAY_SERVICE_FAILED');
      startupStderr = '';
      stop(1);
    }
  });
  return child;
}
// Chromium itself remains loopback-only. This explicit proxy is internal to
// the Docker networks; Compose publishes neither its port nor the VNC port.
const cdpProxy = createServer((incoming, outgoing) => {
  if (incoming.method !== 'GET' || !/^\/json\/version\/?$/.test(incoming.url ?? '')) {
    outgoing.writeHead(404).end(); return;
  }
  // Chromium rejects non-IP Host headers. Never forward an arbitrary client Host.
  const upstream = request({ host: '127.0.0.1', port: 9223, path: '/json/version', headers: { Host: '127.0.0.1:9223' } }, response => {
    let body = '';
    response.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) { upstream.destroy(); outgoing.destroy(); }
    });
    response.on('end', () => {
      try {
        const version = JSON.parse(body);
        const remote = new URL(version.webSocketDebuggerUrl);
        version.webSocketDebuggerUrl = `ws://${internalHost}:9222${remote.pathname}`;
        outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(version));
      } catch { outgoing.writeHead(502).end(); }
    });
  });
  upstream.on('error', () => outgoing.writeHead(502).end());
  upstream.end();
});
cdpProxy.on('upgrade', (incoming, client, head) => {
  if (!/^\/devtools\/(browser|page)\/[a-zA-Z0-9-]+$/.test(incoming.url ?? '')) { client.destroy(); return; }
  const target = connect(9223, '127.0.0.1');
  sockets.add(client); sockets.add(target);
  target.on('connect', () => {
    target.write(companyCdpUpgradeRequest(incoming.url, incoming.headers));
    if (head.length) target.write(head);
    client.pipe(target); target.pipe(client);
  });
  for (const socket of [client, target]) {
    socket.on('error', () => { client.destroy(); target.destroy(); });
    socket.on('close', () => { sockets.delete(socket); client.destroy(); target.destroy(); });
  }
});
cdpProxy.on('error', () => stop(1));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop());

start('Xvfb', [':99', '-screen', '0', '1600x1000x24', '-nolisten', 'tcp']);
for (let attempt = 0; !existsSync('/tmp/.X11-unix/X99'); attempt++) {
  if (attempt >= 50) { stop(1); throw new Error('COMPANY_DISPLAY_UNAVAILABLE'); }
  await delay(100);
}
start('x11vnc', ['-display', ':99', '-listen', '127.0.0.1', '-rfbport', '5900', '-nopw', '-forever', '-shared', '-nosel', '-nobell']);
start('websockify', ['0.0.0.0:6080', '127.0.0.1:5900']);
browserChild = start(chromium, [
  `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9223',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--password-store=basic',
  '--disable-save-password-bubble', '--disable-features=AutofillServerCommunication,PasswordManagerOnboarding',
  '--proxy-server=http://ts-team-egress:3128','--disable-quic','--dns-prefetch-disable',
  '--window-size=1600,1000', '--window-position=0,0',
  'about:blank',
], true);
cdpProxy.listen(9222, '0.0.0.0');
