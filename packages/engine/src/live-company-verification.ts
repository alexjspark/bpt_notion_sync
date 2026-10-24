import { assertCompanyProfile, CompanyDomError, parseCompanyListSnapshot } from './live-company-dom.ts';
import { COMPANY_MEMBER_HEADERS } from './live-company-types.ts';
import type { CompanyBrowserPage, CompanyListDomSnapshot, CompanyReadRecord, CompanyTrainerBinding, VerifiedDomProfile } from './live-company-types.ts';

export const COMPANY_VERIFICATION_CODES = [
  'COMPANY_AUTH_REQUIRED', 'COMPANY_PROFILE_UNVERIFIED', 'COMPANY_PROFILE_MISMATCH',
  'COMPANY_ACCOUNT_BINDING_UNVERIFIED', 'COMPANY_ACCOUNT_MISMATCH', 'COMPANY_TRAINER_MISMATCH',
  'COMPANY_OWNERSHIP_UNVERIFIED', 'COMPANY_COVERAGE_UNVERIFIED', 'COMPANY_FILTER_SCOPE_PARTIAL',
  'COMPANY_ACTIVE_SCOPE_UNVERIFIED', 'COMPANY_NONACTIVE_ROW',
  'COMPANY_PAGINATION_UNVERIFIED', 'COMPANY_PAGINATION_END_UNVERIFIED', 'COMPANY_PAGINATION_INVALID',
  'COMPANY_PAGINATION_LOOP', 'COMPANY_CURSOR_MISMATCH', 'COMPANY_SNAPSHOT_CHANGED',
  'COMPANY_HEADERS_MISMATCH', 'COMPANY_ROW_SHAPE_MISMATCH', 'COMPANY_MEMBER_ID_INVALID',
  'COMPANY_DUPLICATE_MEMBER_ID', 'COMPANY_CONFLICTING_DUPLICATE', 'COMPANY_MEMBER_NAME_MISSING',
  'COMPANY_REGISTRATION_FORMAT_MISMATCH', 'COMPANY_STATUS_MAPPING_INVALID', 'COMPANY_ROUTE_MISMATCH',
  'COMPANY_VERIFICATION_FAILED',
] as const;
export type CompanyVerificationCode = typeof COMPANY_VERIFICATION_CODES[number];
export type CompanyVerificationWarning = 'COMPANY_STATUS_REVIEW_REQUIRED' | 'COMPANY_ASSIGNMENT_UNKNOWN' | 'COMPANY_APPROVAL_NOT_SCOPE_PROOF';
export interface CompanyDedicatedSessionApproval {
  readonly approvalId: string;
  readonly trainerId: string;
  readonly accountBindingId: string;
  readonly approvedAt: string;
}
export interface CompanyDomVerificationReport {
  readonly sourceScope: 'active-assigned';
  readonly status: 'ready' | 'needs_login' | 'needs_verification';
  readonly canReadInventory: boolean;
  readonly canSync: boolean;
  readonly blockers: readonly CompanyVerificationCode[];
  readonly warnings: readonly CompanyVerificationWarning[];
  /** Counts only. Never include names, contacts, member IDs, URLs with IDs, or DOM text. */
  readonly summary: { readonly pages: number; readonly members: number; readonly reviewRequired: number };
}
export interface CompanyDomVerificationObservation {
  readonly authentication: 'needs_login' | 'observed';
  readonly memberListRoute: boolean;
  readonly tableCount: number;
  readonly headersMatch: boolean;
  readonly rowCount: number;
  readonly malformedRowCount: number;
  readonly invalidMemberLinkCount: number;
  readonly duplicateMemberLinkCount: number;
  readonly accountIdentity: 'unconfigured' | 'matched' | 'mismatched';
  readonly controls: { readonly comboboxes: number; readonly allMarkers: number; readonly activeProgressMarkers: number; readonly nonemptyTextInputs: number };
  readonly status: { readonly active: number; readonly excluded: number };
}

/** Approval links a dedicated lane to the intended tenant. It is never evidence of list scope. */
function approvalValid(approval: CompanyDedicatedSessionApproval | undefined): boolean {
  return Boolean(approval?.approvalId.trim() && approval.trainerId.trim() && approval.accountBindingId.trim() && Number.isFinite(Date.parse(approval.approvedAt)));
}
function evidenceValid(evidence: { readonly reference: string; readonly verifiedAt: string } | undefined): boolean {
  return Boolean(evidence?.reference.trim() && Number.isFinite(Date.parse(evidence.verifiedAt)));
}
function safeCode(error: unknown): CompanyVerificationCode {
  return error instanceof CompanyDomError && (COMPANY_VERIFICATION_CODES as readonly string[]).includes(error.code)
    ? error.code as CompanyVerificationCode : 'COMPANY_VERIFICATION_FAILED';
}
function authenticationRequired(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\/(?:login|signin|sign-in|auth)(?:\/|$)/i.test(parsed.pathname);
  } catch { return true; }
}

