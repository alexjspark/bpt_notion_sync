import{chromium}from'@playwright/test';import{query}from'@trainer/db';
import{activeBrowser,type BrowserScope}from'../../packages/engine/src/team-browser-store.ts';import{browserNames}from'../../packages/engine/src/team-browser-driver.ts';
import{physicalFixture}from'./services.ts';import type{PhysicalConfig}from'./config.ts';import{TeamError}from'../../packages/engine/src/team-errors.ts';
/** Test-only reader. No company URL, account response, cookie or external transport is used. */
export function physicalInspector(config:PhysicalConfig){
 return{inspect:async(scope:BrowserScope)=>{
  const fixture=await physicalFixture(config,scope.tenantId);if(!await activeBrowser(scope)||(await query("SELECT 1 FROM team_browser_allocations WHERE tenant_id=$1 AND session_id=$2 AND status='ready'",[scope.tenantId,scope.sessionId])).rowCount!==1)throw new TeamError('NOT_READY');
  const browser=await chromium.connectOverCDP('http://'+browserNames(scope).container+':9222',{timeout:10000});
  try{
   const contexts=browser.contexts();if(contexts.length!==1)throw new TeamError('NOT_READY');const pages=contexts[0]!.pages();if(pages.length!==1||pages[0]!.url()!=='about:blank')throw new TeamError('ACCOUNT_UNVERIFIED');
   const page=pages[0]!,wanted=JSON.stringify([config.runId,scope.tenantId,scope.sessionId,fixture.which]);
   const matched=await page.evaluate(value=>{if(location.href!=='about:blank')return false;const root=document.documentElement;if(root.dataset.physicalOwner&&root.dataset.physicalOwner!==value.marker)return false;root.dataset.physicalOwner=value.marker;document.title='TEST '+value.which;document.body.style.cssText='background:'+value.color+';color:white;font:42px system-ui;padding:70px';document.body.textContent='TEST TrainerSync · '+value.which+' · synthetic only';return true;},{marker:wanted,which:fixture.which,color:fixture.which==='A'?'#164e63':'#581c87'});
   if(!matched||!await activeBrowser(scope))throw new TeamError('ACCOUNT_CHANGED');return fixture.binding;
  }finally{await browser.close();}
 }};
}
