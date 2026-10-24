import { defineConfig } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:4310';
const target = new URL(baseURL);
const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
const composeWeb = target.hostname === 'web' && target.port === '3000';
if (target.protocol !== 'http:' || (!loopback && !composeWeb) ||
    target.username || target.password || target.pathname !== '/' ||
    target.search || target.hash) {
  throw new Error('E2E BASE_URL must be the local mock app or http://web:3000.');
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: target.origin,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1080 },
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  // The caller starts the approved mock stack. This suite never starts services.
});
