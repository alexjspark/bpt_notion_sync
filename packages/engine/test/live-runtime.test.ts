import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveReadOnlyRuntime, LIVE_MANUAL_TRAINER_ID, parseLiveReadOnlyConfig, publicLiveReadOnlyState } from '../src/live-runtime.ts';
import { OfficialNotionClient } from '../src/live-notion-client.ts';
import type { ManualSyncWorkerOptions } from '../src/manual-sync.ts';

const databaseId='11111111-1111-4111-8111-111111111111',dataSourceId='22222222-2222-4222-8222-222222222222';
const configuration=()=>({version:1,trainerId:LIVE_MANUAL_TRAINER_ID,notion:{members:{databaseId,dataSourceId,
  allowedTrainerIds:[LIVE_MANUAL_TRAINER_ID],identity:{mode:'exclusive-data-source-admin-url',trainerId:LIVE_MANUAL_TRAINER_ID,exclusiveOwnershipApproved:true,
    adminUrl:{id:'admin',type:'url'},adminOrigin:'https://admin.biz-pt.com',memberPathPrefix:'/manage/members/'},
  name:{id:'name',type:'title'},status:{id:'status',type:'select'},statuses:{},createStatus:{}}}});
const options={enabled:true,configFile:'/synthetic/config.json',notionTokenFile:'/synthetic/token',previewKeyFile:'/synthetic/hmac',companyEndpoint:'http://company-browser:9222'};
const uncallablePage=async()=>{throw new Error('UNEXPECTED_COMPANY_ACCESS');};

test('live bootstrap is inert unless explicitly enabled and never inspects default credentials',async()=>{
  let calls=0;
  const runtime=await createLiveReadOnlyRuntime({...options,enabled:false},{readText:async()=>{calls++;throw new Error('unexpected');},openCompanyPage:async()=>{calls++;throw new Error('unexpected');}});
  assert.equal(runtime,undefined);assert.equal(calls,0);
});
test('configuration requires server-bound destination IDs and one dedicated tenant',()=>{
  assert.equal(parseLiveReadOnlyConfig(configuration()).trainerId,LIVE_MANUAL_TRAINER_ID);
  assert.throws(()=>parseLiveReadOnlyConfig({...configuration(),trainerId:'trainer-demo'}),/LIVE_CONFIG_INVALID/);
  const other=configuration();other.notion.members.dataSourceId='another-source';
  assert.throws(()=>parseLiveReadOnlyConfig(other),/LIVE_NOTION_TARGET_INVALID/);
  const wrongOrigin=configuration();wrongOrigin.notion.members.identity.adminOrigin='https://example.com';
  assert.throws(()=>parseLiveReadOnlyConfig(wrongOrigin),/LIVE_NOTION_TARGET_INVALID/);
});
test('configuration rejects credentials and executable/template write mappings',()=>{
  assert.throws(()=>parseLiveReadOnlyConfig({...configuration(),token:'SYNTHETIC_PRIVATE_TOKEN'}),/LIVE_CONFIG_INVALID/);
  const nested=configuration();(nested.notion.members as unknown as Record<string,unknown>).apiToken='SYNTHETIC_PRIVATE_TOKEN';
  assert.throws(()=>parseLiveReadOnlyConfig(nested),/LIVE_CONFIG_SECRET_FORBIDDEN/);
  const template=configuration();(template.notion.members as unknown as Record<string,unknown>).template={templateId:'synthetic'};
  assert.throws(()=>parseLiveReadOnlyConfig(template),/LIVE_NOTION_TARGET_INVALID/);
});
test('worker metadata expires and cannot grant readiness through stale heartbeat or truthy flags',()=>{
  const now=100000,state={companyStatus:'ready' as const,notionStatus:'ready' as const,previewKeyReady:true};
  assert.equal(publicLiveReadOnlyState(state,new Date(now),now).connected,true);
  assert.equal(publicLiveReadOnlyState(state,new Date(now-30000),now).connected,false);
  assert.equal(publicLiveReadOnlyState(state,new Date(now+1),now).connected,false);
  assert.equal(publicLiveReadOnlyState({...state,previewKeyReady:false},new Date(now),now).connected,false);
  assert.equal(publicLiveReadOnlyState({...state,previewKeyReady:'true' as never},new Date(now),now).connected,false);
  assert.equal(publicLiveReadOnlyState().externalWritesEnabled,false);
  assert.equal(publicLiveReadOnlyState().automaticSyncEnabled,false);
});
test('missing verified company profile stays needs_verification and missing token never creates a client',async()=>{
  let clientCalls=0;let dispatched:ManualSyncWorkerOptions|undefined;
  const runtime=await createLiveReadOnlyRuntime(options,{openCompanyPage:uncallablePage,readText:async path=>{
    if(path===options.configFile)return JSON.stringify(configuration());
    if(path===options.previewKeyFile)return 'synthetic-preview-key-at-least-thirty-two-bytes';
    throw new Error('SYNTHETIC_PRIVATE_PATH_ERROR');
  },createNotionClient:()=>{clientCalls++;throw new Error('unexpected');},dispatch:async input=>{dispatched=input;return false;}});
  assert.ok(runtime);await runtime.preflight();await runtime.tick();
  assert.equal(runtime.state.companyStatus,'needs_verification');assert.equal(runtime.state.notionStatus,'needs_token');
  assert.equal(runtime.state.previewKeyReady,true);assert.equal(clientCalls,0);
  assert.equal(dispatched?.trainerId,LIVE_MANUAL_TRAINER_ID);assert.deepEqual(dispatched?.readiness,{companyRead:false,notionInventoryRead:false});
});
test('Notion readiness requires a complete read-only identity preflight and runtime never grants writes',async()=>{
  const requests:Array<{method:string;url:string}>=[];let captured:OfficialNotionClient|undefined;
  const runtime=await createLiveReadOnlyRuntime(options,{openCompanyPage:uncallablePage,readText:async path=>{
    if(path===options.configFile)return JSON.stringify(configuration());
    return path===options.previewKeyFile?'synthetic-preview-key-at-least-thirty-two-bytes':'SYNTHETIC_TOKEN';
  },createNotionClient:token=>{
    captured=new OfficialNotionClient({token,readPermit:{approved:true},transport:async request=>{
      requests.push({method:request.method,url:request.url});
      if(request.url.endsWith(`/databases/${databaseId}`))return {status:200,body:{data_sources:[{id:dataSourceId}]}};
      if(request.url.endsWith(`/data_sources/${dataSourceId}`))return {status:200,body:{properties:{Admin:{id:'admin',type:'url'},Name:{id:'name',type:'title'},Status:{id:'status',type:'select',select:{options:[]}}}}};
      return {status:200,body:{results:[],has_more:false,next_cursor:null}};
    }});return captured;
  },dispatch:async()=>false});
  assert.ok(runtime);await runtime.preflight();
  assert.equal(runtime.state.notionStatus,'ready');assert.equal(runtime.state.companyStatus,'needs_verification');
  assert.equal(requests.length,6);assert.ok(requests.every(request=>request.method==='GET'||request.url.endsWith('/query')));
  await assert.rejects(captured!.write('POST','/pages',{}),/NOTION_WRITE_NOT_APPROVED/);
});
test('invalid CDP endpoint fails before reading any local file',async()=>{
  let reads=0;
  await assert.rejects(createLiveReadOnlyRuntime({...options,companyEndpoint:'http://0.0.0.0:9222'},{readText:async()=>{reads++;return '{}';},openCompanyPage:uncallablePage}),/LIVE_CDP_ENDPOINT_INVALID/);
  assert.equal(reads,0);
});
