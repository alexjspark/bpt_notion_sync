import { COMPANY_MEMBER_HEADERS } from './live-company-types.ts';
import type { CompanyDomEvidence, CompanyListDomSnapshot, CompanyReadRecord, CompanySurveyDomSnapshot, CompanyTrainerBinding, VerifiedDomProfile } from './live-company-types.ts';

export class CompanyDomError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CompanyDomError'; }
}
function fail(code: string): never { throw new CompanyDomError(code); }
const evidenceValid = (value: CompanyDomEvidence | undefined): boolean => Boolean(value?.reference.trim() && Number.isFinite(Date.parse(value.verifiedAt)));
export function assertCompanyProfile(profile: VerifiedDomProfile, requireCoverage = true): void {
  if (!profile.id.trim() || !evidenceValid(profile.evidence) || !evidenceValid(profile.list.evidence)) fail('COMPANY_PROFILE_UNVERIFIED');
  const origin = new URL(profile.origin);
  const list = new URL(profile.listUrl);
  if (origin.protocol !== 'https:' || origin.origin !== profile.origin || list.origin !== profile.origin || list.pathname !== '/manage/members' || list.search || list.hash || list.username || list.password) fail('COMPANY_PROFILE_UNVERIFIED');
  if (profile.memberPathPrefix !== '/manage/members/' || JSON.stringify(profile.list.headers) !== JSON.stringify(COMPANY_MEMBER_HEADERS)) fail('COMPANY_PROFILE_UNVERIFIED');
  if (![profile.list.headerSelector, profile.list.bodySelector, profile.list.rowSelector, profile.list.cellSelector, profile.list.uidLinkSelector].every(value => value.trim())) fail('COMPANY_PROFILE_UNVERIFIED');
  const coverage = profile.coverage;
  if (coverage?.activeMembership?.rowValue !== undefined && (coverage.activeMembership.rowValue !== 'Y' || !evidenceValid(coverage.activeMembership.rowValueEvidence))) fail('COMPANY_ACTIVE_SCOPE_UNVERIFIED');
  if (!requireCoverage && !coverage) return;
  if (!coverage || !evidenceValid(coverage.evidence) || !evidenceValid(coverage.ownership.evidence) || !evidenceValid(coverage.pagination.evidence)) fail('COMPANY_COVERAGE_UNVERIFIED');
  if (coverage.activeMembership?.scope !== 'active-assigned' || coverage.activeMembership.activeValue !== '진행' || !coverage.activeMembership.filterKey.trim() || coverage.filters.filter(filter => filter.key === coverage.activeMembership.filterKey).length !== 1) fail('COMPANY_ACTIVE_SCOPE_UNVERIFIED');
  if (!coverage.filters.length || !coverage.allFilterControlsSelector.trim() || new Set(coverage.filters.map(item => item.key)).size !== coverage.filters.length || new Set(coverage.filters.map(item => item.selector)).size !== coverage.filters.length || coverage.filters.some(item => !item.key.trim() || !item.selector.trim())) fail('COMPANY_COVERAGE_UNVERIFIED');
  const pagination = coverage.pagination;
  if (![pagination.cursorSelector, pagination.initialCursorValue, pagination.nextSelector, pagination.nextCursorAttribute, pagination.endSelector, pagination.endValue].every(value => value.trim()) || typeof pagination.nextUrl !== 'function') fail('COMPANY_PAGINATION_UNVERIFIED');
  const ownership = coverage.ownership;
  if (ownership.mode === 'stable-trainer-key' ? !ownership.rowAttribute.trim() || !ownership.sourceTrainerKey.trim() : !ownership.scopeSelector.trim() || !ownership.scopeValue.trim()) fail('COMPANY_OWNERSHIP_UNVERIFIED');
  if (profile.registrationDate && !evidenceValid(profile.registrationDate.evidence)) fail('COMPANY_PROFILE_UNVERIFIED');
}
function assertTrainer(binding: CompanyTrainerBinding): void {
  if (!binding.trainerId.trim() || !binding.accountBindingId.trim() || !evidenceValid(binding.evidence) || !binding.accountIdentity?.selector.trim() || !binding.accountIdentity.expectedValue.trim()) fail('COMPANY_OWNERSHIP_UNVERIFIED');
}
export function assertCompanyReadUrl(profile: VerifiedDomProfile, url: string, expectedPath?: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return fail('COMPANY_AUTH_REQUIRED'); }
  if (parsed.origin !== profile.origin || parsed.username || parsed.password || /\/(?:login|signin|sign-in|auth)(?:\/|$)/i.test(parsed.pathname)) fail('COMPANY_AUTH_REQUIRED');
  if (expectedPath !== undefined && parsed.pathname !== expectedPath) fail('COMPANY_ROUTE_MISMATCH');
  return parsed;
}
export function companyMemberUrl(profile: VerifiedDomProfile, companyMemberId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(companyMemberId)) fail('COMPANY_MEMBER_ID_INVALID');
  return new URL(`${profile.memberPathPrefix}${companyMemberId}`, profile.origin).href;
}
function memberIdFromHref(profile: VerifiedDomProfile, href: string): string {
  let url: URL;
  try { url = new URL(href, profile.origin); } catch { return fail('COMPANY_MEMBER_ID_INVALID'); }
  if (url.origin !== profile.origin || url.search || url.hash || url.username || url.password || !url.pathname.startsWith(profile.memberPathPrefix)) fail('COMPANY_MEMBER_ID_INVALID');
  const id = url.pathname.slice(profile.memberPathPrefix.length);
  if (companyMemberUrl(profile, id) !== url.href) fail('COMPANY_MEMBER_ID_INVALID');
  return id;
}
function registrationDate(profile: VerifiedDomProfile, raw: string): string | null {
  if (!profile.registrationDate || !raw.trim()) return null;
  const pattern = profile.registrationDate.format === 'YYYY-MM-DD' ? /^(\d{4})-(\d{2})-(\d{2})$/ : /^(\d{4})\.(\d{2})\.(\d{2})$/;
  const match = pattern.exec(raw.trim());
  if (!match) return fail('COMPANY_REGISTRATION_FORMAT_MISMATCH');
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) fail('COMPANY_REGISTRATION_FORMAT_MISMATCH');
  return iso;
}
export function parseCompanyListSnapshot(
  profile: VerifiedDomProfile, binding: CompanyTrainerBinding, snapshot: CompanyListDomSnapshot,
  expected: { readonly cursor: string | null; readonly snapshotId: string },
): { records: CompanyReadRecord[]; nextCursor: string | null } {
  assertCompanyProfile(profile);
  assertTrainer(binding);
  assertCompanyReadUrl(profile, snapshot.url, new URL(profile.listUrl).pathname);
  if (snapshot.passwordInputCount !== 0) fail('COMPANY_AUTH_REQUIRED');
  if (snapshot.profileId !== profile.id) fail('COMPANY_PROFILE_MISMATCH');
  if (snapshot.accountBindingId !== binding.accountBindingId) fail('COMPANY_ACCOUNT_MISMATCH');
  if (!expected.snapshotId.trim() || snapshot.snapshotId !== expected.snapshotId) fail('COMPANY_SNAPSHOT_CHANGED');
  if (JSON.stringify(snapshot.headers) !== JSON.stringify(profile.list.headers)) fail('COMPANY_HEADERS_MISMATCH');
  if (snapshot.bodyCount !== 1) fail('COMPANY_ROW_SHAPE_MISMATCH');
  const coverage = profile.coverage!;
  if (snapshot.filterControlCount !== coverage.filters.length || snapshot.filters.length !== coverage.filters.length || new Set(snapshot.filters.map(filter => filter.key)).size !== coverage.filters.length) fail('COMPANY_FILTER_SCOPE_PARTIAL');
  for (const filter of coverage.filters) {
    const observed = snapshot.filters.find(item => item.key === filter.key);
    const requiredValue = filter.key === coverage.activeMembership.filterKey ? coverage.activeMembership.activeValue : filter.unrestrictedValue;
    if (observed?.matchCount !== 1 || observed.value !== requiredValue) fail('COMPANY_FILTER_SCOPE_PARTIAL');
  }
  if (coverage.ownership.mode === 'account-scoped-all-assigned' && snapshot.accountScopeValue !== coverage.ownership.scopeValue) fail('COMPANY_OWNERSHIP_UNVERIFIED');
  const page = snapshot.pagination;
  if (page.cursor !== expected.cursor || page.cursor !== null && !page.cursor.trim()) fail('COMPANY_CURSOR_MISMATCH');
  if (page.nextCursor === null) {
    if (page.endCount !== 1 || page.endValue !== coverage.pagination.endValue || page.nextCount !== 0) fail('COMPANY_PAGINATION_END_UNVERIFIED');
  } else if (!page.nextCursor.trim() || page.nextCursor === page.cursor || page.nextCount !== 1 || page.endCount !== 0 || page.endValue !== null) fail('COMPANY_PAGINATION_INVALID');
  const records: CompanyReadRecord[] = [];
  const seen = new Set<string>();
  for (const row of snapshot.rows) {
    if (row.cells.length !== COMPANY_MEMBER_HEADERS.length) fail('COMPANY_ROW_SHAPE_MISMATCH');
    const links = row.cells[1]!.links ?? [];
    if (links.length !== 1) fail('COMPANY_MEMBER_ID_INVALID');
    const id = memberIdFromHref(profile, links[0]!);
    if(row.cells[1]!.textContent.trim()!==id)fail('COMPANY_UID_MISMATCH');
    if (seen.has(id)) fail('COMPANY_DUPLICATE_MEMBER_ID');
    seen.add(id);
    const text = (index: number): string => row.cells[index]!.textContent;
    const progress = text(9).trim();
    // Any nonactive row contradicts the claimed active UI filter, even when owned by another trainer.
    if (progress !== (coverage.activeMembership.rowValue ?? coverage.activeMembership.activeValue)) fail('COMPANY_NONACTIVE_ROW');
    if (coverage.ownership.mode === 'stable-trainer-key') {
      if (!row.sourceTrainerKey?.trim()) fail('COMPANY_OWNERSHIP_UNVERIFIED');
      if (row.sourceTrainerKey !== coverage.ownership.sourceTrainerKey) continue;
    }
    const name = text(2).trim();
    if (!name) fail('COMPANY_MEMBER_NAME_MISSING');
    records.push({
      member: {
        // This sentinel carries no company-to-Notion workflow inference. The inventory planner
        // preserves existing Notion workflow; it assigns 신규 only to a proven missing active member.
        trainerId: binding.trainerId, companyMemberId: id, name, status: '확인필요', notionPageId: null,
        registrationDate: registrationDate(profile, text(14)), assignmentDate: null, assignmentEvidence: 'unknown',
        membershipActivity: 'active', memo: '', fixedSlot: null,
        firstTrainingDate: null, callAt: null, survey: [], manualContent: '',
      },
      contact: { phone: text(5).trim() || null, email: text(7).trim() || null, adminUrl: companyMemberUrl(profile, id) },
      source: { progress, trainerDisplayName: text(8), fixedScheduleText: text(3), registrationText: text(14) },
    });
  }
  return { records, nextCursor: page.nextCursor };
}
export function parseCompanySurveySnapshot(profile: VerifiedDomProfile, binding: CompanyTrainerBinding, companyMemberId: string, snapshot: CompanySurveyDomSnapshot): Array<{ question: string; answer: string }> {
  assertCompanyProfile(profile, false);
  assertTrainer(binding);
  const survey = profile.survey;
  if (!survey || !evidenceValid(survey.evidence) || !survey.identitySelector.trim()) fail('COMPANY_SURVEY_UNVERIFIED');
  const expectedUrl = assertCompanyReadUrl(profile, survey.url(companyMemberId));
  const url = assertCompanyReadUrl(profile, snapshot.url);
  if (snapshot.passwordInputCount !== 0) fail('COMPANY_AUTH_REQUIRED');
  if (snapshot.profileId !== profile.id) fail('COMPANY_PROFILE_MISMATCH');
  if (snapshot.accountBindingId !== binding.accountBindingId) fail('COMPANY_ACCOUNT_MISMATCH');
  if (snapshot.companyMemberId !== companyMemberId || url.href !== expectedUrl.href) fail('COMPANY_SURVEY_IDENTITY_MISMATCH');
  if (survey.format === 'empty-submission-table') {
    if (![survey.selectedTabSelector, survey.panelSelector, survey.headerSelector, survey.rowSelector, survey.cellSelector, survey.answerContainerSelector, survey.emptyParagraphSelector].every(value => value.trim()) || survey.expectedTabText !== '특별 무료 강의 답변 확인' || survey.emptyText !== '미제출') fail('COMPANY_SURVEY_UNVERIFIED');
    const table = snapshot.submissionTable;
    if (!table || table.selectedTabCount !== 1 || table.selectedTabText !== survey.expectedTabText || table.panelCount !== 1 || JSON.stringify(table.headers) !== JSON.stringify(['회차', '답변']) || !table.rows.length || snapshot.pairs.length) fail('COMPANY_SURVEY_SHAPE_MISMATCH');
    for (const row of table.rows) {
      if (row.cellCount !== 2 || row.answerContainerCount !== 1 || row.answerParagraphCount !== 1) fail('COMPANY_SURVEY_NONEMPTY_UNVERIFIED');
      if (row.answerText !== survey.emptyText || row.answerContainerText !== survey.emptyText) fail('COMPANY_SURVEY_NONEMPTY_UNVERIFIED');
    }
    return [];
  }
  if (survey.format !== 'question-answer' || ![survey.pairSelector, survey.questionSelector, survey.answerSelector].every(value => value.trim())) fail('COMPANY_SURVEY_UNVERIFIED');
  if (!snapshot.pairs.length && (!survey.emptySelector || snapshot.emptyMarkerCount !== 1)) fail('COMPANY_SURVEY_EMPTY_UNVERIFIED');
  if (snapshot.pairs.length && snapshot.emptyMarkerCount !== 0) fail('COMPANY_SURVEY_SHAPE_MISMATCH');
  return snapshot.pairs.map(pair => {
    if (pair.questionCount !== 1 || pair.answerCount !== 1 || !pair.question.trim()) fail('COMPANY_SURVEY_SHAPE_MISMATCH');
    // textContent is intentionally returned byte-for-byte: no trimming, inference or AI.
    return { question: pair.question, answer: pair.answer };
  });
}
