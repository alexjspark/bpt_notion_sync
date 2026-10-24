import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { connect } from 'node:net';
// @ts-expect-error The gateway is also a standalone Node launcher.
import { createCompanyLoginGateway } from '../scripts/company-browser-gateway.mjs';
// @ts-expect-error The diagnostic helper is also used by the standalone launcher.
import { classifyBrowserStartupFailure } from '../scripts/company-browser-diagnostics.mjs';

async function setup(now?: () => number) {
  let origin = '';
  const gateway = createCompanyLoginGateway({ origin: () => origin, now });
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  origin = `http://127.0.0.1:${gateway.server.address().port}`;
  return { ...gateway, origin };
}
async function exchange(gateway: Awaited<ReturnType<typeof setup>>) {
  const response = await fetch(gateway.bootstrapUrl(), { redirect: 'manual' });
  assert.equal(response.status, 303);
  return response.headers.get('set-cookie')!.split(';')[0];
}

test('browser startup diagnostics expose constant approved fragments only', () => {
  assert.deepEqual(classifyBrowserStartupFailure('No usable sandbox! /private/path user@example.test https://private.example/member/123'), ['No usable sandbox']);
  assert.deepEqual(classifyBrowserStartupFailure('Failed to move to new namespace: Operation not permitted /private/secret'), ['Failed to move to new namespace', 'Operation not permitted']);
  assert.deepEqual(classifyBrowserStartupFailure('chrome_crashpad_handler /private/profile arbitrary details'), ['chrome_crashpad_handler']);
  assert.deepEqual(classifyBrowserStartupFailure('private unrecognized content'), []);
});

test('company login bootstrap is one-use and produces a private, same-site browser session', async () => {
  const gateway = await setup();
  try {
    assert.equal((await fetch(gateway.origin)).status, 403);
    const response = await fetch(gateway.bootstrapUrl(), { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(gateway.bootstrapUrl(), { redirect: 'manual' })).status, 403);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const page = await fetch(gateway.origin, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /회사 자동화 전용 브라우저/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal((await fetch(`${gateway.origin}/login.js`, { headers: { cookie } })).status, 200);
  } finally { gateway.close(); }
});

test('company login rejects expired bootstrap/session, forged Host and unsafe assets', async () => {
  let clock = 1000;
  const expired = await setup(() => clock);
  try {
    clock += 10 * 60_000;
    assert.equal((await fetch(expired.bootstrapUrl(), { redirect: 'manual' })).status, 403);
  } finally { expired.close(); }
  const gateway = await setup(() => clock);
  try {
    const cookie = await exchange(gateway);
    assert.equal((await fetch(`${gateway.origin}/novnc/%2e%2e%2fprivate.js`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${gateway.origin}/login.js?token=bad`, { headers: { cookie } })).status, 404);
    const status = await new Promise<number>(resolve => {
      const req = request(gateway.origin, { headers: { Host: 'evil.example', cookie } }, res => { res.resume(); resolve(res.statusCode!); });
      req.end();
    });
    assert.equal(status, 403);
    clock += 60 * 60_000;
    assert.equal((await fetch(gateway.origin, { headers: { cookie } })).status, 403);
  } finally { gateway.close(); }
});

test('company login WebSocket refuses both cross-origin and unauthenticated control', async () => {
  const gateway = await setup();
  try {
    const cookie = await exchange(gateway);
    for (const headers of [
      { origin: 'http://evil.example', cookie },
      { origin: gateway.origin, cookie: 'ts_company_login=wrong' },
    ]) {
      const port = Number(new URL(gateway.origin).port);
      const socket = connect(port, '127.0.0.1');
      await once(socket, 'connect');
      socket.write(`GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: ${headers.origin}\r\nCookie: ${headers.cookie}\r\n\r\n`);
      const [data] = await once(socket, 'data');
      assert.match(data.toString(), /403 Forbidden/);
      socket.destroy();
    }
  } finally { gateway.close(); }
});