/** Compatibility entry point: company progress is only activity; every nonactive row is rejected. */
export function parseCompanyInventoryForReview(
  profile: VerifiedDomProfile, binding: CompanyTrainerBinding, snapshot: CompanyListDomSnapshot,
  expected: { readonly cursor: string | null; readonly snapshotId: string },
): { records: CompanyReadRecord[]; nextCursor: string | null; reviews: Array<{ companyMemberId: string; code: 'COMPANY_STATUS_REVIEW_REQUIRED' }> } {
  const parsed = parseCompanyListSnapshot(profile, binding, snapshot, expected);
  return { ...parsed, reviews: [] };
}

/** Raw snapshots are consumed only in memory; the returned report is safe to persist or show in setup UI. */
export function verifyCompanyDomReadiness(input: {
  readonly profile?: VerifiedDomProfile;
  readonly binding?: CompanyTrainerBinding;
  readonly listSnapshots?: readonly CompanyListDomSnapshot[];
  readonly expectedSnapshotId?: string;
  readonly dedicatedSessionApproval?: CompanyDedicatedSessionApproval;
  readonly observation?: CompanyDomVerificationObservation;
}): CompanyDomVerificationReport {
  const blockers = new Set<CompanyVerificationCode>();
  const warnings = new Set<CompanyVerificationWarning>();
  const { profile, binding } = input;
  const pages = input.listSnapshots ?? [];
  const records = new Map<string, CompanyReadRecord>();
  const reviewIds = new Set<string>();
  if (input.observation?.authentication === 'needs_login' || pages.some(page => page.passwordInputCount !== 0 || authenticationRequired(page.url))) blockers.add('COMPANY_AUTH_REQUIRED');
  if (!profile) blockers.add('COMPANY_PROFILE_UNVERIFIED');
  if (!binding || !binding.trainerId.trim() || !binding.accountBindingId.trim() || !evidenceValid(binding.evidence) || !binding.accountIdentity?.selector.trim() || !binding.accountIdentity.expectedValue.trim()) blockers.add('COMPANY_ACCOUNT_BINDING_UNVERIFIED');
  if (input.observation?.accountIdentity === 'mismatched') blockers.add('COMPANY_ACCOUNT_MISMATCH');
  if (!profile?.coverage || !evidenceValid(profile.coverage.evidence)) blockers.add('COMPANY_COVERAGE_UNVERIFIED');
  if (profile?.coverage?.activeMembership?.scope !== 'active-assigned' || profile.coverage.activeMembership.activeValue !== '진행') blockers.add('COMPANY_ACTIVE_SCOPE_UNVERIFIED');
  if (!profile?.coverage?.ownership || !evidenceValid(profile.coverage.ownership.evidence)) blockers.add('COMPANY_OWNERSHIP_UNVERIFIED');
  if (!profile?.coverage?.filters.length) blockers.add('COMPANY_FILTER_SCOPE_PARTIAL');
  if (!profile?.coverage?.pagination || !evidenceValid(profile.coverage.pagination.evidence)) blockers.add('COMPANY_PAGINATION_UNVERIFIED');
  if (approvalValid(input.dedicatedSessionApproval)) {
    warnings.add('COMPANY_APPROVAL_NOT_SCOPE_PROOF');
    if (binding && (binding.trainerId !== input.dedicatedSessionApproval!.trainerId || binding.accountBindingId !== input.dedicatedSessionApproval!.accountBindingId)) blockers.add('COMPANY_TRAINER_MISMATCH');
  }
  if (!pages.length) blockers.add('COMPANY_COVERAGE_UNVERIFIED');
  if (profile && binding && pages.length) {
    let cursor: string | null = null;
    const snapshotId = input.expectedSnapshotId ?? pages[0]!.snapshotId;
    const cursors = new Set<string>();
    let ended = false;
    for (const [index, page] of pages.entries()) {
      if (ended) { blockers.add('COMPANY_PAGINATION_INVALID'); break; }
      try {
        const parsed = parseCompanyInventoryForReview(profile, binding, page, { cursor, snapshotId });
        for (const record of parsed.records) {
          const previous = records.get(record.member.companyMemberId);
          if (previous && JSON.stringify(previous) !== JSON.stringify(record)) blockers.add('COMPANY_CONFLICTING_DUPLICATE');
          records.set(record.member.companyMemberId, record);
        }
        for (const review of parsed.reviews) reviewIds.add(review.companyMemberId);
        if (parsed.nextCursor === null) ended = true;
        else {
          if (cursors.has(parsed.nextCursor)) blockers.add('COMPANY_PAGINATION_LOOP');
          cursors.add(parsed.nextCursor);
          cursor = parsed.nextCursor;
        }
      } catch (error) { blockers.add(safeCode(error)); }
      if (index === pages.length - 1 && !ended) blockers.add('COMPANY_PAGINATION_END_UNVERIFIED');
    }
  }
  if (reviewIds.size) warnings.add('COMPANY_STATUS_REVIEW_REQUIRED');
  if (records.size) warnings.add('COMPANY_ASSIGNMENT_UNKNOWN');
  const canReadInventory = blockers.size === 0;
  const canSync = canReadInventory && reviewIds.size === 0;
  return {
    sourceScope: 'active-assigned',
    status: blockers.has('COMPANY_AUTH_REQUIRED') ? 'needs_login' : canSync ? 'ready' : 'needs_verification',
    canReadInventory, canSync, blockers: [...blockers], warnings: [...warnings],
    summary: { pages: pages.length, members: canReadInventory ? records.size : 0, reviewRequired: canReadInventory ? reviewIds.size : 0 },
  };
}

