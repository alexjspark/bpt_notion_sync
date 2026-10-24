import {test,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {closeDb,migrate,query} from '@trainer/db';
import {LIVE_MANUAL_TRAINER_ID,publishLiveReadOnlyState} from '../../packages/engine/src/live-runtime.ts';
import {runManualSyncOnce} from '../../packages/engine/src/manual-sync.ts';
import {connectedPreviewFixture} from './fixture.ts';

const trainerId=LIVE_MANUAL_TRAINER_ID,canonicalOrigin='http://127.0.0.1:4310';
let testDbReady=false;
test.beforeAll(async()=>{
  const url=process.env.TEST_DATABASE_URL;
  if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('DEDICATED_TEST_DATABASE_REQUIRED');
  process.env.DATABASE_URL=url;await migrate();testDbReady=true;
  await query('DELETE FROM trainers WHERE id=$1',[trainerId]);
});
test.afterAll(async()=>{if(testDbReady)await query('DELETE FROM trainers WHERE id=$1',[trainerId]);await closeDb();});
test.afterEach(async()=>{if(testDbReady)await query('DELETE FROM trainers WHERE id=$1',[trainerId]);});
async function publish(){await publishLiveReadOnlyState(trainerId,{companyStatus:'ready',notionStatus:'ready',previewKeyReady:true});}
async function snapshot(){
  const result=await query("SELECT jsonb_build_object('settings',t.settings,'members',(SELECT jsonb_agg(m ORDER BY company_member_id) FROM members m WHERE m.trainer_id=t.id),'schedules',(SELECT jsonb_agg(s ORDER BY event_key) FROM schedules s WHERE s.trainer_id=t.id),'jobs',(SELECT jsonb_agg(j ORDER BY id) FROM jobs j WHERE j.trainer_id=t.id)) AS data FROM trainers t WHERE id=$1",[trainerId]);
  return result.rows[0]!.data;
}
test('real button queues the same run consumed by real adapters with synthetic sources and zero mutations',async({page,request,baseURL})=>{
  await publish();
  const stored={trainerId,companyMemberId:'pending',status:'\\uc9c4\\ud589',manualContent:'SYNTHETIC_KEEP_MEMBER'};
  await query('INSERT INTO members(trainer_id,company_member_id,data) VALUES($1,$2,$3::jsonb)',[trainerId,'pending',JSON.stringify(stored)]);
  for(const key of ['ongoing-repeat','manual-override']){
    await query('INSERT INTO schedules(trainer_id,event_key,company_member_id,data) VALUES($1,$2,$3,$4::jsonb)',[trainerId,key,'pending',JSON.stringify({trainerId,companyMemberId:'pending',key,status:'active',manualOverride:key==='manual-override',start:'2026-11-01T14:00:00+09:00'})]);
  }
  await query("INSERT INTO jobs(id,trainer_id,kind,status) VALUES(gen_random_uuid(),$1,'company_sync','queued')",[trainerId]);
  const before=await snapshot();
  const fixture=connectedPreviewFixture(trainerId);
  const unexpectedOrigins:string[]=[];
  await page.route('**/*',async route=>{
    const outgoing=route.request(),url=new URL(outgoing.url());
    if(!['http:','https:'].includes(url.protocol)){await route.continue();return;}
    if(url.origin!==new URL(baseURL!).origin){unexpectedOrigins.push(url.origin);await route.abort();return;}
    if(outgoing.method()==='POST'&&url.pathname==='/api/manual-sync'){const response=await route.fetch({headers:{...await outgoing.allHeaders(),origin:canonicalOrigin},maxRedirects:0});await route.fulfill({response});return;}
    await route.continue();
  });
  await page.goto('/');
  const panel=page.locator('#manual-sync'),button=panel.locator('.manual-sync-button');
  await expect(button).toBeEnabled();
  const posted=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/manual-sync'&&response.request().method()==='POST');
  await button.click();const accepted=await (await posted).json();
  expect(accepted).toMatchObject({connected:true,externalWritesEnabled:false,automaticSyncEnabled:false});
  expect(accepted.run.status).toBe('queued');
  const duplicate=await request.post('/api/manual-sync',{data:{action:'preview'},headers:{Origin:canonicalOrigin}});
  expect((await duplicate.json()).run.id).toBe(accepted.run.id);
  expect(await runManualSyncOnce({trainerId,readiness:{companyRead:true,notionInventoryRead:true},previewHmacKey:'synthetic-connected-key-at-least-32-bytes',...fixture})).toBe(true);
  const readback=await (await request.get('/api/manual-sync')).json();
  const completed=readback.runs.find((run:{id:string})=>run.id===accepted.run.id);
  expect(completed.status).toBe('succeeded');
  expect(completed.counts).toEqual({added:0,skipped:2,failed:0,plannedAdds:1,review:1});
  expect(completed.previewPlan.withdrawal).toMatchObject({coverage:'complete',requestCount:3,plannedStatusUpdates:1,calendarPolicy:'continue_existing_training'});
  expect(completed.previewPlan.members.filter((member:{reason:string})=>member.reason==='withdrawal_status_already_set')).toHaveLength(1);
  expect(JSON.stringify(completed)).not.toMatch(/SYNTHETIC_PRIVATE/);
  await expect(panel.locator('.manual-counts dd')).toHaveText(['1','2','1','0','0']);
  expect(fixture.reads().companyReads).toBe(1);expect(fixture.reads().notionReads).toBeGreaterThan(0);
  expect(fixture.requests.every(r=>r.method==='GET'||r.method==='POST'&&r.url.endsWith('/query'))).toBe(true);
  assert.deepEqual(await snapshot(),before);
  expect(unexpectedOrigins).toEqual([]);
  await page.screenshot({path:test.info().outputPath('connected-preview-complete.png'),fullPage:true});
});
test('a ready screen cannot queue work after its worker heartbeat expires',async({page,request})=>{
  await publish();await page.goto('/');const panel=page.locator('#manual-sync');
  await expect(panel.locator('.manual-sync-button')).toBeEnabled();
  await query("UPDATE live_readonly_state SET heartbeat_at=now()-interval '31 seconds' WHERE trainer_id=$1",[trainerId]);
  await page.route('**/api/manual-sync',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    const response=await route.fetch({headers:{...await route.request().allHeaders(),origin:canonicalOrigin},maxRedirects:0});await route.fulfill({response});
  });
  const posted=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/manual-sync'&&response.request().method()==='POST');
  await panel.locator('.manual-sync-button').click();const accepted=await(await posted).json();
  expect(accepted.connected).toBe(false);expect(accepted.run.status).toBe('needs_connection');expect(accepted.run.previewPlan).toBeNull();
  expect(await runManualSyncOnce({trainerId,company:{listMembers:async()=>{throw new Error('NO_SOURCE_READ_ALLOWED');}}})).toBe(false);
  expect((await(await request.get('/api/manual-sync')).json()).companyStatus).toBe('worker_offline');
  await expect(panel.locator('.manual-counts dd')).toHaveText(Array(5).fill('\u2014'));
});
