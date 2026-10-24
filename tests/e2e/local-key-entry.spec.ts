import { test, expect } from '@playwright/test';

const { createConnectionInputServer } = await import(new URL('../../scripts/connect-local-server.mjs', import.meta.url).href);
const SYNTHETIC_TOKEN = `ntn_${'synthetic_browser_only_'.repeat(3)}`;

// Ephemeral in-memory writers only; never the real port, profile or key files.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('native Chromium form preserves same-origin POST and renders completion after one synthetic save', async ({ page }) => {
  let writes = 0;
  let postOrigin: string | undefined;
  const input = createConnectionInputServer({ port: 0,
    persist: async (token: string) => { expect(token).toBe(SYNTHETIC_TOKEN); writes++; },
  });
  input.server.on('request', (request: import('node:http').IncomingMessage) => {
    if (request.method === 'POST') postOrigin = request.headers.origin;
  });
  try {
    const { url, origin } = await input.listen();
    await page.goto(url);
    await page.locator('input[type="password"]').fill(SYNTHETIC_TOKEN);
    const responsePromise = page.waitForResponse(response => response.url() === url && response.request().method() === 'POST');
    await page.locator('button[type="submit"]').click();
    const response = await responsePromise;
    expect(postOrigin).toBe(origin);
    expect(response.status()).toBe(200);
    expect(writes).toBe(1);
    expect(await response.text()).not.toContain(SYNTHETIC_TOKEN);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toContain(SYNTHETIC_TOKEN);
    expect(input.server.listening).toBe(false);
  } finally {
    input.server.closeAllConnections();
    if (input.server.listening) await new Promise<void>(resolve => input.server.close(() => resolve()));
  }
});

test('native Chromium receives completion when a stop is requested during synthetic storage', async ({ page }) => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { entered = resolve; });
  let saved = 0;
  const input = createConnectionInputServer({ port: 0,
    persist: async () => { entered(); await gate; },
    onSaved: () => { saved++; },
  });
  try {
    const { url } = await input.listen();
    await page.goto(url);
    await page.locator('input[type="password"]').fill(SYNTHETIC_TOKEN);
    const responsePromise = page.waitForResponse(response => response.url() === url && response.request().method() === 'POST');
    const click = page.locator('button[type="submit"]').click();
    await writing;
    const stopped = input.stop();
    release();
    const response = await responsePromise;
    await click;
    expect(response.status()).toBe(200);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toContain(SYNTHETIC_TOKEN);
    expect(saved).toBe(1);
    await stopped;
    expect(input.server.listening).toBe(false);
  } finally {
    release();
    input.server.closeAllConnections();
    if (input.server.listening) await new Promise<void>(resolve => input.server.close(() => resolve()));
  }
});
