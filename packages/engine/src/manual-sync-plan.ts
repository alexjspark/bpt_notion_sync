import { createHmac } from 'node:crypto';
import type { NotionPartialPreviewInventory } from './live-notion-types.ts';
import type { CompanyAdapter } from './ports.ts';
import { buildWithdrawalRequestPreview } from './withdrawal-plan.ts';
import type { VerifiedWithdrawalStatusMapping, WithdrawalPreviewMetadata, WithdrawalRequestSummary } from './withdrawal-plan.ts';
export * from './withdrawal-plan.ts';

export type ManualSyncDecision = 'planned_add' | 'planned_status_update' | 'skip' | 'review';
export type ManualSyncReason = 'missing_in_notion' | 'already_exists' | 'excluded_status' | 'withdrawn_member'
  | 'unknown_status' | 'unknown_activity' | 'duplicate_notion_identity'
  | 'withdrawal_request_matched' | 'withdrawal_status_already_set' | 'withdrawal_member_missing' | 'withdrawal_status_unverified' | 'notion_identity_unresolved';
export interface ManualSyncPreviewMember { memberKey: string; decision: ManualSyncDecision; reason: ManualSyncReason; targetStatus?: '신규' | '탈퇴 요청'; targetOptionName?: string; targetOptionId?: string }
export interface ManualSyncPreviewPlan {
  version: 1;
  mode: 'dry_run';
  companyCoverage: 'active_assigned';
  sourceScope: 'active-assigned';
  companyCount: number;
  notionIdentityCount: number;
  notionIdentityCoverage?: 'complete' | 'partial';
  unresolvedNotionRows?: number;
  members: ManualSyncPreviewMember[];
  withdrawal: WithdrawalPreviewMetadata;
}
/** This port deliberately has no page-creation, patch, template or calendar methods. */
export interface ManualSyncNotionInventory {
  listPreviewIdentitiesPartial?(input: {trainerId:string;scope:'all_members'}): Promise<NotionPartialPreviewInventory>;
  listIdentities(input: { trainerId: string; cursor: string | null; scope: 'all_members' }): Promise<{
    identities: Array<{ trainerId: string; companyMemberId: string; pageId: string; existingStatus?: string | null }>;
    nextCursor: string | null;
    scope: 'all_members';
    completeCoverage: boolean;
    snapshotId: string;
  }>;
}
export type ManualSyncErrorCode = 'COMPANY_COVERAGE_UNVERIFIED' | 'COMPANY_SNAPSHOT_CHANGED' | 'COMPANY_PAGINATION_INVALID'
  | 'COMPANY_CONFLICTING_DUPLICATE' | 'NOTION_COVERAGE_UNVERIFIED' | 'NOTION_SNAPSHOT_CHANGED' | 'NOTION_PAGINATION_INVALID'
  | 'TENANT_MISMATCH' | 'INVALID_IDENTITY' | 'PREVIEW_KEY_REQUIRED' | 'MANUAL_SYNC_LEASE_LOST'
  | 'READ_FAILED' | 'READ_RETRYABLE' | 'READ_RATE_LIMITED' | 'READ_AUTH_REQUIRED' | 'WORKER_INTERRUPTED' | 'EXECUTION_BUSY'
  | 'COMPANY_ACCOUNT_BINDING_UNVERIFIED' | 'COMPANY_ACCOUNT_MISMATCH' | 'COMPANY_FILTER_SCOPE_PARTIAL' | 'COMPANY_ROW_SHAPE_MISMATCH' | 'WITHDRAWAL_COVERAGE_UNVERIFIED' | 'WITHDRAWAL_SNAPSHOT_CHANGED' | 'WITHDRAWAL_PAGINATION_INVALID' | 'WITHDRAWAL_IDENTITY_INVALID';
