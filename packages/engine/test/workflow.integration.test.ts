import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { migrate, closeDb, query, enqueueJob, getMembers, getSchedules, upsertMember, saveSchedules, syntheticMembers, getDashboard } from '@trainer/db';
import type { Member, ScheduleEvent } from '@trainer/core';
import { MockCompanyAdapter } from '../src/company.ts';
import { MockNotionAdapter } from '../src/notion.ts';
import { claimJob, finishJob, withExecutionLock } from '../src/jobs.ts';
import { RetryableError } from '../src/ports.ts';
import { runJobOnce } from '../src/index.ts';
import { syncCompany, pollNotion } from '../src/sync.ts';
import { scheduleDueJobs } from '../src/scheduler.ts';

const now='2026-10-22T00:00:00Z';
let trainerId:string;
let otherTrainer:string;
function adapters(notion=new MockNotionAdapter({templateDelayMs:0})) {
  return {company:new MockCompanyAdapter({now}),notion,now:()=>now};
}
before(async()=>{
  const url=process.env.TEST_DATABASE_URL;
  if(!url)throw new Error('TEST_DATABASE_URL is required: real PostgreSQL integration tests cannot be skipped.');
  if(!new URL(url).pathname.endsWith('_test'))throw new Error('Integration tests require a dedicated *_test database.');
  process.env.DATABASE_URL=url;
  process.env.ADAPTER_MODE='mock';
  process.env.EXTERNAL_CONNECTIONS_ENABLED='false';
  await migrate();
});
after(async()=>{await closeDb();});
beforeEach(async()=>{
  trainerId=`flow-${randomUUID()}`;otherTrainer=`other-${randomUUID()}`;
  await query('INSERT INTO trainers(id,name) VALUES($1,$2),($3,$4)',[trainerId,'Synthetic trainer',otherTrainer,'Isolated trainer']);
});
afterEach(async()=>{await query('DELETE FROM trainers WHERE id IN ($1,$2)',[trainerId,otherTrainer]);});

test('first paginated company import creates missing existing pages, schedules and exact raw survey once',async()=>{
  const a=adapters();
  await syncCompany(trainerId,a);
  assert.equal((await getDashboard(trainerId)).issues.filter(issue=>issue.code==='AMBIGUOUS_FIXED_SLOT').length,1);
  await syncCompany(trainerId,a);
  assert.equal((await getDashboard(trainerId)).issues.filter(issue=>issue.code==='AMBIGUOUS_FIXED_SLOT').length,1);
  const source=syntheticMembers(trainerId,now);
  const members=await getMembers(trainerId);
  assert.equal(members.length,source.length);
  const pages=await query<{stage:string;body:{specialVideos:unknown;blocks:unknown[]}}>('SELECT stage,body FROM mock_notion_pages WHERE trainer_id=$1',[trainerId]);
  assert.equal(pages.rowCount,source.length);
  assert.ok(pages.rows.every(page=>page.stage==='complete'));
  assert.deepEqual(pages.rows[0]!.body.specialVideos,source[0]!.survey);
  assert.match(JSON.stringify(pages.rows[0]!.body.blocks),/\$\$\$/); // manual block is preserved.
  const events=await getSchedules(trainerId);
  assert.ok(events.length>10);
  assert.equal(new Set(events.map(event=>event.key)).size,events.length);
  assert.equal((await getMembers(otherTrainer)).length,0);
});

test('initial polling holds unlinked seed members for review and recovers after company import completes their pages',async()=>{
  const a=adapters();
  for(const member of syntheticMembers(trainerId,now))await upsertMember(trainerId,member);
  await pollNotion(trainerId,a);
  assert.equal((await getSchedules(trainerId)).length,0);
  assert.equal((await a.notion.readCalendar(trainerId)).length,0);
  const held=await getDashboard(trainerId);
  assert.equal(held.issues.filter(issue=>issue.code==='MEMBER_PAGE_REQUIRED').length,held.members.length);
  await syncCompany(trainerId,a);
  assert.ok((await getSchedules(trainerId)).some(event=>event.kind==='training'));
  assert.ok((await getSchedules(trainerId)).some(event=>event.kind==='call'));
  assert.ok(!(await getDashboard(trainerId)).issues.some(issue=>issue.code==='MEMBER_PAGE_REQUIRED'));
  const pages=(await query<{company_member_id:string;page_id:string}>(`SELECT company_member_id,page_id FROM mock_notion_pages WHERE trainer_id=$1 AND stage='complete'`,[trainerId])).rows;
  const members=new Map((await getMembers(trainerId)).map(member=>[member.companyMemberId,member]));
  for(const event of await a.notion.readCalendar(trainerId))assert.equal(members.get(event.companyMemberId)!.notionPageId,pages.find(page=>page.company_member_id===event.companyMemberId)!.page_id);
});

