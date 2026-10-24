import{before,after,beforeEach,afterEach,test}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{migrate,query,closeDb,connectDb,syntheticMembers}from'@trainer/db';
import{auditEvent,pruneAuditLog,closeAuditLog}from'../src/audit-log.ts';
import{queueManualSyncRun,runManualSyncOnce}from'../src/manual-sync.ts';
let tenant:string,runIds:string[]=[];
before(async()=>{const url=process.env.TEST_DATABASE_URL;if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');process.env.DATABASE_URL=url;await migrate();});
after(async()=>{await closeAuditLog();await closeDb();});
beforeEach(async()=>{tenant='audit-test-'+randomUUID();runIds=[];await query('INSERT INTO trainers(id,name)VALUES($1,$2)',[tenant,'SYNTHETIC_TEST_TRAINER']);});
afterEach(async()=>{if(runIds.length)await query('DELETE FROM sync_audit_events WHERE run_id=ANY($1::uuid[])',[runIds]);await query('DELETE FROM trainers WHERE id=$1',[tenant]);});
const key='SYNTHETIC_PREVIEW_KEY_AT_LEAST_32_BYTES';
function sources(fail=false){const members=syntheticMembers(tenant,'2026-10-22T00:00:00Z');return{company:{listMembers:async()=>{if(fail)throw Error('SYNTHETIC_PRIVATE_NAME_EMAIL_TOKEN');return{members,nextCursor:null,scope:'all_assigned'as const,completeCoverage:true,snapshotId:'synthetic-company'};}},notion:{listIdentities:async()=>({identities:members.map((m,i)=>({trainerId:tenant,companyMemberId:m.companyMemberId,pageId:'synthetic-'+i})),nextCursor:null,scope:'all_members'as const,completeCoverage:true,snapshotId:'synthetic-notion'})}};}
test('PostgreSQL trace keeps queue, attempt, failure/retry and completion under the same run without raw errors',async()=>{
 const run=await queueManualSyncRun(tenant,randomUUID(),{companyRead:true,notionInventoryRead:true});runIds.push(run.id);
 await auditEvent({runId:run.id,runKind:'preview',requestId:run.requestId,accountId:tenant,stage:'queued',outcome:'succeeded'});
 await runManualSyncOnce({trainerId:tenant,readiness:{companyRead:true,notionInventoryRead:true},previewHmacKey:key,...sources(true)});
 await query('UPDATE manual_sync_runs SET available_at=now() WHERE id=$1',[run.id]);
 await runManualSyncOnce({trainerId:tenant,readiness:{companyRead:true,notionInventoryRead:true},previewHmacKey:key,...sources(false)});
 const events=(await query<{event:Record<string,unknown>}>('SELECT event FROM sync_audit_events WHERE run_id=$1 ORDER BY id',[run.id])).rows.map(r=>r.event);
 assert.ok(events.some(e=>e.stage==='queued'));assert.ok(events.some(e=>e.stage==='retry'&&e.attempt===1));assert.ok(events.some(e=>e.stage==='claim'&&e.attempt===2));assert.ok(events.some(e=>e.stage==='collect'));assert.ok(events.some(e=>e.stage==='plan'));assert.ok(events.some(e=>e.stage==='complete'&&e.outcome==='succeeded'));assert.ok(!JSON.stringify(events).includes('SYNTHETIC_PRIVATE_NAME_EMAIL_TOKEN'));assert.ok(events.every(e=>e.runId===run.id));
});
test('retention removes old new-audit events while keeping business run/request ledgers',async()=>{
 const run=await queueManualSyncRun(tenant,randomUUID(),{}as never);runIds.push(run.id);
 await auditEvent({runId:run.id,runKind:'preview',stage:'queued',outcome:'held',reasonCode:'NOT_CONNECTED'});
 await query("UPDATE sync_audit_events SET occurred_at=now()-interval '40 days' WHERE run_id=$1",[run.id]);await pruneAuditLog();
 assert.equal((await query('SELECT 1 FROM sync_audit_events WHERE run_id=$1',[run.id])).rowCount,0);assert.equal((await query('SELECT 1 FROM manual_sync_runs WHERE id=$1',[run.id])).rowCount,1);assert.equal((await query('SELECT 1 FROM manual_sync_requests WHERE run_id=$1',[run.id])).rowCount,1);
});
test('a locked audit table times out independently and does not block the business pool',async()=>{
 const id=randomUUID();runIds.push(id);const blocker=await connectDb();await blocker.query('BEGIN');await blocker.query('LOCK TABLE sync_audit_events IN ACCESS EXCLUSIVE MODE');const started=Date.now();
 try{assert.equal(await auditEvent({runId:id,runKind:'preview',stage:'error',outcome:'failed',error:Error('SYNTHETIC_PRIVATE')}),false);assert.ok(Date.now()-started<3000);assert.equal((await query('SELECT 1 AS ok')).rows[0].ok,1);}
 finally{await blocker.query('ROLLBACK');blocker.release();}
 assert.equal(await auditEvent({runId:id,runKind:'preview',stage:'complete',outcome:'succeeded'}),true);
});

test('diagnostic capacity is bounded and only diagnostic rows are pruned',async()=>{
 const id=randomUUID();runIds.push(id);
 await query("INSERT INTO sync_audit_events(run_id,occurred_at,level,run_kind,stage,outcome,event) SELECT $1,now(),'info','preview','queued','succeeded','{}'::jsonb FROM generate_series(1,20003)",[id]);
 assert.equal(await auditEvent({runId:id,runKind:'preview',stage:'complete',outcome:'succeeded'}),false);
 await pruneAuditLog();assert.ok(Number((await query<{count:string}>('SELECT count(*)::text AS count FROM sync_audit_events')).rows[0]!.count)<=18000);
 assert.equal(await auditEvent({runId:id,runKind:'preview',stage:'complete',outcome:'succeeded'}),true);
});
test('legacy job failure record stores a fixed safe summary instead of original message',async()=>{
 const id=randomUUID();runIds.push(id);
 await query("INSERT INTO jobs(id,trainer_id,kind,status,attempts,lease_until)VALUES($1,$2,'company_sync','running',1,now()+interval '2 minutes')",[id,tenant]);
 await query("INSERT INTO tenant_locks(trainer_id,job_id,lease_until)VALUES($1,$2,now()+interval '2 minutes')",[tenant,id]);
 const{finishJob}=await import('../src/jobs.ts');await finishJob({id,trainer_id:tenant,kind:'company_sync',attempts:1},Error('SYNTHETIC_NAME 010-0000-0000 private@example.invalid TOKEN_COOKIE'));
 const row=(await query<{error:string}>('SELECT error FROM jobs WHERE id=$1',[id])).rows[0]!;assert.match(row.error,/UNCLASSIFIED_ERROR/);assert.doesNotMatch(row.error,/SYNTHETIC_NAME|010-0000|private@example|TOKEN_COOKIE/);
});
