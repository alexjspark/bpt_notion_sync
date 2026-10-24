import test from'node:test';import assert from'node:assert/strict';
import{buildSafeAuditEvent,safeAuditError,withAuditTestSink,withAuditContext,withAuditMember,setVerifiedAuditAccount,auditEvent,auditPoolLimits}from'../src/audit-log.ts';
import{OfficialNotionClient,NotionWriteUncertainError}from'../src/live-notion-client.ts';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',key='SYNTHETIC_AUDIT_KEY_AT_LEAST_32_BYTES';
test('audit allowlist excludes PII, credentials, raw errors and unknown metadata',()=>{
 const secret='SYNTHETIC_PRIVATE_TOKEN',raw='Synthetic Name 010-0000-0000 private@example.invalid 2000-01-01 '+secret;
 const event=buildSafeAuditEvent({stage:'error',outcome:'failed',runId:a,runKind:'profile_once',accountId:raw,memberId:raw,fields:['email',raw],reasonCode:raw,errorCode:raw,error:new Error(raw),beforeState:raw,afterState:raw,provider:raw,operation:raw,metadata:{token:secret},name:raw,body:raw,headers:{Authorization:secret}}as never,undefined,key)!;
 const json=JSON.stringify(event);for(const value of ['Synthetic Name','010-0000-0000','private@example.invalid','2000-01-01',secret,'metadata','Authorization'])assert.ok(!json.includes(value));assert.equal(event.errorCode,'UNCLASSIFIED_ERROR');assert.deepEqual(event.fields,['email']);assert.equal(event.reasonCode,'UNKNOWN_REASON');assert.ok(event.tenantRef&&event.memberRef);assert.equal(event.accountRef,undefined);assert.ok(json.length<2048);
});
test('invalid trace IDs are rejected and bounded enums/numbers cannot carry arbitrary input',()=>{
 assert.equal(buildSafeAuditEvent({stage:'map',outcome:'held',runId:'private@example.invalid',runKind:'preview'},undefined,key),null);
 const event=buildSafeAuditEvent({stage:'map',outcome:'held',runId:a,runKind:'preview',attempt:100000,retryCount:-1,durationMs:Infinity,counts:{members:999999999,email:'PII'}as never,fields:Array(100).fill('email')},undefined,key)!;
 assert.equal(event.attempt,100);assert.equal(event.retryCount,0);assert.equal(event.durationMs,undefined);assert.deepEqual(event.counts,{members:100000});assert.deepEqual(event.fields,['email']);assert.equal(safeAuditError({name:'NotionHttpError',status:403,message:'SECRET'}).code,'NOTION_HTTP_ERROR');
});
test('async traces remain isolated; local tenant and verified company account references are distinct',async()=>{
 const events:any[]=[];await Promise.all([a,b].map((id,i)=>withAuditTestSink({runId:id,runKind:'preview',accountId:'tenant-'+i},{key,sink:async e=>{events.push(e);}},async()=>{
  setVerifiedAuditAccount('account-'+i,'trainer-'+i);await Promise.resolve();await withAuditMember('member-'+i,['status'],()=>auditEvent({stage:'map',outcome:'held',reasonCode:'EXISTING_VALUE_PRESERVED'}));await withAuditContext({runId:id,runKind:'preview',attempt:2},async()=>{await auditEvent({stage:'complete',outcome:'succeeded'});});
 })));
 assert.equal(events.length,4);for(const id of [a,b]){const rows=events.filter(e=>e.runId===id);assert.equal(rows.length,2);assert.equal(rows[0].accountRef,rows[1].accountRef);assert.notEqual(rows[0].tenantRef,rows[0].accountRef);}assert.notEqual(events[0].accountRef,events.find(e=>e.runId!==events[0].runId).accountRef);
});
test('provider retry, uncertain write and readback keep one trace without request/response values',async()=>{
 const events:any[]=[];let reads=0,writes=0;const privateValue='SYNTHETIC_PRIVATE_ERROR_COOKIE_PASSWORD';
 const client=new OfficialNotionClient({token:'SYNTHETIC_TOKEN',readPermit:{approved:true},writePermit:{approved:true},maxRateLimitRetries:1,sleep:async()=>{},transport:async r=>r.method==='GET'?(++reads===1?{status:429,headers:{'retry-after':'1'},body:{code:'rate_limited',message:privateValue}}:{status:200,body:{id:'fake'}}):(++writes,{status:500,body:{message:privateValue}})});
 await withAuditTestSink({runId:a,runKind:'profile_once',accountId:'synthetic-account',attempt:1},{key,sink:async e=>{events.push(e);}},async()=>{
  await auditEvent({stage:'collect',outcome:'started',provider:'notion'});await client.read('/pages/fake');await auditEvent({stage:'map',outcome:'held',fields:['gender'],reasonCode:'MISSING_SOURCE_VALUE'});
  await assert.rejects(withAuditMember('synthetic-member',['birthDate'],()=>client.write('PATCH','/pages/fake',{properties:{birth:{date:{start:'2000-01-01'}}}})),NotionWriteUncertainError);
  await auditEvent({stage:'readback',outcome:'uncertain',fields:['birthDate'],readbackMatch:false,afterState:'unverified'});
 });
 assert.equal(reads,2);assert.equal(writes,1);assert.ok(events.every(e=>e.runId===a));assert.ok(events.some(e=>e.stage==='retry'&&e.retryCount===1));assert.ok(events.some(e=>e.stage==='write'&&e.outcome==='uncertain'));assert.ok(events.some(e=>e.stage==='readback'));assert.ok(!JSON.stringify(events).includes(privateValue));assert.ok(!JSON.stringify(events).includes('2000-01-01'));assert.ok(!JSON.stringify(events).includes('SYNTHETIC_TOKEN'));
});
test('audit transport bounds are separate and finite',()=>{const limits=auditPoolLimits();assert.equal(limits.max,1);assert.ok(limits.connectionTimeoutMillis<=1000);assert.ok(limits.statement_timeout<=1000);assert.ok(limits.query_timeout<=1500);});
