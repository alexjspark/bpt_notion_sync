import{spawn}from'node:child_process';import assert from'node:assert/strict';import{chromium}from'@playwright/test';import{physicalClientOptions}from'./physical/client.ts';import{verifyRunningPhysicalClientSandbox}from'./physical/client-guard.ts';
const origin='http://127.0.0.1:4316';let server:ReturnType<typeof spawn>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const id='11111111-1111-4111-8111-111111111111';
try{
 server=spawn(process.execPath,['../../node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','4316'],{cwd:'apps/web',env:{...process.env,PHASE2_ENABLED:'true',TEAM_PUBLIC_ORIGIN:origin,TEAM_PILOT_ENABLED:'false',TEAM_PILOT_WRITE_APPROVED:'false'},stdio:['ignore','ignore','ignore'],windowsHide:true});
 // Resolve Next from workspace root while running its web directory.
 let ready=false;for(let n=0;n<80;n++){if(server.exitCode!==null)break;try{if((await fetch(origin+'/team')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'PILOT_UI_SERVER_NOT_READY');
 browser=await chromium.launch(physicalClientOptions());await verifyRunningPhysicalClientSandbox();const context=await browser.newContext();let authenticated=false,writeReady=false,approved=0;
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.origin!==origin){await route.abort();return;}
  if(!u.pathname.startsWith('/api/team/')){await route.continue();return;}
  const path=u.pathname.slice('/api/team/'.length);let result:unknown={},status=200;
  if(path==='connections'){if(!authenticated){status=401;result={code:'AUTH_REQUIRED'};}else result={id,revision:1,companyStatus:'verified',notionStatus:'verified',vaultReady:true,companyProviderReady:true,previewProviderReady:true,pilotReady:true,pilotWriteReady:writeReady,canInvite:false,destination:null,session:null};}
  else if(path==='invite/accept')result={accepted:true,login:'synthetic-pilot'};
  else if(path==='login'){authenticated=true;result={authenticated:true};}
  else if(path==='logout'){authenticated=false;result={authenticated:false};}
  else if(path==='preview')result={id,status:'succeeded',reasonCode:null,result:{members:1,matched:1,held:0,creates:0,updates:0}};
  else if(path==='pilot/prepare')result={id,status:'prepared',expiresAt:'2099-01-01T00:00:00Z',result:null,plan:{uid:'00042',name:'TEST SYNTHETIC',pageId:id,databaseId:id,fields:['email'],held:[{field:'phone',reason:'EXISTING_VALUE'}]}};
  else if(path==='pilot/'+id+'/approve'){approved++;result={id,status:'verified',expiresAt:'2099-01-01T00:00:00Z',plan:null,result:{verified:true,fields:['email'],uncertain:false}};}
  else{status=404;result={code:'NOT_FOUND'};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(result)});
 });
 const page=await context.newPage();await page.goto(origin+'/team');await page.getByText('Accept a private invitation',{exact:true}).click();await page.getByLabel('Invitation code',{exact:true}).fill('SYNTHETIC_INVITATION');await page.getByLabel('Invited email',{exact:true}).fill('fiction@example.invalid');await page.getByLabel('Choose password',{exact:true}).fill('SYNTHETIC_PASSWORD');await page.getByRole('button',{name:'Accept invitation',exact:true}).click();await page.getByText('Account created. Sign in as synthetic-pilot').waitFor();assert.equal(await page.getByLabel('Invitation code',{exact:true}).inputValue(),'');
 await page.locator('input[name=login]').fill('synthetic-pilot');await page.locator('input[name=password]').fill('SYNTHETIC_PASSWORD');await page.getByRole('button',{name:'\ub85c\uadf8\uc778',exact:true}).click();await page.getByRole('heading',{name:'One-member pilot save'}).waitFor();
 async function plan(){await page.getByRole('button',{name:'\ubbf8\ub9ac\ubcf4\uae30 \uc2e4\ud589',exact:true}).click();await page.getByLabel('Choose company UID').fill('00042');await page.getByRole('button',{name:'Prepare selected member',exact:true}).click();await page.getByText('TEST SYNTHETIC / UID 00042').waitFor();await page.getByRole('checkbox').check();}
 await plan();assert.equal(await page.getByRole('button',{name:'Approve this member once'}).isDisabled(),true);assert.equal(approved,0);
 writeReady=true;await page.reload();await page.getByRole('heading',{name:'One-member pilot save'}).waitFor();await plan();await page.getByRole('button',{name:'Approve this member once'}).click();await page.getByText('Pilot: verified;',{exact:false}).waitFor();assert.equal(approved,1);assert.equal(await page.getByRole('button',{name:'Approve this member once'}).count(),0);
 await page.getByRole('button',{name:'\ub85c\uadf8\uc544\uc6c3',exact:true}).click();assert.equal(await page.getByRole('heading',{name:'One-member pilot save'}).count(),0);
 console.log(JSON.stringify({suite:'pilot-mocked-ui',checks:9,realProviders:false,realAccountCreates:0,externalWrites:0,sandbox:true}));
}finally{await browser?.close();server?.kill('SIGTERM');if(server)await Promise.race([new Promise(r=>server!.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
