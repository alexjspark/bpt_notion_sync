import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cookieName = 'ts_company_login';
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>회사 전용 로그인</title><link rel="stylesheet" href="/login.css"><header><strong>회사 자동화 전용 브라우저</strong><span>아래 공식 회사 화면에 직접 로그인하세요. 비밀번호는 앱에 입력하지 않습니다. 로그인 후 이 탭을 닫고 완료를 알려 주세요.</span><span id="status" role="status">브라우저 화면에 연결 중…</span></header><main id="screen"></main><script type="module" src="/login.js"></script></html>`;
const loginScript = `import RFB from '/novnc/core/rfb.js';
const status = document.getElementById('status');
const rfb = new RFB(document.getElementById('screen'), 'ws://' + location.host + '/websockify');
rfb.scaleViewport = true;
rfb.resizeSession = false;
rfb.addEventListener('connect', () => { status.textContent = '연결됨 · 공식 회사 로그인 화면에서 직접 입력하세요'; });
rfb.addEventListener('disconnect', () => { status.textContent = '화면 연결이 종료되었습니다. 로그인 상태는 전용 저장소에 보존됩니다.'; });
rfb.addEventListener('securityfailure', () => { status.textContent = '화면 연결 인증에 실패했습니다.'; });`;
const css = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#111827;color:#f9fafb}header{padding:12px 18px;display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center}header span{font-size:13px}#status{color:#a7f3d0}#screen{height:calc(100vh - 100px);min-height:400px;background:#111}`;
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function cookieValue(header) {
  if (typeof header !== 'string') return undefined;
  const cookies = header.split(';').map(part => part.trim().split('='));
  const matches = cookies.filter(([name]) => name === cookieName);
  return matches.length === 1 ? matches[0][1] : undefined;
}

/** HTTP and WebSocket authorization are both required; no browser data is read. */
export function createCompanyLoginGateway(options) {
  const bootstrapToken = options.bootstrapToken ?? randomBytes(32).toString('hex');
  const sessionToken = options.sessionToken ?? randomBytes(32).toString('hex');
  const bootstrapExpiresAt = (options.now ?? Date.now)() + 10 * 60_000;
  let sessionExpiresAt = 0;
  let consumed = false;
  const sockets = new Set();
  const origin = () => typeof options.origin === 'function' ? options.origin() : options.origin;
  const now = options.now ?? Date.now;
  const authenticated = req => now() < sessionExpiresAt && equal(cookieValue(req.headers.cookie), sessionToken);
  const expectedHost = () => new URL(origin()).host;
  function headers(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${origin().replace(/^http:/, 'ws:')}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  }
  const server = createServer(async (req, res) => {
    headers(res);
    if (req.headers.host !== expectedHost()) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
    const rawPath = req.url ?? '';
    if (rawPath.startsWith('/connect/')) {
      const presented = rawPath.slice('/connect/'.length);
      if (consumed || now() >= bootstrapExpiresAt || !equal(presented, bootstrapToken)) { res.writeHead(403).end(); return; }
      consumed = true;
      try { await options.onConsume?.(); }
      catch { res.writeHead(500).end('LOGIN_SESSION_UNAVAILABLE'); return; }
      sessionExpiresAt = now() + 60 * 60_000;
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': `${cookieName}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`,
      }).end();
      return;
    }
    if (!authenticated(req)) { res.writeHead(403).end('LOGIN_SESSION_REQUIRED'); return; }
    if (rawPath === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html); return; }
    if (rawPath === '/login.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(loginScript); return; }
    if (rawPath === '/login.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }).end(css); return; }
    if (!rawPath.startsWith('/novnc/') || rawPath.includes('?')) { res.writeHead(404).end(); return; }
    let suffix;
    try { suffix = decodeURIComponent(rawPath.slice('/novnc/'.length)); } catch { res.writeHead(400).end(); return; }
    if (suffix.includes('\0') || suffix.includes('\\')) { res.writeHead(400).end(); return; }
    const assetRoot = resolve(options.assetRoot ?? '/usr/share/novnc');
    const asset = resolve(assetRoot, suffix);
    if (!asset.startsWith(`${assetRoot}${sep}`)) { res.writeHead(403).end(); return; }
    const mime = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }[extname(asset)];
    if (!mime) { res.writeHead(404).end(); return; }
    try { const data = await readFile(asset); res.writeHead(200, { 'Content-Type': mime }).end(data); }
    catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.method !== 'GET' || req.url !== '/websockify' || req.headers.host !== expectedHost() || req.headers.origin !== origin() || !authenticated(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = connect(options.upstreamPort ?? 6080, options.upstreamHost ?? 'company-browser');
    sockets.add(socket); sockets.add(upstream);
    upstream.on('connect', () => {
      const safeNames = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol'];
      const forwarded = safeNames.filter(name => typeof req.headers[name] === 'string')
        .map(name => `${name}: ${req.headers[name]}`).join('\r\n');
      upstream.write(`GET / HTTP/1.1\r\nHost: company-browser:${options.upstreamPort ?? 6080}\r\n${forwarded}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    for (const connection of [socket, upstream]) {
      connection.on('error', () => { socket.destroy(); upstream.destroy(); });
      connection.on('close', () => { sockets.delete(connection); socket.destroy(); upstream.destroy(); });
    }
  });
  return {
    server,
    bootstrapUrl: () => `${origin()}/connect/${bootstrapToken}`,
    bootstrapExpiresAt,
    close: () => { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}

async function main() {
  const origin = process.env.COMPANY_LOGIN_ORIGIN ?? 'http://127.0.0.1:4312';
  if (origin !== 'http://127.0.0.1:4312') throw new Error('COMPANY_LOGIN_ORIGIN_INVALID');
  const bootstrapFile = '/run/company-login/bootstrap.json';
  const gateway = createCompanyLoginGateway({
    origin,
    upstreamHost: process.env.COMPANY_LOGIN_UPSTREAM_HOST ?? 'company-browser',
    upstreamPort: Number(process.env.COMPANY_LOGIN_UPSTREAM_PORT ?? 6080),
    onConsume: () => writeFile(bootstrapFile, JSON.stringify({ consumed: true }), { mode: 0o600 }),
  });
  await writeFile(bootstrapFile, JSON.stringify({ url: gateway.bootstrapUrl(), expiresAt: gateway.bootstrapExpiresAt }), { flag: 'wx', mode: 0o600 });
  gateway.server.listen(4312, '0.0.0.0');
  gateway.server.on('error', () => { console.error('COMPANY_LOGIN_GATEWAY_FAILED'); process.exitCode = 1; gateway.close(); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => gateway.close());
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => { console.error('COMPANY_LOGIN_GATEWAY_FAILED'); process.exitCode = 1; });
}
