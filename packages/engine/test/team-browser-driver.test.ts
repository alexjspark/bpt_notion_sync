import{test}from'node:test';import assert from'node:assert/strict';
import{DockerBrowserDriver,browserCreateArgs,browserNames,TEAM_BROWSER_PROFILE,type DockerCommand}from'../src/team-browser-driver.ts';
import{tenantNetwork,peerName,type TrustedPeer}from'../src/team-browser-network.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333',D='44444444-4444-4444-8444-444444444444',image='sha256:'+'a'.repeat(64);
const peers:TrustedPeer[]=['gateway','worker','egress'].map(r=>({role:r as TrustedPeer['role'],name:peerName(r as TrustedPeer['role']),imageId:image}));
function dockerMock(){
 const commands:string[][]=[],networks=new Map<string,any>(),containers=new Map<string,any>(),volumes=new Map<string,string>();let uncertain=false;
 const execute:DockerCommand=async args=>{
  const a=[...args];commands.push(a);const last=a.at(-1)!;let out='';
  if(a[0]==='network'&&a[1]==='ls'){const name=a[a.indexOf('--filter')+1]!.slice(6,-1);out=networks.has(name)?name:'';}
  else if(a[0]==='network'&&a[1]==='create'){networks.set(last,{internal:a.includes('--internal'),managed:'phase2-network-v1',tenant:a[a.indexOf('trainer-sync.managed=phase2-network-v1')+2]?.split('=')[1],containers:{}});out=last;}
  else if(a[0]==='network'&&a[1]==='inspect')out=JSON.stringify(networks.get(last));
  else if(a[0]==='network'&&a[1]==='connect'){const name=a.at(-2)!,m=networks.get(name);m.containers[last]={Name:last};}
  else if(a[0]==='container'&&a[1]==='ls'){const name=a[a.indexOf('--filter')+1]!.slice(6,-1);out=containers.has(name)?name:'';}
  else if(a[0]==='inspect'&&peers.some(p=>p.name===last)){const p=peers.find(p=>p.name===last)!;out=JSON.stringify({managed:'phase2-'+p.role+'-v1',image,user:'pwuser',privileged:false,ports:null,networkMode:'synthetic-control',capAdd:null,mounts:[]});}
  else if(a[0]==='inspect')out=JSON.stringify(containers.get(last));
  else if(a[0]==='volume'&&a[1]==='ls'){const name=a[a.indexOf('--filter')+1]!.slice(6,-1);out=volumes.has(name)?name:'';}
  else if(a[0]==='volume'&&a[1]==='create'){const owner=a.find(v=>v.startsWith('trainer-sync.tenant='))!.slice(20);volumes.set(last,'phase2-profile-v1|'+owner);}
  else if(a[0]==='volume'&&a[1]==='inspect')out=volumes.get(last)!;
  else if(a[0]==='create'){
   const name=a[a.indexOf('--name')+1]!,tenant=a.find(v=>v.startsWith('trainer-sync.tenant='))!.slice(20),session=a.find(v=>v.startsWith('trainer-sync.session='))!.slice(21),network=a[a.indexOf('--network')+1]!,volume=a[a.indexOf('--mount')+1]!.split(',')[1]!.slice(7);
   containers.set(name,{tenant,session,managed:'phase2-browser-v1',image,user:'pwuser',running:false,privileged:false,capAdd:null,pidMode:'',health:'starting',mounts:[{Type:'volume',Name:volume,Destination:TEAM_BROWSER_PROFILE}],ports:null,networks:{[network]:{}}});networks.get(network).containers[name]={Name:name};if(uncertain){uncertain=false;return{exitCode:1,stdout:''};}
  }else if(a[0]==='start'){const m=containers.get(last);m.running=true;m.health='healthy';}
  else if(a[0]==='stop')containers.get(last).running=false;
  else if(a[0]==='rm'){containers.delete(last);for(const m of networks.values())delete m.containers[last];}
  else throw Error('UNEXPECTED_MOCK_COMMAND');
  return{exitCode:0,stdout:out};
 };
 return{execute,commands,networks,containers,volumes,uncertainNextCreate(){uncertain=true;}};
}
test('Docker plan pins image and owns names, tenant-only internal network; no socket, bind, published ports or shared browser',()=>{
 const a=browserCreateArgs({tenantId:A,sessionId:C},image),b=browserCreateArgs({tenantId:B,sessionId:D},image);
 assert.ok(a.includes(tenantNetwork(A)));assert.ok(!a.includes(tenantNetwork(B)));assert.notEqual(browserNames({tenantId:A,sessionId:C}).volume,browserNames({tenantId:B,sessionId:D}).volume);
 for(const flag of['--privileged','--publish','-p','--network=host','--volumes-from','--force'])assert.ok(!a.includes(flag));assert.ok(!a.join(' ').includes('docker.sock'));assert.ok(a.includes('--pull=never'));assert.ok(a.includes('TEAM_COMPANY_PROXY=true'));assert.notDeepEqual(a,b);
 assert.throws(()=>browserCreateArgs({tenantId:A,sessionId:C},'mutable:latest'),{code:'RUNNER_SCOPE_INVALID'});
});
test('mock driver allocates A/B independent resources and reuses only the same owned session',async()=>{
 const m=dockerMock(),d=new DockerBrowserDriver(m.execute,image,peers,async()=>{});
 await d.ensure({tenantId:A,sessionId:C});await d.ensure({tenantId:B,sessionId:D});await d.ensure({tenantId:A,sessionId:C});
 assert.equal(m.commands.filter(c=>c[0]==='create').length,2);assert.equal(m.networks.size,2);assert.equal(m.volumes.size,2);assert.ok([...m.networks.values()].every(n=>n.internal));assert.equal(m.networks.get(tenantNetwork(A)).containers[browserNames({tenantId:B,sessionId:D}).container],undefined);
 await d.stop({tenantId:A,sessionId:C});assert.equal(m.containers.size,1);assert.equal(m.volumes.size,2);assert.ok(!m.commands.some(c=>c.includes('--force')||c.includes('-v')));
});
test('uncertain create acknowledgement is inspected before reconcile; no duplicate creation',async()=>{
 const m=dockerMock(),d=new DockerBrowserDriver(m.execute,image,peers,async()=>{});m.uncertainNextCreate();
 await assert.rejects(d.ensure({tenantId:A,sessionId:C}),{code:'RUNNER_UNAVAILABLE'});await d.ensure({tenantId:A,sessionId:C});assert.equal(m.commands.filter(c=>c[0]==='create').length,1);
});
test('foreign network member, shared network, wrong labels or mutable peer config fail closed',async()=>{
 const m=dockerMock(),d=new DockerBrowserDriver(m.execute,image,peers,async()=>{});await d.ensure({tenantId:A,sessionId:C});
 m.networks.get(tenantNetwork(A)).containers.foreign={Name:'foreign-browser'};await assert.rejects(d.ensure({tenantId:A,sessionId:C}),{code:'RUNNER_SCOPE_INVALID'});delete m.networks.get(tenantNetwork(A)).containers.foreign;
 const row=m.containers.get(browserNames({tenantId:A,sessionId:C}).container);row.networks={'trainer-sync-local_private':{}};await assert.rejects(d.ensure({tenantId:A,sessionId:C}),{code:'RUNNER_SCOPE_INVALID'});
 assert.throws(()=>new DockerBrowserDriver(m.execute,image,[{role:'gateway',name:'original-company-browser',imageId:image}]),{code:'RUNNER_SCOPE_INVALID'});
});

for(const mode of['worker-tmpfs','worker-bind','worker-other-path','worker-source','gateway-tmpfs']as const)test('trusted-peer secret mount policy: '+mode,async()=>{
 const m=dockerMock();const execute:DockerCommand=async args=>{const r=await m.execute(args);if(args[0]==='inspect'&&args.at(-1)===peerName(mode==='gateway-tmpfs'?'gateway':'worker')){const meta=JSON.parse(r.stdout);meta.mounts=[{Type:mode==='worker-bind'?'bind':'tmpfs',Destination:mode==='worker-other-path'?'/other':'/run/team-secrets',Source:mode==='worker-source'?'/host':''}];return{exitCode:0,stdout:JSON.stringify(meta)};}return r;};
 const d=new DockerBrowserDriver(execute,image,peers,async()=>{});if(mode==='worker-tmpfs')assert.deepEqual(await d.ensure({tenantId:A,sessionId:C}),{ready:true});else await assert.rejects(d.ensure({tenantId:A,sessionId:C}),{code:'RUNNER_SCOPE_INVALID'});
});
