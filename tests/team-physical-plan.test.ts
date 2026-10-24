import{test}from'node:test';import assert from'node:assert/strict';
import{fixtureConnectionAllowed,physicalConfig,PHYSICAL_DB,PHYSICAL_DB_PASSWORD,PHYSICAL_ORIGIN,physicalNames,physicalLabels,physicalBrowserArgs,fixtureFor,samePhysicalDestination}from'./physical/config.ts';
import{composePhysical,offlineBuildPlan,plannedPhysicalJournal,physicalRunnerEnvironment}from'./physical/plan.ts';
import{newJournal,reserveResource,recordResource,uncertainResource,cleanupPlan,markResourceAbsent,type ObservedResource}from'./physical/registry.ts';
import{guardedPhysicalDocker}from'./physical/runner-guard.ts';import{physicalRoute,denyPhysicalEgress}from'./physical/routing.ts';
import{physicalWebResponse}from'./physical/servers.ts';import type{TeamServices}from'../apps/web/lib/team-api.ts';
import{browserCreateArgs,browserNames}from'../packages/engine/src/team-browser-driver.ts';
const RUN='11111111-1111-4111-8111-111111111111',TENANT='22222222-2222-4222-8222-222222222222',SESSION='33333333-3333-4333-8333-333333333333',ID='a'.repeat(64),IMAGES={runtime:'sha256:'+'a'.repeat(64),browser:'sha256:'+'b'.repeat(64),postgres:'sha256:'+'c'.repeat(64)};
const env={TEAM_PHYSICAL_TEST_ONLY:'true',TEAM_PHYSICAL_TEST_APPROVED:'true',TEAM_TEST_RUN_ID:RUN,TEAM_TEST_ROLE:'web',TEAM_PUBLIC_ORIGIN:PHYSICAL_ORIGIN,DATABASE_URL:'postgresql://trainer_test:'+PHYSICAL_DB_PASSWORD+'@trainer-sync-team-test-db:5432/'+PHYSICAL_DB};
const observed=(kind:'container'|'network'|'volume',name:string,managed:string,id=ID):ObservedResource=>({kind,name,managed,id:kind==='volume'?name:id,labels:physicalLabels(RUN,managed),running:true}as ObservedResource);
test('physical config requires explicit approval and exact isolated DB/origin without credential fallback',()=>{
 assert.equal(physicalConfig(env).runId,RUN);
 for(const patch of[{TEAM_PHYSICAL_TEST_APPROVED:'false'},{DATABASE_URL:env.DATABASE_URL.replace(PHYSICAL_DB,'trainer_sync')},{DATABASE_URL:env.DATABASE_URL.replace('trainer-sync-team-test-db','postgres')},{TEAM_PUBLIC_ORIGIN:'http://127.0.0.1:4310'},{TEAM_VAULT_MASTER_KEY:'SYNTHETIC_VALUE'},{NOTION_TOKEN_FILE:'not-allowed'}])assert.throws(()=>physicalConfig({...env,...patch}));
});
test('runner can use only localhost test DB port and never operating DB',()=>{
 const r=physicalRunnerEnvironment(RUN,IMAGES);assert.equal(physicalConfig(r).role,'runner');assert.throws(()=>physicalConfig({...r,DATABASE_URL:r.DATABASE_URL.replace('15436','5432')}));
});
test('compose has six separate services, internal-only control net, and two loopback binds',()=>{
 const p=composePhysical(RUN,IMAGES);assert.equal(Object.keys(p.services).length,6);assert.equal(p.networks.control.internal,true);
 assert.deepEqual(p.services.db.ports,['127.0.0.1:15436:5432']);assert.deepEqual(p.services.ingress.ports,['127.0.0.1:4316:4316']);
 for(const role of['gateway','worker','egress']as const){const s=p.services[role];assert.equal(s.container_name,'trainer-sync-team-'+role);assert.equal('ports'in s,false);assert.equal('volumes'in s,false);assert.equal(s.labels['trainer-sync.test-run'],RUN);}
 assert.deepEqual(p.services.db.tmpfs,['/var/lib/postgresql/data']);assert.ok(!JSON.stringify(p).includes('company-profile-trainer-live-one'));assert.ok(!JSON.stringify(p).includes('docker.sock'));
});
test('only immutable images and offline local build plans are accepted',()=>{
 assert.throws(()=>composePhysical(RUN,{...IMAGES,browser:'browser:latest'}));const p=offlineBuildPlan({runtimeBase:'trainer-sync-phase2-test:local',browserBase:'trainer-sync-local-company-browser:latest'});assert.equal(p.allowPull,false);assert.equal(p.allowDownload,false);assert.ok(p.arguments.includes('--network=none'));assert.ok(p.requiresLocalImageInspection);
});
test('synthetic browser starts only about:blank and fixed local proxy; fixtures contain no real destinations',()=>{
 const args=physicalBrowserArgs();assert.equal(args.at(-1),'about:blank');assert.ok(args.includes('--proxy-server=http://ts-team-egress:3128'));assert.ok(!args.some(v=>v.includes('admin.biz-pt.com')));
 const a=fixtureFor(RUN,'A'),b=fixtureFor(RUN,'B');assert.notEqual(a.destination.dataSourceId,b.destination.dataSourceId);assert.ok(a.login.startsWith('physical-a-'));
 assert.equal(samePhysicalDestination(a.destination,{templateId:a.destination.templateId,dataSourceId:a.destination.dataSourceId,databaseId:a.destination.databaseId}),true);
});
test('HTTP and WS routes cannot choose arbitrary upstreams or bypass Host/Origin',()=>{
 const base={method:'GET',headers:{host:'localhost:4316',origin:PHYSICAL_ORIGIN}};
 assert.equal(physicalRoute({...base,url:'/team'}).port,3000);assert.equal(physicalRoute({...base,url:'/team/browser/'+SESSION+'/websockify'},true).port,4315);
 for(const url of['http://evil.invalid','//evil.invalid','/api/dashboard','/team/browser/'+SESSION+'/?target=http://evil.invalid','/team/browser/'+SESSION+'/novnc/%2e%2e/private'])assert.throws(()=>physicalRoute({...base,url}));
 assert.throws(()=>physicalRoute({...base,url:'/team',headers:{host:'localhost:4310'}}));assert.throws(()=>physicalRoute({...base,url:'/team/browser/'+SESSION+'/websockify',headers:{host:'localhost:4316'}},true));
});
test('egress denial is unconditional and has no DNS/dial dependency',()=>assert.deepEqual(denyPhysicalEgress(),{status:403,code:'PHYSICAL_EGRESS_DISABLED'}));
test('initial journal reserves only explicit planned resource identities without creating anything',()=>{
 const j=plannedPhysicalJournal(RUN);assert.equal(j.resources.length,7);assert.ok(j.resources.every(v=>v.state==='reserved'&&!v.id));assert.deepEqual(cleanupPlan(j,[]),[]);
 assert.throws(()=>reserveResource(j,{kind:'container',name:'trainer-sync-local-postgres-1',managed:'physical-db-v1'}));assert.throws(()=>reserveResource(j,{kind:'volume',name:physicalNames(RUN).gateway,managed:'anything'}));
});
test('cleanup requires matching run, managed label and exact IDs; never force/prune/shared resource',()=>{
 const j=newJournal(RUN),name=browserNames({tenantId:TENANT,sessionId:SESSION}).container;reserveResource(j,{kind:'container',name,managed:'phase2-browser-v1'});const o=observed('container',name,'phase2-browser-v1');recordResource(j,o);
 assert.deepEqual(cleanupPlan(j,[o]),[['stop','--time','10',ID],['rm',ID]]);
 assert.throws(()=>cleanupPlan(j,[{...o,id:'b'.repeat(64)}]));assert.throws(()=>cleanupPlan(j,[{...o,labels:{...o.labels,'trainer-sync.test-run':TENANT}}]));assert.throws(()=>cleanupPlan(j,[]));
});
test('uncertain creation must reconcile and record an ID before deletion, confirmed absence can close record',()=>{
 const j=newJournal(RUN),name='ts-team-profile-'+TENANT.replaceAll('-','');reserveResource(j,{kind:'volume',name,managed:'phase2-profile-v1'});uncertainResource(j,'volume',name);
 const o=observed('volume',name,'phase2-profile-v1');assert.throws(()=>cleanupPlan(j,[o]),/RECORD_ID/);recordResource(j,o);assert.deepEqual(cleanupPlan(j,[o]),[['volume','rm',name]]);
 assert.throws(()=>markResourceAbsent(j,'volume',name,false));markResourceAbsent(j,'volume',name,true);assert.deepEqual(cleanupPlan(j,[]),[]);
});
test('journal persistence failure stops a create before any injected Docker call',async()=>{
 const j=newJournal(RUN);let calls=0;const execute=guardedPhysicalDocker(RUN,{load:async()=>j,save:async()=>{throw Error('DISK_UNAVAILABLE');}},async()=>{calls++;return{exitCode:0,stdout:''};});
 await assert.rejects(execute(browserCreateArgs({tenantId:TENANT,sessionId:SESSION},IMAGES.browser)));assert.equal(calls,0);
});
test('guard labels/records one fake create and inspects an uncertain result before repeating',async()=>{
 let j=newJournal(RUN),exists=false,creates=0;const commands:string[][]=[],name=browserNames({tenantId:TENANT,sessionId:SESSION}).container;
 const execute=guardedPhysicalDocker(RUN,{load:async()=>structuredClone(j),save:async value=>{j=structuredClone(value);}},async args=>{
  commands.push([...args]);if(args[0]==='container'&&args[1]==='ls')return{exitCode:0,stdout:exists?name:''};
  if(args[0]==='create'){creates++;exists=true;assert.ok(args.includes('trainer-sync.test-run='+RUN));assert.ok(args.includes('TEAM_PHYSICAL_TEST_ONLY=true'));return{exitCode:1,stdout:''};}
  if(args[0]==='inspect')return{exitCode:0,stdout:JSON.stringify({id:ID,name:'/'+name,run:RUN,managed:'phase2-browser-v1',purpose:'physical-isolation'})};
  throw Error('UNEXPECTED_VIRTUAL_COMMAND');
 });
 const args=browserCreateArgs({tenantId:TENANT,sessionId:SESSION},IMAGES.browser);assert.equal((await execute(args)).exitCode,1);assert.equal(j.resources[0]!.id,ID);
 assert.equal((await execute(args)).exitCode,0);assert.equal(creates,1);assert.ok(commands.filter(a=>a[0]==='inspect').length>=2);
});
test('guard refuses unsafe commands and unknown cleanup targets without touching external executor',async()=>{
 let calls=0;const execute=guardedPhysicalDocker(RUN,{load:async()=>newJournal(RUN),save:async()=>{}},async()=>{calls++;return{exitCode:0,stdout:''};});
 for(const args of[['pull','anything'],['system','prune'],['rm','--force','anything'],['run','image'],['rm','trainer-sync-local-postgres-1']])await assert.rejects(execute(args));assert.equal(calls,0);
});
test('test web surface is explicitly synthetic and rejects legacy routes without real services or fetch',async()=>{
 const config=physicalConfig(env),unused={}as TeamServices;const old=globalThis.fetch;globalThis.fetch=async()=>{throw Error('EXTERNAL_FETCH_FORBIDDEN');};
 try{const response=await physicalWebResponse(new Request(PHYSICAL_ORIGIN+'/team'),config,unused),body=await response.text();assert.ok(body.includes('TEST'));assert.ok(body.includes('별도인 시험'));assert.equal((await physicalWebResponse(new Request(PHYSICAL_ORIGIN+'/api/dashboard'),config,unused)).status,404);assert.equal((await physicalWebResponse(new Request('http://evil.invalid/team'),config,unused)).status,403);}finally{globalThis.fetch=old;}
});

test('fake A connection refuses the public B fixture even when its token is known',()=>{const a=fixtureFor(RUN,'A'),b=fixtureFor(RUN,'B');assert.equal(fixtureConnectionAllowed(RUN,'A',a.token,a.destination),true);assert.equal(fixtureConnectionAllowed(RUN,'A',b.token,b.destination),false);});
