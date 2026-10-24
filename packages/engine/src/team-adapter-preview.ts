import { createManualSyncIdentityHasher,readManualSyncCompanySummary,readManualSyncNotionSummary,buildManualSyncPreviewPlan,type ManualSyncNotionInventory } from './manual-sync-plan.ts';
import { readWithdrawalRequestSummary,type CompanyWithdrawalRequestInventory,type VerifiedWithdrawalStatusMapping } from './withdrawal-plan.ts';
import type { CompanyAdapter } from './ports.ts';
import type { TeamPreviewProvider,TeamPreviewSummary } from './team-providers.ts';
import { auditEvent } from './audit-log.ts';
export type TeamPreviewInput=Parameters<TeamPreviewProvider['preview']>[0];
export interface TeamReadAdapters{
 company:CompanyAdapter;notion:ManualSyncNotionInventory;withdrawals:CompanyWithdrawalRequestInventory;
 withdrawalMapping?:VerifiedWithdrawalStatusMapping;
}
/** Reuses the existing coverage/UID/withdrawal planner; no mutation ports are exposed.
 * Factory MUST create fresh adapters for this tenant/session/revision; global legacy runtime is not used.
 * HMAC key is operator-injected. This class never generates or reads a credential.
 */
export class ScopedTeamAdapterPreview implements TeamPreviewProvider{
 readonly available=true;
 constructor(private readonly make:(scope:TeamPreviewInput)=>Promise<TeamReadAdapters>,private readonly previewKey:Uint8Array){
  createManualSyncIdentityHasher('validation',previewKey);
 }
 async preview(input:TeamPreviewInput):Promise<TeamPreviewSummary>{
  await input.assertCurrent();const adapters=await this.make(input);
  const hash=createManualSyncIdentityHasher(input.tenantId,this.previewKey),guard=input.assertCurrent;
  const company=await readManualSyncCompanySummary(adapters.company,input.tenantId,hash,guard);
  await auditEvent({stage:'collect',outcome:'succeeded',provider:'company',operation:'read',counts:{members:company.length}});
  const notion=await readManualSyncNotionSummary(adapters.notion,input.tenantId,hash,guard);
  const withdrawals=await readWithdrawalRequestSummary(adapters.withdrawals,input.tenantId,hash,guard);
  await guard();const plan=buildManualSyncPreviewPlan(company,notion,{withdrawalRequests:withdrawals,withdrawalStatusMapping:adapters.withdrawalMapping});
  await auditEvent({stage:'plan',outcome:'succeeded',provider:'local',operation:'transform',counts:{members:company.length,held:plan.members.filter(m=>m.decision==='review').length}});
  return{members:company.length,matched:plan.members.filter(m=>m.reason==='already_exists').length,held:plan.members.filter(m=>m.decision==='review').length,creates:plan.members.filter(m=>m.decision==='planned_add').length,updates:plan.members.filter(m=>m.decision==='planned_status_update').length};
 }
}
