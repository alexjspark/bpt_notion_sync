import {spawn}from'node:child_process';
import {chromium}from'@playwright/test';
import assert from'node:assert/strict';
import {randomUUID}from'node:crypto';
import {migrate,query,closeDb}from'@trainer/db';
import {provisionTeamUser}from'../packages/engine/src/team-auth.ts';
const db=process.env.TEST_DATABASE_URL;if(!db||!new URL(db).pathname.endsWith('_test'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
process.env.DATABASE_URL=db;await migrate();
const suffix=randomUUID().slice(0,8),loginA='ui-a-'+suffix,loginB='ui-b-'+suffix,password='SYNTHETIC_UI_PASSWORD_ONLY';
const users=[await provisionTeamUser({login:loginA,password,label:'SYNTHETIC UI A'}),await provisionTeamUser({login:loginB,password,label:'SYNTHETIC UI B'})];
const origin='http://127.0.0.1:3009';let server, browser;
try{
 server=spawn(process.execPath,['../../node_modules/next/dist/bin/next','dev','--webpack','--hostname','127.0.0.1','--port','3009'],{cwd:'apps/web',env:{...process.env,DATABASE_URL:db,PHASE2_ENABLED:'true',TEAM_PUBLIC_ORIGIN:origin,TEAM_VAULT_MASTER_KEY:'',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
 let exited=false;server.on('exit',()=>{exited=true;});server.stdout.on('data',()=>{});server.stderr.on('data',()=>{});
 const deadline=Date.now()+45000;let ready=false;while(Date.now()<deadline&&!exited){try{if((await fetch(origin+'/team')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}
 assert.ok(ready,'ISOLATED_NEXT_SERVER_NOT_READY');
 browser=await chromium.launch({headless:true});
 const a=await browser.newContext(),b=await browser.newContext(),pa=await a.newPage(),pb=await b.newPage();
 for(const[page,login]of[[pa,loginA],[pb,loginB]]as const){
  await page.goto(origin+'/team');await page.getByLabel('로그인 ID').fill(login);await page.getByLabel('비밀번호',{exact:true}).fill(password);await page.getByRole('button',{name:'로그인',exact:true}).click();
  await page.getByRole('heading',{name:'본인 Notion 연결'}).waitFor();
  assert.equal(await page.getByLabel('본인 연결 키').isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'본인 회사 로그인 세션 준비'}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'미리보기 실행',exact:true}).isDisabled(),true);
 }
 const sa=await(await a.request.get(origin+'/api/team/connections')).json(),sb=await(await b.request.get(origin+'/api/team/connections')).json();
 assert.notEqual(sa.id,sb.id);assert.equal(sa.vaultReady,false);assert.equal(sa.writesEnabled,false);assert.equal(sa.scheduleEnabled,false);
 assert.equal((await a.request.get(origin+'/api/dashboard')).status(),404);
 assert.equal((await a.request.post(origin+'/api/manual-sync',{data:{requestId:randomUUID()}})).status(),404);
 await pa.goto(origin+'/');assert.equal(new URL(pa.url()).pathname,'/team');
 await pa.getByRole('button',{name:'로그아웃'}).click();await pa.getByRole('heading',{name:'서비스 로그인'}).waitFor();
 assert.equal((await a.request.get(origin+'/api/team/connections')).status(),401);assert.equal((await b.request.get(origin+'/api/team/connections')).status(),200);
 console.log(JSON.stringify({suite:'team-ui-e2e',passed:1,checks:10,realProviders:false,externalWrites:0}));
}finally{
 await browser?.close();server?.kill('SIGTERM');
 if(server)await Promise.race([new Promise<void>(r=>server!.once('exit',()=>r())),new Promise<void>(r=>setTimeout(r,2000))]);
 for(const u of users){await query('DELETE FROM team_preview_runs WHERE tenant_id=$1',[u.tenantId]);await query('DELETE FROM team_secrets WHERE tenant_id=$1',[u.tenantId]);await query('DELETE FROM team_connections WHERE tenant_id=$1',[u.tenantId]);await query('DELETE FROM team_browser_sessions WHERE tenant_id=$1',[u.tenantId]);await query('DELETE FROM team_sessions WHERE tenant_id=$1',[u.tenantId]);await query('DELETE FROM team_users WHERE tenant_id=$1',[u.tenantId]);await query('DELETE FROM team_tenants WHERE id=$1',[u.tenantId]);}
 await closeDb();
}
