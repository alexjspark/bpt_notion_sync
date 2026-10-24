import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { DashboardSnapshot } from '../../packages/db/src/index.ts';

const canonicalPublicOrigin = 'http://127.0.0.1:4310';
const trainerId = 'trainer-demo';
const syntheticIds = ['demo-001', 'demo-002', 'demo-003', 'demo-004'];
const disabledDefaults = {
  dailyTime: null,
  timezone: 'Asia/Seoul',
  horizonMonths: 3,
  notionPollMinutes: 5,
  mockScheduleEnabled: false,
};

async function readDashboard(request: APIRequestContext): Promise<DashboardSnapshot> {
  const response = await request.get('/api/dashboard');
  expect(response.status(), 'The existing mock app and database must be ready.').toBe(200);
  const snapshot = await response.json() as DashboardSnapshot;
  // Fail before POSTing if BASE_URL points at anything except the seeded mock tenant.
  expect(snapshot.mode).toBe('mock');
  expect(snapshot.trainer.id).toBe(trainerId);
  expect(snapshot.members.map(member => member.companyMemberId).sort()).toEqual(syntheticIds);
  expect(snapshot.members.every(member => member.trainerId === trainerId)).toBe(true);
  expect(snapshot.schedules.every(event => event.trainerId === trainerId)).toBe(true);
  expect(snapshot.connections.every(connection => connection.status === 'mock')).toBe(true);
  return snapshot;
}

/**
 * Docker's browser visits http://web:3000, while the product correctly accepts
 * only PUBLIC_ORIGIN=http://127.0.0.1:4310. This explicit test proxy rewrites the
 * Origin of same-app UI POSTs only via a server-side request and fulfillment.
 * Negative API requests bypass this helper.
 * No URL, product validation, forwarded host, or application code is changed.
 */
async function installMockUiProxy(page: Page, baseURL: string): Promise<string[]> {
  const applicationOrigin = new URL(baseURL).origin;
  const unexpectedOrigins: string[] = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) {
      await route.continue();
      return;
    }
    if (url.origin !== applicationOrigin) {
      unexpectedOrigins.push(url.origin);
      await route.abort('blockedbyclient');
      return;
    }
    const isUiWrite = request.method() === 'POST' &&
      (url.pathname === '/api/jobs' || url.pathname === '/api/settings');
    if (isUiWrite) {
      const response = await route.fetch({
        headers: { ...await request.allHeaders(), origin: canonicalPublicOrigin },
        maxRedirects: 0,
      });
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  return unexpectedOrigins;
}

async function clickJob(page: Page, kind: 'company_sync' | 'notion_poll'): Promise<string> {
  const posted = page.waitForResponse(response => {
    const request = response.request();
    return new URL(response.url()).pathname === '/api/jobs' &&
      request.method() === 'POST' &&
      (request.postDataJSON() as { kind?: string }).kind === kind;
  });
  const section = page.locator(kind === 'company_sync' ? '#members' : '#schedules');
  await section.getByRole('button').click();
  const response = await posted;
  const responseBody = await response.text();
  expect(response.status(), 'UI job response body: ' + responseBody.slice(0, 2_000)).toBe(202);
  const result = JSON.parse(responseBody) as { id: string; mode: string };
  expect(result.mode).toBe('mock');
  expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);
  return result.id;
}

async function waitForJob(request: APIRequestContext, id: string): Promise<DashboardSnapshot> {
  await expect.poll(async () => {
    const snapshot = await readDashboard(request);
    return snapshot.jobs.find(job => job.id === id)?.status || 'not-visible';
  }, {
    message: 'The durable worker must complete the exact job accepted by the UI.',
    timeout: 60_000,
    intervals: [100, 250, 500, 1_000],
  }).toBe('succeeded');
  return readDashboard(request);
}

function scheduleSignature(snapshot: DashboardSnapshot) {
  return snapshot.schedules.map(event => ({
    key: event.key,
    trainerId: event.trainerId,
    companyMemberId: event.companyMemberId,
    kind: event.kind,
    start: event.start,
    end: event.end,
    status: event.status,
    manualOverride: event.manualOverride,
    sourceStart: event.sourceStart,
    sourceEnd: event.sourceEnd,
    sourceStatus: event.sourceStatus,
    notionPageId: event.notionPageId ?? null,
  })).sort((left, right) => left.key.localeCompare(right.key));
}