test('calendar writes reject pending or mismatched member-page relations and accept only completed tenant-scoped pages',async()=>{
  const member=syntheticMembers(trainerId,now).find(item=>item.status==='진행')!;
  await upsertMember(trainerId,member);
  const notion=new MockNotionAdapter({templateDelayMs:2000});
  const {pageId}=await notion.ensureMemberPage(member);
  const linked={...member,notionPageId:pageId};
  await upsertMember(trainerId,linked);
  const event:ScheduleEvent={key:`${trainerId}:unready`,trainerId,companyMemberId:member.companyMemberId,kind:'training',start:'2026-10-25T14:00:00+09:00',end:'2026-10-25T15:00:00+09:00',status:'active',manualOverride:false,sourceStart:'2026-10-25T14:00:00+09:00',sourceEnd:'2026-10-25T15:00:00+09:00'};
  assert.equal(await notion.isMemberPageReady(linked),false);
  await assert.rejects(notion.writeCalendar(trainerId,[event]),/MEMBER_PAGE_REQUIRED/);
  await query("UPDATE mock_notion_pages SET ready_at=now()-interval '1 second' WHERE trainer_id=$1",[trainerId]);
  await notion.awaitTemplate(trainerId,member.companyMemberId);
  await notion.fillMemberPage(linked);
  assert.equal(await notion.isMemberPageReady({...linked,trainerId:otherTrainer}),false);
  assert.equal(await notion.isMemberPageReady({...linked,notionPageId:'wrong-page'}),false);
  await upsertMember(trainerId,{...linked,notionPageId:'wrong-page'});
  await assert.rejects(notion.writeCalendar(trainerId,[event]),/MEMBER_PAGE_REQUIRED/);
  await upsertMember(trainerId,linked);
  assert.equal(await notion.isMemberPageReady(linked),true);
  await notion.writeCalendar(trainerId,[event]);
  assert.equal((await notion.readCalendar(trainerId)).length,1);
});

test('template readiness is checked before personalized content is written',async()=>{
  const member=syntheticMembers(trainerId,now)[0]!;
  await upsertMember(trainerId,member);
  const notion=new MockNotionAdapter({templateDelayMs:2000});
  await notion.ensureMemberPage(member);
  await assert.rejects(notion.fillMemberPage(member),/Template must finish/);
  await query("UPDATE mock_notion_pages SET ready_at=now()-interval '1 second' WHERE trainer_id=$1",[trainerId]);
  await notion.awaitTemplate(trainerId,member.companyMemberId);
  await notion.fillMemberPage(member);
  assert.equal((await query<{stage:string}>('SELECT stage FROM mock_notion_pages WHERE trainer_id=$1',[trainerId])).rows[0]!.stage,'complete');
});

test('concurrent workers cannot overlap different kinds for the same tenant',async()=>{
  await enqueueJob(trainerId,'company_sync');
  await enqueueJob(trainerId,'notion_poll');
  const claimed=await Promise.all([claimJob(),claimJob()]);
  assert.equal(claimed.filter(Boolean).length,1);
  await finishJob(claimed.find(Boolean)!);
  const remaining=await claimJob();assert.ok(remaining);
  await finishJob(remaining);
  assert.equal((await query('SELECT * FROM tenant_locks WHERE trainer_id=$1',[trainerId])).rowCount,0);
});

test('expired running lease recovers on restart and keeps one durable job identity',async()=>{
  const id=await enqueueJob(trainerId,'company_sync');
  const initial=await claimJob();assert.equal(initial?.id,id);
  await query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);
  await query("UPDATE tenant_locks SET lease_until=now()-interval '1 second' WHERE trainer_id=$1",[trainerId]);
  const recovered=await claimJob();assert.equal(recovered?.id,id);assert.equal(recovered?.attempts,2);
  await assert.rejects(finishJob(initial!),/JOB_LEASE_LOST/);
  await finishJob(recovered!);
});

test('session execution lock prevents overlap even when another worker is presented a stale lease',async()=>{
  await enqueueJob(trainerId,'company_sync');
  const job=await claimJob();assert.ok(job);
  let entered!:()=>void;let release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  const first=withExecutionLock(job,async()=>{entered();await held;});
  await started;
  try{await assert.rejects(withExecutionLock(job,async()=>{}),/still finishing/);}finally{release();await first;}
  await finishJob(job);
});

