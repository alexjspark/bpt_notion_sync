import { closeDb, migrate, seed } from '@trainer/db';
import { assertMockMode, createLiveReadOnlyRuntime, LIVE_MANUAL_TRAINER_ID, publishLiveReadOnlyState, runWorkerTick } from '@trainer/engine';
import type { LiveReadOnlyRuntime } from '@trainer/engine';
import type { Page } from '@playwright/test';
import {readCompanyCurrentAccountInPage,runIsolatedStorageTestOnce,runContactSaveOnce,runProfileSaveOnce,pruneAuditLog,closeAuditLog} from '@trainer/engine';
import { workerLiveSettings } from './live-settings.ts';

assertMockMode();
const liveSettings=workerLiveSettings(process.env);
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});
await migrate();
await seed();
console.log('Mock worker ready. Mock daily company schedule defaults OFF.');
let live:LiveReadOnlyRuntime|undefined;
let companyPage:Page|undefined;
if(liveSettings){
  try{
    live=await createLiveReadOnlyRuntime(liveSettings,
    {openCompanyPage:async endpoint=>{
      if(companyPage&&!companyPage.isClosed())return companyPage;
      const {chromium}=await import('@playwright/test');
      const browser=await chromium.connectOverCDP(endpoint,{timeout:15000});
      const context=browser.contexts()[0];
      if(!context)throw new Error('LIVE_COMPANY_CONTEXT_UNAVAILABLE');
      companyPage=context.pages().find(page=>page.url().startsWith('https://admin.biz-pt.com/'))??await context.newPage();
      companyPage.setDefaultTimeout(15000);companyPage.setDefaultNavigationTimeout(15000);
      return companyPage;
    },readCompanyAccount:async()=>{if(!companyPage)throw new Error('COMPANY_ACCOUNT_UNAVAILABLE');return readCompanyCurrentAccountInPage(companyPage);}});
    console.log('Read-only manual connection lane enabled. External writes and daily company scheduling remain OFF.');
  }catch{
    // Raw exceptions may contain filenames, URLs or credentials. Store/report fixed public status only.
    await publishLiveReadOnlyState(LIVE_MANUAL_TRAINER_ID,{companyStatus:'needs_verification',notionStatus:'needs_verification',previewKeyReady:false});
    console.error('Read-only manual configuration requires verification.');
  }
}
let nextPreflight=0;
let nextHeartbeat=0;let nextAuditPrune=0;
while(!stopping){
  try{await runWorkerTick();}catch(error){console.error('Worker tick failed:',error instanceof Error?error.name:'unknown');}
  if(live){
    try{
      if(Date.now()>=nextPreflight){await live.preflight();nextPreflight=Date.now()+300000;}
      if(Date.now()>=nextHeartbeat){await publishLiveReadOnlyState(live.trainerId,live.state);nextHeartbeat=Date.now()+5000;}
      await live.tick();
      if(liveSettings)await runIsolatedStorageTestOnce({configFile:liveSettings.configFile,tokenFile:liveSettings.notionTokenFile,readCurrentAccount:async()=>{if(!companyPage)throw new Error('COMPANY_ACCOUNT_UNAVAILABLE');return readCompanyCurrentAccountInPage(companyPage);}});
      if(liveSettings&&companyPage)await runContactSaveOnce({configFile:liveSettings.configFile,tokenFile:liveSettings.notionTokenFile,hmacFile:liveSettings.previewKeyFile,companyPage});
      if(liveSettings&&companyPage)await runProfileSaveOnce({configFile:liveSettings.configFile,tokenFile:liveSettings.notionTokenFile,hmacFile:liveSettings.previewKeyFile,companyPage});
    }catch{console.error('Manual preview or isolated TEST tick requires attention. Ordinary member writes remain disabled.');}
  }
  if(Date.now()>=nextAuditPrune){nextAuditPrune=Date.now()+300000;void pruneAuditLog().catch(()=>console.warn('AUDIT_RETENTION_REQUIRES_ATTENTION'));}
  if(!stopping)await new Promise(resolve=>setTimeout(resolve,1000));
}
await closeAuditLog();await closeDb();
console.log('Mock worker stopped after completing current tick.');