const safeErrorCodes: ReadonlySet<string> = new Set([
  'COMPANY_COVERAGE_UNVERIFIED', 'COMPANY_SNAPSHOT_CHANGED', 'COMPANY_PAGINATION_INVALID', 'COMPANY_CONFLICTING_DUPLICATE',
  'NOTION_COVERAGE_UNVERIFIED', 'NOTION_SNAPSHOT_CHANGED', 'NOTION_PAGINATION_INVALID', 'TENANT_MISMATCH', 'INVALID_IDENTITY',
  'PREVIEW_KEY_REQUIRED', 'MANUAL_SYNC_LEASE_LOST', 'READ_FAILED', 'READ_RETRYABLE', 'READ_RATE_LIMITED', 'READ_AUTH_REQUIRED', 'WORKER_INTERRUPTED', 'EXECUTION_BUSY',
  'COMPANY_ACCOUNT_BINDING_UNVERIFIED', 'COMPANY_ACCOUNT_MISMATCH', 'COMPANY_FILTER_SCOPE_PARTIAL', 'COMPANY_ROW_SHAPE_MISMATCH', 'WITHDRAWAL_COVERAGE_UNVERIFIED', 'WITHDRAWAL_SNAPSHOT_CHANGED', 'WITHDRAWAL_PAGINATION_INVALID', 'WITHDRAWAL_IDENTITY_INVALID',
]);
export function isManualSyncErrorCode(value: unknown): value is ManualSyncErrorCode {
  return typeof value === 'string' && safeErrorCodes.has(value);
}
export class ManualSyncError extends Error {
  constructor(public readonly code: ManualSyncErrorCode, public readonly retryable = false, public readonly retryAfterMs = 0) {
    super(code); this.name = 'ManualSyncError';
  }
}
export interface ManualSyncCompanySummary {
  memberKey: string;
  classification: 'eligible' | 'excluded' | 'review';
  reason: 'excluded_status' | 'withdrawn_member' | 'unknown_status' | 'unknown_activity' | null;
}
const pageLimit = 1000;

/** A nonpersisted, injected secret prevents guessing low-entropy company identifiers. */
export function createManualSyncIdentityHasher(trainerId: string, key: string | Uint8Array): (companyMemberId: string) => string {
  if (Buffer.byteLength(key) < 32) throw new ManualSyncError('PREVIEW_KEY_REQUIRED');
  return companyMemberId => createHmac('sha256', key).update(JSON.stringify(['manual-sync-preview-v1', trainerId, companyMemberId])).digest('hex');
}
export function manualSyncKeyFingerprint(key: string | Uint8Array): string {
  if (Buffer.byteLength(key) < 32) throw new ManualSyncError('PREVIEW_KEY_REQUIRED');
  return createHmac('sha256', key).update('manual-sync-checkpoint-active-membership-v2').digest('hex');
}
function assertIdentity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) throw new ManualSyncError('INVALID_IDENTITY');
}
function classification(_status: string, activity: string): Pick<ManualSyncCompanySummary, 'classification' | 'reason'> {
  // Company 진행 is membership activity, never the user's Notion workflow state.
  if (activity !== 'active' && activity !== 'withdrawn') return { classification: 'review', reason: 'unknown_activity' };
  if (activity === 'withdrawn') return { classification: 'excluded', reason: 'withdrawn_member' };
  return { classification: 'eligible', reason: null };
}