test('rate limit is persisted as delayed retry and resumes successfully',async()=>{
  const id=await enqueueJob(trainerId,'company_sync');
  await runJobOnce({...adapters(),company:{listMembers:async()=>{throw new RetryableError('MOCK_RATE_LIMIT',120000);}}});
  const row=(await query<{status:string;attempts:number;remaining:number}>(`SELECT status,attempts,extract(epoch from(available_at-now()))::float AS remaining FROM jobs WHERE id=$1`,[id])).rows[0]!;
  assert.equal(row.status,'retry');assert.equal(row.attempts,1);assert.ok(row.remaining>119);
  await query('UPDATE jobs SET available_at=now() WHERE id=$1',[id]);
  await runJobOnce(adapters());
  assert.equal((await query<{status:string}>('SELECT status FROM jobs WHERE id=$1',[id])).rows[0]!.status,'succeeded');
});

test('partial failure after page creation resumes without duplicate pages or survey writes',async()=>{
  let injected=false;
  const notion=new MockNotionAdapter({templateDelayMs:0,afterCreate:async()=>{if(!injected){injected=true;throw new RetryableError('MOCK_CONNECTION_INTERRUPTED');}}});
  const id=await enqueueJob(trainerId,'company_sync');
  await runJobOnce(adapters(notion));
  assert.equal((await query('SELECT * FROM mock_notion_pages WHERE trainer_id=$1',[trainerId])).rowCount,1);
  await query('UPDATE jobs SET available_at=now() WHERE id=$1',[id]);
  await runJobOnce(adapters(notion));
  assert.equal((await query('SELECT * FROM mock_notion_pages WHERE trainer_id=$1',[trainerId])).rowCount,4);
  assert.equal((await query<{status:string}>('SELECT status FROM jobs WHERE id=$1',[id])).rows[0]!.status,'succeeded');
});

test('mock Notion polling detects status changes, preserves manual Calendar exception and cancels future on pause',async()=>{
  const a=adapters();await syncCompany(trainerId,a);
  const local=(await getSchedules(trainerId)).find(event=>event.kind==='training'&&event.status==='active')!;
  const moved={...local,start:DateTime.fromISO(local.start).plus({hours:2}).toISO()!,end:DateTime.fromISO(local.end).plus({hours:2}).toISO()!};
  await query('UPDATE mock_notion_events SET data=$3::jsonb WHERE trainer_id=$1 AND event_key=$2',[trainerId,local.key,JSON.stringify(moved)]);
  await pollNotion(trainerId,a);
  const preserved=(await getSchedules(trainerId)).find(event=>event.key===local.key)!;
  assert.equal(preserved.start,moved.start);assert.equal(preserved.manualOverride,true);
  await query(`UPDATE mock_notion_pages SET member_data=jsonb_set(member_data,'{status}',to_jsonb($3::text)) WHERE trainer_id=$1 AND company_member_id=$2`,[trainerId,local.companyMemberId,'유예']);
  await pollNotion(trainerId,a);
  const cancelled=(await getSchedules(trainerId)).filter(event=>event.companyMemberId===local.companyMemberId);
  assert.ok(cancelled.every(event=>event.status==='cancelled'));
});

test('manual member content and dates are not replaced by company reimport',async()=>{
  const a=adapters();await syncCompany(trainerId,a);
  const member=(await getMembers(trainerId)).find(item=>item.status==='진행')!;
  const manual={...member,manualContent:'User original $$$ @@ \n text',firstTrainingDate:'2026-10-25'};
  await query('UPDATE mock_notion_pages SET member_data=$3::jsonb WHERE trainer_id=$1 AND company_member_id=$2',[trainerId,member.companyMemberId,JSON.stringify(manual)]);
  await syncCompany(trainerId,a);
  const actual=(await getMembers(trainerId)).find(item=>item.companyMemberId===member.companyMemberId)!;
  assert.equal(actual.manualContent,manual.manualContent);assert.equal(actual.firstTrainingDate,manual.firstTrainingDate);
});

test('a status-only Calendar cancellation remains cancelled on repeated polling',async()=>{
  const a=adapters();await syncCompany(trainerId,a);
  const active=(await getSchedules(trainerId)).find(event=>event.kind==='training'&&event.status==='active')!;
  await query('UPDATE mock_notion_events SET data=$3::jsonb WHERE trainer_id=$1 AND event_key=$2',[trainerId,active.key,JSON.stringify({...active,status:'cancelled'})]);
  await pollNotion(trainerId,a);await pollNotion(trainerId,a);
  const persisted=(await getSchedules(trainerId)).find(event=>event.key===active.key)!;
  assert.equal(persisted.status,'cancelled');assert.equal(persisted.manualOverride,true);
  assert.equal((await a.notion.readCalendar(trainerId)).find(event=>event.key===active.key)!.status,'cancelled');
});

