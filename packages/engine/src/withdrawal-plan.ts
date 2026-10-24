/** Separate source lane. A request is never a confirmed withdrawal or a new-member instruction. */
export interface CompanyWithdrawalRequestInventory {
  listWithdrawalRequests(input: { trainerId: string; cursor: string | null; scope: 'withdrawal_requests' }): Promise<{
    requests: Array<{ trainerId: string; companyMemberId: string }>;
    nextCursor: string | null;
    scope: 'withdrawal_requests';
    completeCoverage: boolean;
    snapshotId: string;
  }>;
}
export type WithdrawalReadErrorCode = 'WITHDRAWAL_COVERAGE_UNVERIFIED' | 'WITHDRAWAL_SNAPSHOT_CHANGED'
  | 'WITHDRAWAL_PAGINATION_INVALID' | 'WITHDRAWAL_IDENTITY_INVALID' | 'WITHDRAWAL_STATUS_MAPPING_UNVERIFIED' | 'TENANT_MISMATCH';
export class WithdrawalReadError extends Error {
  constructor(readonly code: WithdrawalReadErrorCode, readonly retryable = false) { super(code); this.name = 'WithdrawalReadError'; }
}
export interface WithdrawalRequestSummary { memberKey: string }
export interface WithdrawalRequestPreview {
  memberKey: string;
  decision: 'planned_status_update' | 'review' | 'skip';
  reason: 'withdrawal_request_matched' | 'withdrawal_status_already_set' | 'withdrawal_member_missing' | 'duplicate_notion_identity' | 'withdrawal_status_unverified';
  targetStatus?: '탈퇴 요청';
  targetOptionName?: string;
  targetOptionId?: string;
}
export interface VerifiedWithdrawalStatusMapping {
  readonly domainStatus: '탈퇴 요청';
  readonly optionName: '탈퇴 요청' | '탈퇴요청';
  readonly optionId: string;
  readonly dataSourceId: string;
  readonly propertyId: string;
}
const verifiedMappings = new WeakSet<object>();
/** Call only with a freshly retrieved official status-property schema. No option is created. */
export function verifyWithdrawalStatusMapping(input: {
  optionName: string; dataSourceId: string; propertyId: string; actualOptions: readonly { id: string; name: string }[];
}): VerifiedWithdrawalStatusMapping {
  const matches = Array.isArray(input.actualOptions) ? input.actualOptions.filter(option => option.name === input.optionName) : [];
  if (!input.dataSourceId || !input.propertyId || !['탈퇴 요청', '탈퇴요청'].includes(input.optionName)
    || matches.length !== 1 || typeof matches[0]!.id !== 'string' || !matches[0]!.id) throw new WithdrawalReadError('WITHDRAWAL_STATUS_MAPPING_UNVERIFIED');
  const mapping: VerifiedWithdrawalStatusMapping = Object.freeze({ domainStatus: '탈퇴 요청', optionName: input.optionName as '탈퇴 요청' | '탈퇴요청',
    optionId: matches[0]!.id, dataSourceId: input.dataSourceId, propertyId: input.propertyId });
  verifiedMappings.add(mapping); return mapping;
}
export interface WithdrawalPreviewMetadata {
  coverage: 'not_connected' | 'complete';
  requestCount: number | null;
  plannedStatusUpdates: number | null;
  /** This preview produces no calendar operations; existing training follows the separate domain policy. */
  calendarPolicy: 'continue_existing_training';
}
/** Raw source identifiers are ephemeral. Checkpoints contain only caller-generated HMAC identities. */
export async function readWithdrawalRequestSummary(
  source: CompanyWithdrawalRequestInventory, trainerId: string, hashIdentity: (id: string) => string,
  guard: () => Promise<void> = async () => {},
): Promise<WithdrawalRequestSummary[]> {
  const keys = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null, snapshot: string | undefined;
  for (let index = 0; index < 1000; index++) {
    await guard();
    const page = await source.listWithdrawalRequests({ trainerId, cursor, scope: 'withdrawal_requests' });
    await guard();
    if (page.scope !== 'withdrawal_requests' || page.completeCoverage !== true || !Array.isArray(page.requests)
      || typeof page.snapshotId !== 'string' || !page.snapshotId) throw new WithdrawalReadError('WITHDRAWAL_COVERAGE_UNVERIFIED');
    if (snapshot !== undefined && snapshot !== page.snapshotId) throw new WithdrawalReadError('WITHDRAWAL_SNAPSHOT_CHANGED', true);
    snapshot = page.snapshotId;
    for (const request of page.requests) {
      if (!request || request.trainerId !== trainerId) throw new WithdrawalReadError('TENANT_MISMATCH');
      if (typeof request.companyMemberId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.companyMemberId)) throw new WithdrawalReadError('WITHDRAWAL_IDENTITY_INVALID');
      keys.add(hashIdentity(request.companyMemberId));
    }
    if (page.nextCursor === null) return [...keys].sort().map(memberKey => ({ memberKey }));
    if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) throw new WithdrawalReadError('WITHDRAWAL_PAGINATION_INVALID');
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new WithdrawalReadError('WITHDRAWAL_PAGINATION_INVALID');
}
/** Exactly one stable UID/admin-URL identity match is required. No names, fuzzy matching or writes. */
export function buildWithdrawalRequestPreview(
  requests: readonly WithdrawalRequestSummary[], notionIdentityCounts: ReadonlyMap<string, number>,
  statusMapping?: VerifiedWithdrawalStatusMapping, existingStatuses?: ReadonlyMap<string, string | null>,
): WithdrawalRequestPreview[] {
  return [...new Set(requests.map(request => request.memberKey))].sort().map(memberKey => {
    if (!/^[a-f0-9]{64}$/.test(memberKey)) throw new WithdrawalReadError('WITHDRAWAL_IDENTITY_INVALID');
    const count = notionIdentityCounts.get(memberKey) ?? 0;
    if (count > 1) return { memberKey, decision: 'review', reason: 'duplicate_notion_identity' };
    if (count !== 1) return { memberKey, decision: 'review', reason: 'withdrawal_member_missing' };
    if (!statusMapping || !verifiedMappings.has(statusMapping)) return { memberKey, decision: 'review', reason: 'withdrawal_status_unverified' };
    if (existingStatuses?.get(memberKey) === statusMapping.optionName) return { memberKey, decision: 'skip', reason: 'withdrawal_status_already_set' };
    return { memberKey, decision: 'planned_status_update', reason: 'withdrawal_request_matched', targetStatus: '탈퇴 요청', targetOptionName: statusMapping.optionName, targetOptionId: statusMapping.optionId };
  });
}
