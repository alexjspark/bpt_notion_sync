import{ScopedTeamAdapterPreview}from'./team-adapter-preview.ts';import{TeamNotionInventory}from'./team-notion-inventory.ts';
import{CountedCompanyPreviewAdapter}from'./live-company-counted-preview.ts';import{readCompanyCurrentAccountInPage,COMPANY_CURRENT_ACCOUNT_URL}from'./company-current-account.ts';
import type{TeamOwnedBrowser}from'./team-owned-browser.ts';import type{NotionTransport}from'./live-notion-client.ts';
import type{TeamPreviewProvider}from'./team-providers.ts';import{TeamError}from'./team-errors.ts';
/** Same read-only planner as phase 1, but fresh tenant-owned browser, key and exact destination every run. */
export class TeamReadOnlyRuntime implements TeamPreviewProvider{
 readonly available=true;
 constructor(private readonly browser:TeamOwnedBrowser,private readonly transport:NotionTransport,private readonly previewKey:Uint8Array){}
 async preview(input:Parameters<TeamPreviewProvider['preview']>[0]){
  await input.assertCurrent();const lease=await this.browser.open(input);
  try{
   const verify=async()=>{await input.assertCurrent();const current=await readCompanyCurrentAccountInPage(lease.page);if(current.uid!==input.binding.accountId||current.trainerId!==input.binding.trainerId)throw new TeamError('ACCOUNT_CHANGED');};
   await verify();const source=new CountedCompanyPreviewAdapter(lease.page,{mode:'counted-ui',scopeApproved:true,evidence:{reference:'team-owned-readonly-session',verifiedAt:new Date().toISOString()},accountResponse:{endpoint:COMPANY_CURRENT_ACCOUNT_URL,expected:{uid:input.binding.accountId,trainerId:input.binding.trainerId},evidence:{reference:'server-confirmed-account-binding',verifiedAt:new Date().toISOString()}}},input.tenantId,()=>readCompanyCurrentAccountInPage(lease.page));
   const notion=new TeamNotionInventory(input.tenantId,input.token,input.destination,this.transport,verify),withdrawalMapping=await notion.withdrawalMapping();
   const p=new ScopedTeamAdapterPreview(async()=>({company:source,notion,withdrawals:source,withdrawalMapping}),this.previewKey);
   return await p.preview({...input,assertCurrent:verify});
  }finally{await lease.release();}
 }
}