test('updated raw survey refreshes only managed survey content and preserves personalized/manual blocks',async()=>{
  const a=adapters();await syncCompany(trainerId,a);
  const source=syntheticMembers(trainerId,now);
  const target=source[0]!;
  const before=(await query<{body:unknown}>('SELECT body FROM mock_notion_pages WHERE trainer_id=$1 AND company_member_id=$2',[trainerId,target.companyMemberId])).rows[0]!.body as {blocks:unknown[];manualContent:string};
  target.survey=[{question:'Raw changed question $$$',answer:'  Exact updated answer @@\nsecond line  '}];
  await syncCompany(trainerId,{...a,company:new MockCompanyAdapter({members:source})});
  const after=(await query<{body:{blocks:unknown[];manualContent:string;specialVideos:unknown}}>('SELECT body FROM mock_notion_pages WHERE trainer_id=$1 AND company_member_id=$2',[trainerId,target.companyMemberId])).rows[0]!.body;
  assert.deepEqual(after.specialVideos,target.survey);
  assert.deepEqual(after.blocks,before.blocks);assert.equal(after.manualContent,before.manualContent);
});

test('company withdrawal review survives unrelated Notion polling until saved status agrees',async()=>{
  const a=adapters();await syncCompany(trainerId,a);
  const source=syntheticMembers(trainerId,now);
  const target=source.find(member=>member.status==='진행')!;
  target.membershipActivity='withdrawn';
  await syncCompany(trainerId,{...a,company:new MockCompanyAdapter({members:source})});
  assert.ok((await getDashboard(trainerId)).issues.some(issue=>issue.code==='WITHDRAWAL_REVIEW'));
  await pollNotion(trainerId,a);
  assert.ok((await getDashboard(trainerId)).issues.some(issue=>issue.code==='WITHDRAWAL_REVIEW'));
  await query(`UPDATE mock_notion_pages SET member_data=jsonb_set(member_data,'{status}',to_jsonb($3::text)) WHERE trainer_id=$1 AND company_member_id=$2`,[trainerId,target.companyMemberId,'탈퇴']);
  await pollNotion(trainerId,a);
  assert.ok(!(await getDashboard(trainerId)).issues.some(issue=>issue.code==='WITHDRAWAL_REVIEW'));
});

test('trainer-wide conflicting slots are held for review and never published',async()=>{
  const source=syntheticMembers(trainerId,now).filter(member=>member.status==='진행')[0]!;
  const second={...source,companyMemberId:'collision',name:'Synthetic collision'};
  await syncCompany(trainerId,{...adapters(),company:new MockCompanyAdapter({members:[source,second]})});
  assert.equal((await getSchedules(trainerId)).filter(event=>event.companyMemberId==='collision').length,0);
  assert.ok((await getDashboard(trainerId)).issues.some(issue=>issue.code==='SCHEDULE_CONFLICT'));
});

test('a remote-only move of another member is included before publishing the first member future change',async()=>{
  const original=syntheticMembers(trainerId,now).find(member=>member.status==='진행')!;
  const aMember={...original,companyMemberId:'a-member'};
  const bMember={...original,companyMemberId:'b-member',memo:'일요일 16',fixedSlot:{...original.fixedSlot!,hour:16}};
  const a={...adapters(),company:new MockCompanyAdapter({members:[aMember,bMember]})};
  await syncCompany(trainerId,a);
  const firstA=(await getSchedules(trainerId,'a-member'))[0]!;
  const firstB=(await getSchedules(trainerId,'b-member'))[0]!;
  const movedB={...firstB,start:DateTime.fromISO(firstB.start).minus({hours:1}).toISO()!,end:DateTime.fromISO(firstB.end).minus({hours:1}).toISO()!};
  await query('UPDATE mock_notion_events SET data=$3::jsonb WHERE trainer_id=$1 AND event_key=$2',[trainerId,firstB.key,JSON.stringify(movedB)]);
  assert.equal((await getSchedules(trainerId,'b-member'))[0]!.start,firstB.start); // local B is deliberately stale.
  await query(`UPDATE mock_notion_pages SET member_data=jsonb_set(member_data,'{fixedSlot,hour}',to_jsonb(15))
    WHERE trainer_id=$1 AND company_member_id='a-member'`,[trainerId]);
  await pollNotion(trainerId,a); // a-member reconciles before b-member.
  const calendar=await a.notion.readCalendar(trainerId);
  assert.equal(calendar.find(event=>event.key===firstA.key)!.start,firstA.start);
  assert.equal(calendar.find(event=>event.key===firstB.key)!.start,movedB.start);
  assert.equal(calendar.find(event=>event.key===firstB.key)!.manualOverride,true);
  const active=calendar.filter(event=>event.status==='active');
  for(const left of active.filter(event=>event.companyMemberId==='a-member')) {
    for(const right of active.filter(event=>event.companyMemberId==='b-member')) {
      assert.ok(Date.parse(left.end)<=Date.parse(right.start)||Date.parse(right.end)<=Date.parse(left.start));
    }
  }
  assert.ok((await getDashboard(trainerId)).issues.some(issue=>issue.code==='SCHEDULE_CONFLICT'&&issue.companyMemberId==='a-member'));
});

