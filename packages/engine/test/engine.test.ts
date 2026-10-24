import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticMembers } from '@trainer/db';
import { MockCompanyAdapter, collectAssignedMembers } from '../src/company.ts';
import { nextDailyDue } from '../src/scheduler.ts';
import { retryDelayMs } from '../src/jobs.ts';
import { assertMockMode, ExternalAdapterDisabledError, RetryableError } from '../src/ports.ts';
import { UnverifiedCompanyAdapter } from '../src/company.ts';
import { MockNotionAdapter, UnverifiedNotionAdapter } from '../src/notion.ts';
import { calendarWithManualChanges, reconcileMemberCalendar } from '../src/sync.ts';
import type { ScheduleEvent } from '@trainer/core';

test('collector follows every page and deduplicates complete trainer-scoped snapshot',async()=>{
  const expected=syntheticMembers('trainer-unit','2026-10-22T00:00:00Z');
  const actual=await collectAssignedMembers(new MockCompanyAdapter({members:expected,pageSize:1}),'trainer-unit');
  assert.equal(actual.length,expected.length);
  assert.deepEqual(actual.map(m=>m.survey),expected.map(m=>m.survey));
});
test('incomplete filters, tenant leakage, repeated cursors and changed snapshots fail before writes',async()=>{
  const member=syntheticMembers('trainer-unit')[0]!;
  await assert.rejects(collectAssignedMembers({listMembers:async()=>({members:[member],nextCursor:null,scope:'all_assigned',completeCoverage:false,snapshotId:'one'})},'trainer-unit'),/COVERAGE_UNVERIFIED/);
  await assert.rejects(collectAssignedMembers({listMembers:async()=>({members:[{...member,trainerId:'other'}],nextCursor:null,scope:'all_assigned',completeCoverage:true,snapshotId:'one'})},'trainer-unit'),/TENANT_MISMATCH/);
  await assert.rejects(collectAssignedMembers({listMembers:async()=>({members:[],nextCursor:'repeat',scope:'all_assigned',completeCoverage:true,snapshotId:'one'})},'trainer-unit'),/PAGINATION_LOOP/);
  let page=0;
  await assert.rejects(collectAssignedMembers({listMembers:async()=>({members:[],nextCursor:++page===1?'2':null,scope:'all_assigned',completeCoverage:true,snapshotId:String(page)})},'trainer-unit'),/SNAPSHOT_CHANGED/);
});
test('daily wall-clock schedule respects timezone boundary',()=>{
  assert.equal(nextDailyDue('2026-10-22T00:00:00Z','08:30','Asia/Seoul'),'2026-10-22T23:30:00.000Z');
  assert.equal(nextDailyDue('2026-10-21T23:00:00Z','08:30','Asia/Seoul'),'2026-10-21T23:30:00.000Z');
});
test('retry backoff honors rate-limit retry-after and caps exponential component',()=>{
  assert.equal(retryDelayMs(1,new RetryableError('rate limit',120000)),120000);
  assert.equal(retryDelayMs(2,new Error('temporary')),2000);
  assert.equal(retryDelayMs(20,new Error('temporary')),300000);
});
test('unverified external adapters and mode fail closed without network calls',async()=>{
  await assert.rejects(new UnverifiedCompanyAdapter().listMembers(),ExternalAdapterDisabledError);
  await assert.rejects(new UnverifiedNotionAdapter().readMembers(),ExternalAdapterDisabledError);
  await assert.rejects(new UnverifiedNotionAdapter().isMemberPageReady(),ExternalAdapterDisabledError);
  const prior=process.env.EXTERNAL_CONNECTIONS_ENABLED;
  process.env.EXTERNAL_CONNECTIONS_ENABLED='true';
  try{assert.throws(assertMockMode,ExternalAdapterDisabledError);}finally{
    if(prior===undefined)delete process.env.EXTERNAL_CONNECTIONS_ENABLED;else process.env.EXTERNAL_CONNECTIONS_ENABLED=prior;
  }
});

test('calendar reconciliation holds missing or unready member relations before any schedule access',async()=>{
  const member=syntheticMembers('trainer-unit','2026-10-22T00:00:00Z').find(item=>item.status==='진행')!;
  const notion=new MockNotionAdapter();
  let readinessChecks=0;
  notion.isMemberPageReady=async()=>{readinessChecks++;return false;};
  notion.readCalendar=async()=>{throw new Error('Calendar must not be accessed without a member relation');};
  const adapters={company:new MockCompanyAdapter(),notion};
  const missing=await reconcileMemberCalendar({...member,notionPageId:null},adapters);
  assert.equal(missing[0]!.code,'MEMBER_PAGE_REQUIRED');assert.equal(readinessChecks,0);
  const pending=await reconcileMemberCalendar({...member,notionPageId:'mock-unready'},adapters);
  assert.equal(pending[0]!.code,'MEMBER_PAGE_REQUIRED');assert.equal(readinessChecks,1);
});

test('Calendar normalization compares valid instants instead of timezone-offset strings',()=>{
  const local:ScheduleEvent={key:'trainer-unit:member:week:0',trainerId:'trainer-unit',companyMemberId:'member',kind:'training',
    start:'2026-10-25T14:00:00+09:00',end:'2026-10-25T15:00:00+09:00',status:'active',manualOverride:false,
    sourceStart:'2026-10-25T14:00:00+09:00',sourceEnd:'2026-10-25T15:00:00+09:00'};
  const normalized={...local,start:'2026-10-25T05:00:00.000Z',end:'2026-10-25T06:00:00.000Z'};
  assert.equal(calendarWithManualChanges([local],[normalized])[0]!.manualOverride,false);
  assert.equal(calendarWithManualChanges([local],[{...normalized,start:'2026-10-25T05:30:00Z',end:'2026-10-25T06:30:00Z'}])[0]!.manualOverride,true);
  assert.equal(calendarWithManualChanges([local],[{...normalized,start:'invalid-date'}])[0]!.manualOverride,true);
});