test.describe('seeded local mock management flow', () => {
  test.describe.configure({ mode: 'serial' });

  test('UI jobs run through the worker while defaults, isolation, and schedule identities survive', async ({ page, request, baseURL }) => {
    expect(baseURL).toBeTruthy();
    let initial!: DashboardSnapshot;
    let unexpectedOrigins: string[] = [];

    await test.step('require mock health, seeded tenant, and disabled initial settings', async () => {
      const health = await request.get('/api/health');
      expect(health.status()).toBe(200);
      expect(await health.json()).toMatchObject({
        status: 'ok', database: 'ready', mode: 'mock', externalConnectionsEnabled: false,
      });
      initial = await readDashboard(request);
      expect(initial.settings).toEqual(disabledDefaults);
      unexpectedOrigins = await installMockUiProxy(page, baseURL!);
      await page.goto('/');
      await expect(page.getByRole('note').filter({ hasText: 'MOCK ONLY' })).toContainText('MOCK ONLY');
      await expect(page.locator('#members tbody tr')).toHaveCount(syntheticIds.length);
      for (const id of syntheticIds) await expect(page.getByText(id, { exact: true })).toBeVisible();
      await expect(page.getByText('trainer-other', { exact: false })).toHaveCount(0);
      const settings = page.locator('#settings');
      await expect(settings.locator('input[type="time"]')).toHaveValue('');
      await expect(settings.getByRole('checkbox')).not.toBeChecked();
      await expect(settings.getByRole('combobox').nth(0)).toHaveValue('Asia/Seoul');
      await expect(settings.getByRole('combobox').nth(1)).toHaveValue('5');
      await expect(settings.getByRole('combobox').nth(2)).toHaveValue('3');
    });

    await test.step('reject missing/foreign origins and client-selected tenant or external mode', async () => {
      // APIRequestContext does not use page.route: these test real server rejection.
      for (const origin of [undefined, 'https://attacker.invalid', 'http://localhost:4310']) {
        const response = await request.post('/api/jobs', {
          data: { kind: 'company_sync' },
          headers: origin ? { Origin: origin } : {},
        });
        expect(response.status()).toBe(403);
      }
      const forged = await request.post('/api/jobs', {
        data: { kind: 'company_sync' },
        headers: { Origin: 'https://attacker.invalid', 'X-Forwarded-Host': '127.0.0.1:4310' },
      });
      expect(forged.status()).toBe(403);
      const tenantJob = await request.post('/api/jobs', {
        data: { kind: 'company_sync', trainerId: 'trainer-other' },
        headers: { Origin: canonicalPublicOrigin },
      });
      expect(tenantJob.status()).toBe(400);
      for (const extra of [{ trainerId: 'trainer-other' }, { externalEnabled: true }]) {
        const response = await request.post('/api/settings', {
          data: { ...disabledDefaults, ...extra },
          headers: { Origin: canonicalPublicOrigin },
        });
        expect(response.status()).toBe(400);
      }
      const attemptedSelection = await request.get('/api/dashboard?trainerId=trainer-other');
      expect(attemptedSelection.status()).toBe(200);
      const stillSelected = await attemptedSelection.json() as DashboardSnapshot;
      expect(stillSelected.trainer.id).toBe(trainerId);
      expect(stillSelected.members.every(member => member.trainerId === trainerId)).toBe(true);
      expect((await readDashboard(request)).settings).toEqual(disabledDefaults);
    });

    let imported!: DashboardSnapshot;
    await test.step('click company sync and observe the worker create mock pages and real dated schedules', async () => {
      imported = await waitForJob(request, await clickJob(page, 'company_sync'));
      expect(imported.members).toHaveLength(syntheticIds.length);
      expect(imported.members.every(member => member.notionPageId?.startsWith('mock-'))).toBe(true);
      expect(new Set(imported.members.map(member => member.notionPageId)).size).toBe(syntheticIds.length);
      const active = imported.schedules.filter(event => event.status === 'active');
      expect(active.length).toBeGreaterThan(10);
      expect(active.some(event => event.kind === 'training')).toBe(true);
      expect(active.some(event => event.kind === 'call')).toBe(true);
      for (const event of active) {
        expect(Number.isFinite(Date.parse(event.start))).toBe(true);
        expect(Date.parse(event.end) - Date.parse(event.start)).toBe(60 * 60 * 1_000);
      }
      expect(new Set(imported.schedules.map(event => event.key)).size).toBe(imported.schedules.length);
      await page.reload();
      await expect(page.locator('#schedules tbody tr')).toHaveCount(Math.min(imported.schedules.length, 24));
      await expect(page.locator('#activity tbody')).toContainText(
        imported.jobs.find(job => job.kind === 'company_sync')!.id.slice(0, 8),
      );
    });

    await test.step('repeat company sync and poll Notion without duplicate members, pages, or schedule changes', async () => {
      const baseline = scheduleSignature(imported);
      const pageIds = imported.members.map(member => [member.companyMemberId, member.notionPageId]);
      const repeated = await waitForJob(request, await clickJob(page, 'company_sync'));
      expect(repeated.members.map(member => [member.companyMemberId, member.notionPageId])).toEqual(pageIds);
      expect(scheduleSignature(repeated)).toEqual(baseline);
      const polled = await waitForJob(request, await clickJob(page, 'notion_poll'));
      expect(scheduleSignature(polled)).toEqual(baseline);
      expect(polled.members.map(member => [member.companyMemberId, member.notionPageId])).toEqual(pageIds);
      expect(polled.settings).toEqual(disabledDefaults);
      await page.reload();
      await expect(page.getByRole('note').filter({ hasText: 'MOCK ONLY' })).toContainText('MOCK ONLY');
      await expect(page.locator('#members tbody tr')).toHaveCount(syntheticIds.length);
      await expect(page.getByText('trainer-other', { exact: false })).toHaveCount(0);
      expect(unexpectedOrigins, 'The browser must never request an external service.').toEqual([]);
      await page.screenshot({ path: test.info().outputPath('mock-dashboard.png'), fullPage: true });
    });
  });
});