test('equivalent UTC Calendar timestamps do not block a later fixed-time change',async()=>{
  const member=syntheticMembers(trainerId,now).find(item=>item.status==='진행')!;
  const a={...adapters(),company:new MockCompanyAdapter({members:[member]})};
  await syncCompany(trainerId,a);
  const before=await getSchedules(trainerId,member.companyMemberId);
  for(const event of before) {
    const normalized={...event,start:DateTime.fromISO(event.start).toUTC().toISO()!,end:DateTime.fromISO(event.end).toUTC().toISO()!};
    await query('UPDATE mock_notion_events SET data=$3::jsonb WHERE trainer_id=$1 AND event_key=$2',[trainerId,event.key,JSON.stringify(normalized)]);
  }
  await query(`UPDATE mock_notion_pages SET member_data=jsonb_set(member_data,'{fixedSlot,hour}',to_jsonb(15))
    WHERE trainer_id=$1 AND company_member_id=$2`,[trainerId,member.companyMemberId]);
  await pollNotion(trainerId,a);
  const changed=await getSchedules(trainerId,member.companyMemberId);
  assert.deepEqual(changed.map(event=>event.key),before.map(event=>event.key));
  assert.ok(changed.every(event=>DateTime.fromISO(event.start).setZone('Asia/Seoul').hour===15));
  assert.ok(changed.every(event=>!event.manualOverride));
});

test('unrelated existing conflicts never block a withdrawn member future cancellation',async()=>{
  const a=adapters();await syncCompany(trainerId,a);
  const members=await getMembers(trainerId);
  const training=members.find(member=>member.status==='진행')!;
  const active=(await getSchedules(trainerId)).find(event=>event.kind==='training'&&event.status==='active')!;
  const otherA=members.find(member=>member.companyMemberId!==training.companyMemberId)!;
  const otherB=members.find(member=>member.companyMemberId!==training.companyMemberId&&member.companyMemberId!==otherA.companyMemberId)!;
  const collisionA={...active,key:`${trainerId}:unrelated-a`,companyMemberId:otherA.companyMemberId,manualOverride:true};
  const collisionB={...active,key:`${trainerId}:unrelated-b`,companyMemberId:otherB.companyMemberId,manualOverride:true};
  await saveSchedules(trainerId,[collisionA,collisionB]);
  await query(`UPDATE mock_notion_pages SET member_data=jsonb_set(member_data,'{status}',to_jsonb($3::text)) WHERE trainer_id=$1 AND company_member_id=$2`,[trainerId,training.companyMemberId,'탈퇴']);
  await pollNotion(trainerId,a);
  assert.ok((await getSchedules(trainerId,training.companyMemberId)).every(event=>event.status==='cancelled'));
  assert.ok((await a.notion.readCalendar(trainerId)).filter(event=>event.companyMemberId===training.companyMemberId).every(event=>event.status==='cancelled'));
});

test('missed polling coalesces into one job while unconfigured daily company schedule stays off',async()=>{
  await query("INSERT INTO scheduler_state(trainer_id,kind,next_due) VALUES($1,'notion_poll',$2)",[trainerId,'2026-10-20T00:00:00Z']);
  await scheduleDueJobs(now);await scheduleDueJobs(now);
  const jobs=await query<{kind:string}>('SELECT kind FROM jobs WHERE trainer_id=$1',[trainerId]);
  assert.deepEqual(jobs.rows.map(row=>row.kind),['notion_poll']);
});
