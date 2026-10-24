import{chromium}from'@playwright/test';
import type{BrowserConnector}from'../../packages/engine/src/team-owned-browser.ts';import{TeamError}from'../../packages/engine/src/team-errors.ts';
/** Used only by the trusted worker on tenant-internal networks; never the personal Chrome profile. */
export const dedicatedCompanyConnector:BrowserConnector=async endpoint=>{
 if(!/^http:\/\/ts-team-browser-[a-f0-9]{32}:9222$/.test(endpoint))throw new TeamError('RUNNER_SCOPE_INVALID');
 const browser=await chromium.connectOverCDP(endpoint,{timeout:12000});
 try{
  const contexts=browser.contexts();if(contexts.length!==1)throw new TeamError('NOT_READY');
  const pages=contexts[0]!.pages().filter(p=>p.url().startsWith('https://admin.biz-pt.com/'));
  if(pages.length>1)throw new TeamError('NOT_READY');
  const page=pages[0]??await contexts[0]!.newPage();page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(12000);
  if(!pages.length)await page.goto('https://admin.biz-pt.com/manage/members',{waitUntil:'domcontentloaded'});
  // Browser.close on a connected Playwright browser disconnects this connection; the runner owns container stop.
  return{page,release:()=>browser.close()};
 }catch{await browser.close();throw new TeamError('ACCOUNT_UNVERIFIED');}
};
