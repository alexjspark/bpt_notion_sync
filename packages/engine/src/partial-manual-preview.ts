import { buildManualSyncPreviewPlan } from './manual-sync-plan.ts';
import type { ManualSyncCompanySummary, ManualSyncNotionSummary } from './manual-sync-plan.ts';
import type { VerifiedWithdrawalStatusMapping, WithdrawalRequestSummary } from './withdrawal-plan.ts';

export interface CompanyObservedUiSnapshot {
  version: 1; scope: 'observed-ui-only'; origin: 'https://admin.biz-pt.com'; memberPath: '/manage/members';
  progressHeader: string; progressFilter: string; progressFilterValue: string; verifiedActiveRowValue: string;
  progressOptions: Array<{ label: string; value: string }>;
  totals: { all: number; filtered: number } | null;
  members: Array<{ uid: string; name: string; activity: string; cellCount: number }>;
  requestsPath: '/manage/self-withdrawals'; requestsHeading: string; requestScopeConfirmedByHuman: true;
  requests: Array<{ uid: string; name: string; cellCount: number }>;
}
export function parseCompanyObservedUiSnapshot(value: unknown): CompanyObservedUiSnapshot {
  if (!value || typeof value !== 'object') throw new Error('UI_SNAPSHOT_INVALID');
  const v = value as CompanyObservedUiSnapshot;
  if (v.version !== 1 || v.scope !== 'observed-ui-only' || v.origin !== 'https://admin.biz-pt.com'
    || v.memberPath !== '/manage/members' || v.progressHeader !== '\uc9c4\ud589 \uc5ec\ubd80'
    || v.progressFilter !== '\uc9c4\ud589' || v.progressFilterValue !== 'Y' || v.verifiedActiveRowValue !== 'Y'
    || !Array.isArray(v.progressOptions) || v.progressOptions.filter(o=>o.label === '\uc9c4\ud589' && o.value === 'Y').length !== 1
    || v.progressOptions.filter(o=>o.label === '\ud0c8\ud1f4' && o.value === 'N').length !== 1
    || v.requestsPath !== '/manage/self-withdrawals' || v.requestsHeading !== '\ud68c\uc6d0 \ud0c8\ud1f4 \uc694\uccad \ub9ac\uc2a4\ud2b8'
    || v.requestScopeConfirmedByHuman !== true || !Array.isArray(v.members) || !Array.isArray(v.requests)) throw new Error('UI_SNAPSHOT_INVALID');
  for (const [rows, cells] of [[v.members,15],[v.requests,10]] as const) {
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r || typeof r.uid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(r.uid) || seen.has(r.uid)
        || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 300 || r.cellCount !== cells) throw new Error('UI_SNAPSHOT_INVALID');
      seen.add(r.uid);
    }
  }
  if (v.members.some(m=>m.activity !== 'Y')) throw new Error('UI_SNAPSHOT_INVALID');
  if (v.totals !== null && (!Number.isSafeInteger(v.totals.all) || !Number.isSafeInteger(v.totals.filtered)
    || v.totals.all < v.totals.filtered || v.totals.filtered < v.members.length)) throw new Error('UI_SNAPSHOT_INVALID');
  return structuredClone(v);
}
/** Standalone observed-source preview. It cannot promote ordinary runtime readiness. */
export function buildPartialManualSyncPreviewPlan(company: ManualSyncCompanySummary[], notion: ManualSyncNotionSummary, options: {
  unknownNotionIdentityRows: number; withdrawalRequests: WithdrawalRequestSummary[]; withdrawalStatusMapping?: VerifiedWithdrawalStatusMapping;
}) {
  if (!Number.isSafeInteger(options.unknownNotionIdentityRows) || options.unknownNotionIdentityRows < 0) throw new Error('PARTIAL_INVENTORY_INVALID');
  const plan = buildManualSyncPreviewPlan(company, {...notion,unknownIdentityRows:options.unknownNotionIdentityRows}, options);
  return { ...plan, inventoryMode: 'partial' as const, companyCoverage: 'observed_subset' as const, sourceScope: 'observed-ui-only' as const,
    canProveAbsence: options.unknownNotionIdentityRows === 0, unknownNotionIdentityRows: options.unknownNotionIdentityRows,
    members: plan.members.map(member=>member.decision === 'planned_add' && options.unknownNotionIdentityRows > 0
      ? { memberKey: member.memberKey, decision: 'review' as const, reason: 'notion_identity_unresolved' as const } : member),
    withdrawal: { ...plan.withdrawal, coverage: 'observed_only' as const }, ordinaryRuntimeReady: false as const };
}