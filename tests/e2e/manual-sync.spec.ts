import { test, expect } from '@playwright/test';

const canonicalOrigin = 'http://127.0.0.1:4310';
test('manual company-to-Notion button records connection requirements without pretending to sync', async ({ page, request, baseURL }) => {
  const initial = await request.get('/api/manual-sync');
  expect(initial.status()).toBe(200);
  const initialState = await initial.json();
  expect(initialState).toMatchObject({mode:'dry_run',connected:false,automaticSyncEnabled:false,previewOnly:true,externalWritesEnabled:false});
  expect(initialState.requiredConnections).toEqual(['company_read_session','notion_read_integration']);
  const dashboardBefore = await (await request.get('/api/dashboard')).json();
  const companyJobIds = dashboardBefore.jobs.filter((job:{kind:string})=>job.kind==='company_sync').map((job:{id:string})=>job.id).sort();

  // Real API rejection tests do not use the browser's explicit Docker-origin proxy.
  for (const origin of [undefined, 'https://attacker.invalid']) {
    const response = await request.post('/api/manual-sync', {data:{action:'preview'},headers:origin?{Origin:origin}:{}});
    expect(response.status()).toBe(403);
  }
  for (const body of [{action:'apply'},{action:'preview',trainerId:'trainer-other'},{action:'preview',externalWritesEnabled:true}]) {
    const response = await request.post('/api/manual-sync', {data:body,headers:{Origin:canonicalOrigin}});
    expect(response.status()).toBe(400);
  }

  const applicationOrigin = new URL(baseURL!).origin;
  const unexpectedOrigins: string[] = [];
  await page.route('**/*',async route=>{
    const outgoing=route.request();const url=new URL(outgoing.url());
    if(!['http:','https:'].includes(url.protocol)){await route.continue();return;}
    if(url.origin!==applicationOrigin){unexpectedOrigins.push(url.origin);await route.abort();return;}
    if(outgoing.method()==='POST'&&url.pathname==='/api/manual-sync'){
      const response=await route.fetch({headers:{...await outgoing.allHeaders(),origin:canonicalOrigin},maxRedirects:0});
      await route.fulfill({response});return;
    }
    await route.continue();
  });
  await page.goto('/');
  const panel=page.locator('#manual-sync');
  const button=panel.getByRole('button',{name:'지금 회사 → 노션 동기화'});
  await expect(button).toBeEnabled();
  await expect(panel).toContainText('연결 필요');
  const posted=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/manual-sync'&&r.request().method()==='POST');
  await button.click();
  const response=await posted;
  expect(response.status(),await response.text()).toBe(202);
  const accepted=await response.json();
  expect(accepted.externalWritesEnabled).toBe(false);
  expect(accepted.run.status).toBe('needs_connection');
  expect(accepted.run.previewPlan).toBeNull();
  expect(Object.values(accepted.run.counts).every(value=>value===null)).toBe(true);
  await expect(panel).toContainText('연결 필요');
  await expect(panel.locator('.manual-counts dd')).toHaveText(['—','—','—','—','—']);

  const duplicate=await Promise.all([1,2].map(()=>request.post('/api/manual-sync',{data:{action:'preview'},headers:{Origin:canonicalOrigin}})));
  for(const result of duplicate){expect(result.status()).toBe(202);expect((await result.json()).run.id).toBe(accepted.run.id);}
  const withOtherQuery=await(await request.get('/api/manual-sync?trainerId=trainer-other')).json();
  expect(withOtherQuery.runs.every((run:{trainerId:string})=>run.trainerId==='trainer-demo')).toBe(true);
  const dashboardAfter=await(await request.get('/api/dashboard')).json();
  expect(dashboardAfter.jobs.filter((job:{kind:string})=>job.kind==='company_sync').map((job:{id:string})=>job.id).sort()).toEqual(companyJobIds);
  expect(dashboardAfter.members).toEqual(dashboardBefore.members);
  expect(unexpectedOrigins).toEqual([]);
  await page.screenshot({path:test.info().outputPath('manual-sync-needs-connection.png'),fullPage:true});
});