/** Inspect the current dedicated page without navigation or private-value capture, even before a profile is ready. */
export async function observeCompanyVerificationDom(page: CompanyBrowserPage, input: { readonly profile?: VerifiedDomProfile; readonly binding?: CompanyTrainerBinding } = {}): Promise<CompanyDomVerificationObservation> {
  // Only a validated profile may authorize the alternate Y representation.
  let activeRowValue: string = '\uC9C4\uD589';
  if (input.profile?.coverage?.activeMembership.rowValue !== undefined) {
    try { assertCompanyProfile(input.profile); activeRowValue = input.profile.coverage.activeMembership.rowValue; }
    catch { /* Unverified Y stays excluded; observation never grants readiness. */ }
  }
  return page.evaluate(argument => {
    const tables = document.querySelectorAll('table');
    const headers = tables[0] ? Array.from(tables[0].querySelectorAll('thead th'), element => element.textContent?.trim() ?? '') : [];
    const rows = tables[1] ? Array.from(tables[1].querySelectorAll('tbody tr')) : [];
    const ids = new Set<string>();
    let malformedRowCount = 0, invalidMemberLinkCount = 0, duplicateMemberLinkCount = 0, active = 0, excluded = 0;
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length !== 15) { malformedRowCount++; continue; }
      const links = cells[1]!.querySelectorAll('a[href]');
      let id: string | null = null;
      if (links.length === 1) {
        try {
          const url = new URL(links[0]!.getAttribute('href') ?? '', location.origin);
          const candidate = url.pathname.slice('/manage/members/'.length);
          if (url.origin === argument.origin && url.pathname.startsWith('/manage/members/') && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(candidate) && !url.search && !url.hash && !url.username && !url.password) id = candidate;
        } catch { /* Count only; never expose the malformed href. */ }
      }
      if (id === null) invalidMemberLinkCount++;
      else if (ids.has(id)) duplicateMemberLinkCount++;
      else ids.add(id);
      const status = cells[9]!.textContent?.trim() ?? '';
      if (status === argument.activeRowValue) active++; else excluded++;
    }
    const comboboxes = Array.from(document.querySelectorAll('[role="combobox"]'));
    const textInputs = Array.from(document.querySelectorAll('input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'));
    let accountIdentity: 'unconfigured' | 'matched' | 'mismatched' = 'unconfigured';
    if (argument.identity) {
      const matches = document.querySelectorAll(argument.identity.selector);
      const element = matches.length === 1 ? matches[0]! : null;
      const observed = element ? argument.identity.attribute ? element.getAttribute(argument.identity.attribute) : element.textContent : null;
      accountIdentity = observed?.trim() === argument.identity.expectedValue ? 'matched' : 'mismatched';
    }
    return {
      authentication: document.querySelectorAll('input[type="password"]').length > 0 || location.origin !== argument.origin || /\/(?:login|signin|sign-in|auth)(?:\/|$)/i.test(location.pathname) ? 'needs_login' : 'observed',
      memberListRoute: location.origin === argument.origin && location.pathname === '/manage/members',
      tableCount: tables.length, headersMatch: JSON.stringify(headers) === JSON.stringify(argument.headers),
      rowCount: rows.length, malformedRowCount, invalidMemberLinkCount, duplicateMemberLinkCount, accountIdentity,
      controls: { comboboxes: comboboxes.length, allMarkers: comboboxes.filter(element => element.textContent?.trim() === '전체').length, activeProgressMarkers: comboboxes.filter(element => element.textContent?.trim() === '진행').length, nonemptyTextInputs: textInputs.filter(element => 'value' in element && String(element.value).trim() !== '').length },
      status: { active, excluded },
    };
  }, { origin: input.profile?.origin ?? 'https://admin.biz-pt.com', headers: COMPANY_MEMBER_HEADERS, identity: input.binding?.accountIdentity, activeRowValue });
}
