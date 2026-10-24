import { randomBytes } from 'node:crypto';
import { OfficialNotionAdapter } from '../packages/engine/src/live-notion.ts';
import { OfficialNotionClient, object } from '../packages/engine/src/live-notion-client.ts';
import type { NotionTransport } from '../packages/engine/src/live-notion-client.ts';
import { createManualSyncIdentityHasher } from '../packages/engine/src/manual-sync-plan.ts';
import { verifyWithdrawalStatusMapping } from '../packages/engine/src/withdrawal-plan.ts';
import { buildPartialManualSyncPreviewPlan, parseCompanyObservedUiSnapshot } from '../packages/engine/src/partial-manual-preview.ts';
import { parseNotionReadOnlyConfig, restrictNotionCheckTransport } from './notion-readonly-check.ts';

export interface PartialPreviewDependencies { readText(path: string): Promise<string>; transport: NotionTransport }
export async function runNotionPartialPreview(options: { configFile: string; tokenFile: string; companySnapshotFile: string }, dependencies: PartialPreviewDependencies) {
  const config = parseNotionReadOnlyConfig(JSON.parse(await dependencies.readText(options.configFile)));
  const company = parseCompanyObservedUiSnapshot(JSON.parse(await dependencies.readText(options.companySnapshotFile)));
  const token = (await dependencies.readText(options.tokenFile)).trim();
  const members = config.notion!.members;
  const client = new OfficialNotionClient({ token, readPermit: { approved: true },
    transport: restrictNotionCheckTransport(dependencies.transport, members.databaseId, members.dataSourceId), maxRateLimitRetries: 0 });
  const adapter = new OfficialNotionAdapter({ client, members });
  const inventory = await adapter.listPreviewIdentitiesPartial({ trainerId: config.trainerId, scope: 'all_members' });
  const schema = await client.read('/data_sources/' + members.dataSourceId);
  const property = Object.values(object(schema.properties)).map(object).find(p=>p.id === members.status.id && p.type === members.status.type);
  const rawOptions = property ? object(property[members.status.type]).options : undefined;
  const actualOptions = Array.isArray(rawOptions) ? rawOptions.map(object).filter((o): o is Record<string,unknown> & {id:string;name:string}=>typeof o.id === 'string' && typeof o.name === 'string').map(o=>({id:o.id,name:o.name})) : [];
  const optionName = members.createStatus['\ud0c8\ud1f4 \uc694\uccad'];
  const withdrawalStatusMapping = optionName === undefined ? undefined : verifyWithdrawalStatusMapping({
    optionName, dataSourceId: members.dataSourceId, propertyId: members.status.id, actualOptions });
  // Fresh ephemeral hashing is used only for this unpersisted planner call, never a secret-file probe or durable checkpoint.
  const hash = createManualSyncIdentityHasher(config.trainerId, randomBytes(32));
  const identities = new Map<string, number>();
  for (const identity of inventory.identities) identities.set(hash(identity.companyMemberId), (identities.get(hash(identity.companyMemberId)) ?? 0) + 1);
  const plan = buildPartialManualSyncPreviewPlan(company.members.map(m=>({ memberKey:hash(m.uid), classification:'eligible' as const, reason:null })),
    { identities, identityCount:inventory.identities.length, existingStatuses:new Map(inventory.identities.filter(i=>identities.get(hash(i.companyMemberId))===1).map(i=>[hash(i.companyMemberId),i.existingStatus])) }, {
      unknownNotionIdentityRows:inventory.reviewRows.length, withdrawalRequests:company.requests.map(r=>({memberKey:hash(r.uid)})), withdrawalStatusMapping });
  const displayByKey = new Map([...company.members,...company.requests].map(m=>[hash(m.uid),m]));
  const targets = plan.members.map(p=>{
    const display = displayByKey.get(p.memberKey)!;
    const matches = inventory.identities.filter(i=>i.companyMemberId === display.uid);
    return { name:display.name, companyMemberId:display.uid, decision:p.decision, reason:p.reason,
      ...(p.targetStatus ? { targetStatus:p.targetStatus, targetOptionName:p.targetOptionName } : {}),
      existingStatuses:matches.map(m=>m.existingStatus), matchedNotionPages:matches.map(m=>m.pageId) };
  });
  const report = { mode:'partial_dry_run' as const, status:'partial' as const, ordinaryRuntimeReady:false as const,
    companySourceScope:'observed-ui-only' as const, notionQueryCoverage:inventory.queryCoverage, notionIdentityCoverage:inventory.identityCoverage,
    canProveAbsence:inventory.canProveAbsence, companyObservedMembers:company.members.length, withdrawalObservedRequests:company.requests.length,
    notionRows:inventory.identities.length+inventory.reviewRows.length, validNotionIdentityRows:inventory.identities.length,
    plannedAdds:targets.filter(t=>t.decision==='planned_add').length, plannedStatusUpdates:targets.filter(t=>t.decision==='planned_status_update').length,
    preservedCompanyMembers:targets.filter(t=>t.decision==='skip').length, heldCompanyMembers:targets.filter(t=>t.decision==='review').length,
    heldNotionRows:inventory.reviewRows.length, externalWritesEnabled:false as const, automaticSyncEnabled:false as const,
    calendarPolicy:'continue_existing_training' as const };
  return { report, detail:{ version:1, report, sourceLimits:[
    'Observed company UI snapshot only; its collection provenance does not promote account binding or ordinary worker readiness.',
    'Members UI filtered count ' + (company.totals?.filtered ?? 'unknown') + '; observed ' + company.members.length + '.',
    'Withdrawal requests are from the user-confirmed assigned-pending self-withdrawals screen; completeness beyond the observed UI is not claimed.',
    'Notion query completed two stable passes; unresolved rows block all unmatched new-member plans.',
  ], targets, notionReviewRows:inventory.reviewRows } };
}