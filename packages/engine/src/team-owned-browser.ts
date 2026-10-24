import{activeBrowser,type BrowserScope}from'./team-browser-store.ts';
import{browserNames}from'./team-browser-driver.ts';import{TeamError}from'./team-errors.ts';
import{readCompanyCurrentAccountInPage}from'./company-current-account.ts';
import type{CompanyBrowserPage}from'./live-company-types.ts';
import type{CompanyBinding}from'./team-providers.ts';import{query}from'@trainer/db';
export interface BrowserLease{page:CompanyBrowserPage;release:()=>Promise<void>}
export type BrowserConnector=(endpoint:string)=>Promise<BrowserLease>;
/** Trusted worker-only. Endpoint is derived from the active owned session, never supplied by HTTP. */
export class TeamOwnedBrowser{
 constructor(private readonly connector:BrowserConnector){}
 async open(scope:BrowserScope):Promise<BrowserLease>{
  if(!await activeBrowser(scope)||(await query("SELECT 1 FROM team_browser_allocations WHERE tenant_id=$1 AND session_id=$2 AND status='ready'",[scope.tenantId,scope.sessionId])).rowCount!==1)throw new TeamError('NOT_READY');
  const lease=await this.connector('http://'+browserNames(scope).container+':9222');
  if(!await activeBrowser(scope)){await lease.release();throw new TeamError('CONNECTION_CHANGED');}return lease;
 }
 async inspect(scope:BrowserScope):Promise<CompanyBinding>{
  const lease=await this.open(scope);
  try{const account=await readCompanyCurrentAccountInPage(lease.page);if(!await activeBrowser(scope))throw new TeamError('CONNECTION_CHANGED');return{accountId:account.uid,trainerId:account.trainerId};}finally{await lease.release();}
 }
}
