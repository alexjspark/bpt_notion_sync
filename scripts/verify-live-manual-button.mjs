import{open}from'node:fs/promises';import{chromium}from'@playwright/test';
let file,context,phase='connect',clicked=false,runId=null;
try{
 file=await open('/out/live-button-preview-20261024.json','wx',0o600);
 const browser=await chromium.connectOverCDP('http://company-browser:9222',{timeout:12000});
 context=await browser.newContext({baseURL:'http://web:3000'});const page=await context.newPage();page.setDefaultTimeout(15000);
 await page.route('**/api/manual-sync',async route=>{
   const req=route.request();if(new URL(req.url()).origin!=='http://web:3000'){await route.abort();return;}
   if(req.method()!=='POST'){await route.continue();return;}
   const response=await route.fetch({headers:{...await req.allHeaders(),origin:'http://127.0.0.1:4310'},maxRedirects:0});await route.fulfill({response});
 });
 phase='readiness';const initial=await(await context.request.get('http://web:3000/api/manual-sync')).json();
 if(initial.connected!==true||initial.externalWritesEnabled!==false||initial.automaticSyncEnabled!==false)throw new Error('READINESS_REQUIRED');
 phase='ui';await page.goto('http://web:3000/',{waitUntil:'domcontentloaded'});const panel=page.locator('#manual-sync');const button=panel.locator('.manual-sync-button');await button.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#manual-sync .manual-sync-button')?.disabled);
 const posted=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/manual-sync'&&r.request().method()==='POST',{timeout:15000});
 phase='submit';await button.click();clicked=true;const response=await posted;if(response.status()!==202)throw new Error('POST_REJECTED');const accepted=await response.json();runId=accepted.run?.id;if(!runId)throw new Error('RUN_ID_MISSING');
 phase='worker';let completed;
 for(let i=0;i<45;i++){const state=await(await context.request.get('http://web:3000/api/manual-sync',{timeout:15000})).json();const run=state.runs?.find(r=>r.id===runId);
   if(run&&['succeeded','failed','needs_connection'].includes(run.status)){completed=run;break;}await new Promise(resolve=>setTimeout(resolve,2000));}
 if(!completed)throw new Error('RUN_WAIT_TIMEOUT');
 phase='ui-result';const values=['plannedAdds','skipped','review','failed','added'].map(k=>completed.counts[k]===null?'\u2014':String(completed.counts[k]));
 await page.waitForFunction(expected=>{const actual=Array.from(document.querySelectorAll('#manual-sync .manual-latest .manual-counts dd'),n=>n.textContent.trim());return actual.length===expected.length&&actual.every((n,i)=>n===expected[i]);},values,{timeout:20000});
 const uiCounts=await panel.locator('.manual-latest .manual-counts dd').allTextContents();
 const text=await panel.innerText();const report={mode:'actual_button_queue_worker_preview',runId,status:completed.status,stage:completed.stage,counts:completed.counts,
   companyCount:completed.previewPlan?.companyCount??null,notionIdentities:completed.previewPlan?.notionIdentityCount??null,notionIdentityCoverage:completed.previewPlan?.notionIdentityCoverage??null,unresolvedNotionRows:completed.previewPlan?.unresolvedNotionRows??null,
   withdrawal:completed.previewPlan?.withdrawal??null,errorCode:completed.errorCode,uiCounts,uiPartialNoteShown:text.includes('\ubd80\ubd84 \ubbf8\ub9ac\ubcf4\uae30 \uc644\ub8cc'),accountBinding:'current-user-uid-and-trainerId',
   externalWritesEnabled:false,automaticSyncEnabled:false,rawPersonalValuesLogged:false,canonicalOriginAdaptedForDockerUi:true};
 await file.writeFile(JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));await context.close();await file.close();process.exit(completed.status==='succeeded'?0:1);
}catch(e){const codes=['READINESS_REQUIRED','POST_REJECTED','RUN_ID_MISSING','RUN_WAIT_TIMEOUT'];const report={mode:'actual_button_queue_worker_preview',status:'not_completed',phase,clicked,runId,
 code:codes.includes(e?.message)?e.message:e?.code==='EEXIST'?'EXISTING_RECEIPT_NO_RETRY':'UI_OR_EXECUTION_FAILED',externalWritesEnabled:false,automaticSyncEnabled:false};
 if(file){await file.writeFile(JSON.stringify(report,null,2)+'\n');await file.close();}if(context)await context.close().catch(()=>{});console.log(JSON.stringify(report));process.exit(1);}