/** Complete source rows live only in this call's memory; the returned checkpoint is allowlisted. */
export async function readManualSyncCompanySummary(
  company: CompanyAdapter, trainerId: string, hashIdentity: (id: string) => string, guard: () => Promise<void> = async () => {},
): Promise<ManualSyncCompanySummary[]> {
  const found = new Map<string, { serialized: string; summary: ManualSyncCompanySummary }>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let snapshot: string | undefined;
  for (let index = 0; index < pageLimit; index++) {
    await guard();
    const page = await company.listMembers({ trainerId, cursor, scope: 'all_assigned' });
    await guard();
    if (page.scope !== 'all_assigned' || page.completeCoverage !== true || typeof page.snapshotId !== 'string' || !page.snapshotId || !Array.isArray(page.members)) {
      throw new ManualSyncError('COMPANY_COVERAGE_UNVERIFIED');
    }
    if (snapshot !== undefined && snapshot !== page.snapshotId) throw new ManualSyncError('COMPANY_SNAPSHOT_CHANGED', true);
    snapshot = page.snapshotId;
    for (const member of page.members) {
      if (!member || member.trainerId !== trainerId) throw new ManualSyncError('TENANT_MISMATCH');
      assertIdentity(member.companyMemberId);
      const serialized = JSON.stringify(member);
      const previous = found.get(member.companyMemberId);
      if (previous && previous.serialized !== serialized) throw new ManualSyncError('COMPANY_CONFLICTING_DUPLICATE');
      found.set(member.companyMemberId, { serialized, summary: { memberKey: hashIdentity(member.companyMemberId), ...classification(member.status, member.membershipActivity) } });
    }
    if (page.nextCursor === null) return [...found.values()].map(value => value.summary).sort((a, b) => a.memberKey.localeCompare(b.memberKey));
    if (typeof page.nextCursor !== 'string' || !page.nextCursor || seenCursors.has(page.nextCursor)) throw new ManualSyncError('COMPANY_PAGINATION_INVALID');
    seenCursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new ManualSyncError('COMPANY_PAGINATION_INVALID');
}

export interface ManualSyncNotionSummary { identities: Map<string, number>; identityCount: number; existingStatuses?: ReadonlyMap<string, string | null>; unknownIdentityRows?: number }
export async function readManualSyncNotionSummary(
  notion: ManualSyncNotionInventory, trainerId: string, hashIdentity: (id: string) => string, guard: () => Promise<void> = async () => {},
): Promise<ManualSyncNotionSummary> {
  if (notion.listPreviewIdentitiesPartial) {
    await guard();
    const page = await notion.listPreviewIdentitiesPartial({trainerId,scope:'all_members'});
    await guard();
    if (page.queryCoverage !== 'complete' || !Array.isArray(page.identities) || !Array.isArray(page.reviewRows)
      || typeof page.snapshotId !== 'string' || !page.snapshotId
      || page.identityCoverage !== (page.reviewRows.length ? 'partial' : 'complete')
      || page.canProveAbsence !== (page.reviewRows.length === 0)) throw new ManualSyncError('NOTION_COVERAGE_UNVERIFIED');
    const pages = new Set<string>(), byKey = new Map<string, Set<string>>(), statuses = new Map<string,string|null>();
    for (const identity of page.identities) {
      if (identity.trainerId !== trainerId) throw new ManualSyncError('TENANT_MISMATCH');
      assertIdentity(identity.companyMemberId); assertIdentity(identity.pageId);
      if (pages.has(identity.pageId) || identity.existingStatus !== null && typeof identity.existingStatus !== 'string') throw new ManualSyncError('INVALID_IDENTITY');
      pages.add(identity.pageId);
      const key=hashIdentity(identity.companyMemberId), matched=byKey.get(key)??new Set<string>();
      matched.add(identity.pageId);byKey.set(key,matched);statuses.set(identity.pageId,identity.existingStatus);
    }
    for (const review of page.reviewRows) {
      assertIdentity(review.pageId);
      if (pages.has(review.pageId) || !['missing_admin_url','invalid_admin_url'].includes(review.reason)) throw new ManualSyncError('INVALID_IDENTITY');
      pages.add(review.pageId);
    }
    return {identities:new Map([...byKey].map(([key,ids])=>[key,ids.size])),identityCount:page.identities.length,
      existingStatuses:new Map([...byKey].filter(([,ids])=>ids.size===1).map(([key,ids])=>[key,statuses.get([...ids][0]!)!])),
      unknownIdentityRows:page.reviewRows.length};
  }
  const pagesByIdentity = new Map<string, Set<string>>();
  const statusesByPage = new Map<string, string | null>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let snapshot: string | undefined;
  for (let index = 0; index < pageLimit; index++) {
    await guard();
    const page = await notion.listIdentities({ trainerId, cursor, scope: 'all_members' });
    await guard();
    if (page.scope !== 'all_members' || page.completeCoverage !== true || typeof page.snapshotId !== 'string' || !page.snapshotId || !Array.isArray(page.identities)) {
      throw new ManualSyncError('NOTION_COVERAGE_UNVERIFIED');
    }
    if (snapshot !== undefined && snapshot !== page.snapshotId) throw new ManualSyncError('NOTION_SNAPSHOT_CHANGED', true);
    snapshot = page.snapshotId;
    for (const identity of page.identities) {
      if (!identity || identity.trainerId !== trainerId) throw new ManualSyncError('TENANT_MISMATCH');
      assertIdentity(identity.companyMemberId); assertIdentity(identity.pageId);
      const memberKey = hashIdentity(identity.companyMemberId);
      const pages = pagesByIdentity.get(memberKey) ?? new Set<string>();
      pages.add(identity.pageId); pagesByIdentity.set(memberKey, pages);
      if (identity.existingStatus !== undefined) {
        if (identity.existingStatus !== null && typeof identity.existingStatus !== 'string') throw new ManualSyncError('INVALID_IDENTITY');
        if (statusesByPage.has(identity.pageId) && statusesByPage.get(identity.pageId) !== identity.existingStatus) throw new ManualSyncError('NOTION_SNAPSHOT_CHANGED', true);
        statusesByPage.set(identity.pageId, identity.existingStatus);
      }
    }
    if (page.nextCursor === null) return {
      identities: new Map([...pagesByIdentity].map(([key, pages]) => [key, pages.size])),
      identityCount: [...pagesByIdentity.values()].reduce((total, pages) => total + pages.size, 0),
      existingStatuses: new Map([...pagesByIdentity].filter(([,pages]) => pages.size === 1 && statusesByPage.has([...pages][0]!)).map(([key,pages]) => [key,statusesByPage.get([...pages][0]!)!])),
    };
    if (typeof page.nextCursor !== 'string' || !page.nextCursor || seenCursors.has(page.nextCursor)) throw new ManualSyncError('NOTION_PAGINATION_INVALID');
    seenCursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new ManualSyncError('NOTION_PAGINATION_INVALID');
}

export function buildManualSyncPreviewPlan(company: ManualSyncCompanySummary[], notion: ManualSyncNotionSummary,
  options: { withdrawalRequests?: readonly WithdrawalRequestSummary[]; withdrawalStatusMapping?: VerifiedWithdrawalStatusMapping } = {}): ManualSyncPreviewPlan {
  if (notion.unknownIdentityRows !== undefined && (!Number.isSafeInteger(notion.unknownIdentityRows) || notion.unknownIdentityRows < 0)) throw new ManualSyncError('NOTION_COVERAGE_UNVERIFIED');
  const requestedKeys = new Set(options.withdrawalRequests?.map(request => request.memberKey) ?? []);
  const members: ManualSyncPreviewMember[] = company.filter(member => !requestedKeys.has(member.memberKey)).map(member => {
    const existing = notion.identities.get(member.memberKey) ?? 0;
    if (existing > 1) return { memberKey: member.memberKey, decision: 'review', reason: 'duplicate_notion_identity' };
    if (member.classification === 'review') return { memberKey: member.memberKey, decision: 'review', reason: member.reason! };
    if (member.classification === 'excluded') return { memberKey: member.memberKey, decision: 'skip', reason: member.reason! };
    if (existing === 1) return { memberKey: member.memberKey, decision: 'skip', reason: 'already_exists' };
    if ((notion.unknownIdentityRows ?? 0) > 0) return {memberKey:member.memberKey,decision:'review',reason:'notion_identity_unresolved'};
    return { memberKey: member.memberKey, decision: 'planned_add', reason: 'missing_in_notion', targetStatus: '신규' };
  });
  const withdrawal = options.withdrawalRequests === undefined ? null
    : buildWithdrawalRequestPreview(options.withdrawalRequests, notion.identities, options.withdrawalStatusMapping, notion.existingStatuses);
  if (withdrawal) members.push(...withdrawal);
  return { version: 1, mode: 'dry_run', companyCoverage: 'active_assigned', sourceScope: 'active-assigned', companyCount: company.length,
    notionIdentityCount: notion.identityCount, ...(notion.unknownIdentityRows === undefined ? {} : {notionIdentityCoverage:notion.unknownIdentityRows ? 'partial' as const : 'complete' as const,unresolvedNotionRows:notion.unknownIdentityRows}), members, withdrawal: { coverage: withdrawal === null ? 'not_connected' : 'complete',
      requestCount: withdrawal?.length ?? null, plannedStatusUpdates: withdrawal?.filter(item => item.decision === 'planned_status_update').length ?? null,
      calendarPolicy: 'continue_existing_training' } };
}
