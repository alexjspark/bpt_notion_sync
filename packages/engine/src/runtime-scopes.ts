/** Non-secret destination/approval metadata supplied only by server-owned private configuration. */
export interface NotionDestinationScope { databaseId:string; dataSourceId:string }
export interface ApprovedContactTarget { uid:string; pageId:string; name:string }
export interface ContactApprovalScope { consentKey:string; targets:ApprovedContactTarget[] }
export interface IsolatedTestFixture { suiteKey:string; pageId:string; testId:string }
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function parseNotionDestination(value:unknown):NotionDestinationScope {
 const v=value&&typeof value==='object'?value as Record<string,unknown>:{};
 if(typeof v.databaseId!=='string'||typeof v.dataSourceId!=='string'||!UUID.test(v.databaseId)||!UUID.test(v.dataSourceId)||v.databaseId===v.dataSourceId)throw Error('LIVE_NOTION_TARGET_INVALID');
 return Object.freeze({databaseId:v.databaseId,dataSourceId:v.dataSourceId});
}
export function parseContactApproval(value:unknown):ContactApprovalScope {
 const v=value&&typeof value==='object'?value as Record<string,unknown>:{};
 if(typeof v.consentKey!=='string'||!v.consentKey||!Array.isArray(v.targets)||v.targets.length!==2)throw Error('CONTACT_SAVE_TARGET_SCOPE_INVALID');
 const targets=v.targets.map(raw=>{const t=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
  if(typeof t.uid!=='string'||!/^\d+$/.test(t.uid)||typeof t.pageId!=='string'||!UUID.test(t.pageId)||typeof t.name!=='string'||!t.name.trim()||t.name.length>250)throw Error('CONTACT_SAVE_TARGET_SCOPE_INVALID');
  return{uid:t.uid,pageId:t.pageId,name:t.name};
 });
 if(new Set(targets.map(t=>t.uid)).size!==2||new Set(targets.map(t=>t.pageId)).size!==2)throw Error('CONTACT_SAVE_TARGET_SCOPE_INVALID');
 return{consentKey:v.consentKey,targets};
}
export function parseIsolatedTestFixture(value:unknown):IsolatedTestFixture {
 const v=value&&typeof value==='object'?value as Record<string,unknown>:{};
 if(typeof v.suiteKey!=='string'||!v.suiteKey||typeof v.pageId!=='string'||!UUID.test(v.pageId)||typeof v.testId!=='string'||!v.testId.startsWith('trainersync-test-')||!UUID.test(v.testId.slice('trainersync-test-'.length)))throw Error('ISOLATED_FIXTURE_INVALID');
 return{suiteKey:v.suiteKey,pageId:v.pageId,testId:v.testId};
}

export function assertRunDestination(report:unknown,current:NotionDestinationScope):void{
 const r=report&&typeof report==='object'?report as Record<string,unknown>:{};const pinned=parseNotionDestination(r.destination),configured=parseNotionDestination(current);
 if(pinned.databaseId!==configured.databaseId||pinned.dataSourceId!==configured.dataSourceId)throw Error('APPROVAL_DESTINATION_CHANGED');
}
