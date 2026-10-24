import test from 'node:test';
import assert from 'node:assert/strict';
import { observeCompanyVerificationDom, parseCompanyInventoryForReview, verifyCompanyDomReadiness } from '../src/live-company-verification.ts';
import { COMPANY_MEMBER_HEADERS } from '../src/live-company-types.ts';
import type { CompanyBrowserPage, CompanyListDomSnapshot, CompanyTrainerBinding, VerifiedDomProfile } from '../src/live-company-types.ts';

// Invented evidence and rows only. Reports must never expose these source member values.
const evidence = { reference: 'synthetic-verification-evidence', verifiedAt: '2026-10-22T00:00:00.000Z' };
const binding: CompanyTrainerBinding = { trainerId: 'trainer-synthetic-verification', accountBindingId: 'account-synthetic-verification', evidence, accountIdentity: { selector: '[data-test=account]', attribute: 'data-account-id', expectedValue: 'stable-synthetic-account' } };
const approval = { approvalId: 'synthetic-approval', trainerId: binding.trainerId, accountBindingId: binding.accountBindingId, approvedAt: '2026-10-22T00:00:00.000Z' };
function profile(): VerifiedDomProfile {
  return {
    id: 'synthetic-readiness-profile', evidence, origin: 'https://admin.biz-pt.com', listUrl: 'https://admin.biz-pt.com/manage/members', memberPathPrefix: '/manage/members/',
    list: { evidence, headerSelector: '[data-test=headers] th', bodySelector: '[data-test=rows]', rowSelector: '[data-test=rows] tr', cellSelector: 'td', uidLinkSelector: 'a[href]', headers: COMPANY_MEMBER_HEADERS },
    coverage: { evidence, activeMembership: { scope: 'active-assigned', filterKey: 'progress', activeValue: '\uc9c4\ud589' }, allFilterControlsSelector: '[data-test=filter]', filters: [
      { key: 'progress', selector: '[data-test=progress]', read: 'textContent', unrestrictedValue: 'ALL' },
      { key: 'name', selector: '[data-test=name]', read: 'value', unrestrictedValue: '' },
    ], ownership: { mode: 'stable-trainer-key', rowAttribute: 'data-trainer-key', sourceTrainerKey: 'stable-synthetic-trainer', evidence },
    pagination: { evidence, cursorSelector: '[data-test=cursor]', initialCursorValue: '1', nextSelector: '[data-test=next]', nextCursorAttribute: 'data-next', endSelector: '[data-test=end]', endValue: 'end', nextUrl: cursor => `https://admin.biz-pt.com/manage/members?page=${encodeURIComponent(cursor)}` } },
    statusMap: { '\uc9c4\ud589': '\uc878\uc5c5' }, activityMap: { '\uc9c4\ud589': 'withdrawn' },
  };
}
function row(id = 'synthetic-review-member-a', progress = '\uc9c4\ud589'): CompanyListDomSnapshot['rows'][number] {
  const values = ['1', id, 'SYNTHETIC_NAME_DO_NOT_REPORT', 'SYNTHETIC_SCHEDULE_DO_NOT_REPORT', '', 'SYNTHETIC_PHONE_DO_NOT_REPORT', '', 'SYNTHETIC_EMAIL_DO_NOT_REPORT@example.invalid', 'SYNTHETIC_TRAINER_NAME_DO_NOT_REPORT', progress, '', '', '', '', '2026-09-01'];
  return { sourceTrainerKey: 'stable-synthetic-trainer', cells: values.map((textContent, index) => ({ textContent, ...(index === 1 ? { links: [`/manage/members/${id}`] } : {}) })) };
}
function snapshot(changes: Partial<CompanyListDomSnapshot> = {}): CompanyListDomSnapshot {
  return { profileId: 'synthetic-readiness-profile', url: 'https://admin.biz-pt.com/manage/members', passwordInputCount: 0,
    accountBindingId: binding.accountBindingId, snapshotId: 'synthetic-readiness-scan', headers: COMPANY_MEMBER_HEADERS, bodyCount: 1, rows: [row()],
    filters: [{ key: 'progress', value: '\uc9c4\ud589', matchCount: 1 }, { key: 'name', value: '', matchCount: 1 }], filterControlCount: 2,
    pagination: { cursor: null, nextCursor: null, endValue: 'end', nextCount: 0, endCount: 1 }, ...changes };
}
function verify(changes: Partial<Parameters<typeof verifyCompanyDomReadiness>[0]> = {}) {
  return verifyCompanyDomReadiness({ profile: profile(), binding, listSnapshots: [snapshot()], expectedSnapshotId: 'synthetic-readiness-scan', ...changes });
}

test('complete verified scan reports readiness and redacted counts only', () => {
  const report = verify();
  assert.equal(report.status, 'ready');
  assert.equal(report.canReadInventory, true);
  assert.equal(report.canSync, true);
  assert.equal(report.sourceScope, 'active-assigned');
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.summary, { pages: 1, members: 1, reviewRequired: 0 });
  const serialized = JSON.stringify(report);
  for (const value of ['synthetic-review-member-a', 'SYNTHETIC_NAME_DO_NOT_REPORT', 'SYNTHETIC_PHONE_DO_NOT_REPORT', 'SYNTHETIC_EMAIL_DO_NOT_REPORT', 'SYNTHETIC_SCHEDULE_DO_NOT_REPORT', 'SYNTHETIC_TRAINER_NAME_DO_NOT_REPORT']) assert.equal(serialized.includes(value), false);
});

test('dedicated session approval alone cannot prove account ownership or complete list scope', () => {
  const report = verifyCompanyDomReadiness({ dedicatedSessionApproval: approval });
  assert.equal(report.status, 'needs_verification');
  assert.equal(report.canReadInventory, false);
  assert.equal(report.canSync, false);
  assert.ok(report.blockers.length > 0);
  assert.match(JSON.stringify(report.warnings), /COMPANY_APPROVAL_NOT_SCOPE_PROOF/);
  assert.deepEqual(report.summary, { pages: 0, members: 0, reviewRequired: 0 });
  const withoutCoverage = verify({ profile: { ...profile(), coverage: undefined }, dedicatedSessionApproval: approval });
  assert.equal(withoutCoverage.canReadInventory, false);
  assert.equal(withoutCoverage.canSync, false);
  assert.ok(withoutCoverage.blockers.length > 0);
});

test('missing account binding, stable identity and evidence remain verification blockers', () => {
  for (const changes of [
    { binding: undefined },
    { binding: { ...binding, accountIdentity: { ...binding.accountIdentity, expectedValue: '' } } },
    { binding: { ...binding, evidence: { ...evidence, reference: '' } } },
  ]) {
    const report = verify({ ...changes, dedicatedSessionApproval: approval });
    assert.equal(report.status, 'needs_verification');
    assert.equal(report.canReadInventory, false);
    assert.equal(report.canSync, false);
    assert.ok(report.blockers.length > 0);
  }
});

test('all-progress filter, missing controls, ownership and explicit end proof block readiness', () => {
  for (const observed of [
    snapshot({ filters: [{ key: 'progress', value: 'ALL', matchCount: 1 }, { key: 'name', value: '', matchCount: 1 }] }),
    snapshot({ filters: [{ key: 'progress', value: '\uc9c4\ud589', matchCount: 1 }, { key: 'name', value: '', matchCount: 0 }] }),
    snapshot({ rows: [{ ...row(), sourceTrainerKey: null }] }),
    snapshot({ pagination: { cursor: null, nextCursor: null, nextCount: 0, endCount: 0, endValue: null } }),
  ]) {
    const report = verify({ listSnapshots: [observed], dedicatedSessionApproval: approval });
    assert.equal(report.status, 'needs_verification');
    assert.equal(report.canReadInventory, false);
    assert.equal(report.canSync, false);
    assert.ok(report.blockers.length > 0);
  }
});

test('active inventory is syncable without mapping company progress to a workflow status', () => {
  const configured = profile();
  const observed = snapshot();
  const inventory = parseCompanyInventoryForReview(configured, binding, observed, { cursor: null, snapshotId: 'synthetic-readiness-scan' });
  assert.equal(inventory.records.length, 1);
  assert.equal(inventory.records[0]!.member.status, '\ud655\uc778\ud544\uc694');
  assert.equal(inventory.records[0]!.member.membershipActivity, 'active');
  assert.equal(inventory.records[0]!.source.progress, '\uc9c4\ud589');
  assert.deepEqual(inventory.reviews, []);
  assert.deepEqual(configured.statusMap, { '\uc9c4\ud589': '\uc878\uc5c5' });
  const report = verify({ profile: configured, listSnapshots: [observed] });
  assert.equal(report.status, 'ready');
  assert.equal(report.canReadInventory, true);
  assert.equal(report.canSync, true);
  assert.equal(JSON.stringify(report.warnings).includes('COMPANY_STATUS_REVIEW_REQUIRED'), false);
  assert.equal(report.summary.reviewRequired, 0);
  assert.equal(JSON.stringify(report).includes('synthetic-review-member-a'), false);
  assert.equal(verify({ profile: { ...configured, statusMap: {}, activityMap: undefined } }).canSync, true);
});

test('unknown and non-active source progress cannot enter the active inventory or sync', () => {
  for (const progress of ['SYNTHETIC_UNKNOWN_PROGRESS', '\uc878\uc5c5', '\ud0c8\ud1f4']) {
    const observed = snapshot({ rows: [row('synthetic-review-member-a', progress)] });
    assert.throws(() => parseCompanyInventoryForReview(profile(), binding, observed, { cursor: null, snapshotId: 'synthetic-readiness-scan' }), /COMPANY_NONACTIVE_ROW/);
    const report = verify({ listSnapshots: [observed] });
    assert.equal(report.canReadInventory, false);
    assert.equal(report.canSync, false);
    assert.ok(report.blockers.includes('COMPANY_NONACTIVE_ROW'));
  }
  const missingScope = { ...profile(), coverage: { ...profile().coverage!, activeMembership: undefined } } as unknown as VerifiedDomProfile;
  const report = verify({ profile: missingScope });
  assert.equal(report.canReadInventory, false);
  assert.equal(report.canSync, false);
  assert.ok(report.blockers.length > 0);
});

test('verification requires every page from the initial cursor through a proven terminal page', () => {
  const first = snapshot({ pagination: { cursor: null, nextCursor: '2', nextCount: 1, endCount: 0, endValue: null } });
  const second = snapshot({ rows: [row('synthetic-review-member-b')], pagination: { cursor: '2', nextCursor: null, nextCount: 0, endCount: 1, endValue: 'end' } });
  const complete = verify({ listSnapshots: [first, second] });
  assert.equal(complete.status, 'ready');
  assert.deepEqual(complete.summary, { pages: 2, members: 2, reviewRequired: 0 });
  for (const pages of [[first], [second], [first, { ...second, snapshotId: 'changed-snapshot' }]]) {
    const report = verify({ listSnapshots: pages });
    assert.equal(report.canReadInventory, false);
    assert.equal(report.canSync, false);
    assert.ok(report.blockers.length > 0);
  }
});

test('login redirects and password inputs produce needs_login without exposing DOM data', () => {
  for (const observed of [snapshot({ url: 'https://admin.biz-pt.com/login' }), snapshot({ passwordInputCount: 1 })]) {
    const report = verify({ listSnapshots: [observed] });
    assert.equal(report.status, 'needs_login');
    assert.equal(report.canReadInventory, false);
    assert.equal(report.canSync, false);
    assert.ok(report.blockers.length > 0);
    assert.equal(JSON.stringify(report).includes('SYNTHETIC_NAME_DO_NOT_REPORT'), false);
  }
});

test('malformed URL input returns a redacted blocked report instead of throwing source values', () => {
  const report = verify({ listSnapshots: [snapshot({ url: 'https://%SYNTHETIC_PRIVATE_URL_DO_NOT_REPORT' })] });
  assert.equal(report.status, 'needs_login');
  assert.equal(report.canReadInventory, false);
  assert.equal(report.canSync, false);
  assert.equal(JSON.stringify(report).includes('SYNTHETIC_PRIVATE_URL_DO_NOT_REPORT'), false);
});

test('all unrestricted UI markers and account approval cannot replace missing pagination proof', () => {
  const report = verify({ profile: { ...profile(), coverage: undefined }, listSnapshots: [], dedicatedSessionApproval: approval,
    observation: { authentication: 'observed', memberListRoute: true, tableCount: 2, headersMatch: true, rowCount: 18, malformedRowCount: 0, invalidMemberLinkCount: 0, duplicateMemberLinkCount: 0, accountIdentity: 'matched', controls: { comboboxes: 6, allMarkers: 6, activeProgressMarkers: 0, nonemptyTextInputs: 0 }, status: { active: 18, excluded: 0 } },
  });
  assert.equal(report.status, 'needs_verification');
  assert.equal(report.canReadInventory, false);
  assert.equal(report.canSync, false);
  assert.ok(report.blockers.includes('COMPANY_PAGINATION_UNVERIFIED'));
});

class ObserverElement {
  constructor(readonly textContent: string, readonly attributes: Record<string, string> = {}, readonly selectors: Record<string, ObserverElement[]> = {}) {}
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  querySelectorAll(selector: string): ObserverElement[] { return this.selectors[selector] ?? []; }
}
function observerRow(source: CompanyListDomSnapshot['rows'][number]): ObserverElement {
  return new ObserverElement('', {}, { td: source.cells.map((cell, index) => new ObserverElement(cell.textContent, {}, index === 1 ? { 'a[href]': (cell.links ?? []).map(href => new ObserverElement('', { href })) } : {})) });
}
class ObserverPage implements CompanyBrowserPage {
  constructor(readonly selectors: Record<string, ObserverElement[]>) {}
  async goto(): Promise<unknown> { throw new Error('Observer must never navigate'); }
  async evaluate<Result, Argument>(callback: (argument: Argument) => Result | Promise<Result>, argument: Argument): Promise<Result> {
    const noFunctions = (value: unknown): void => {
      assert.notEqual(typeof value, 'function');
      if (value !== null && typeof value === 'object') for (const nested of Object.values(value)) noFunctions(nested);
    };
    noFunctions(argument);
    const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const locationBefore = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: (selector: string) => this.selectors[selector] ?? [] } });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://admin.biz-pt.com', pathname: '/manage/members' } });
    try { return await callback(argument); }
    finally {
      if (documentBefore) Object.defineProperty(globalThis, 'document', documentBefore); else Reflect.deleteProperty(globalThis, 'document');
      if (locationBefore) Object.defineProperty(globalThis, 'location', locationBefore); else Reflect.deleteProperty(globalThis, 'location');
    }
  }
}

test('read-only observer exposes counts and flags without capturing private DOM values', async () => {
  const valid = row();
  const invalid = row('synthetic-review-member-b', 'SYNTHETIC_PRIVATE_PROGRESS_DO_NOT_REPORT');
  const invalidLink = { ...invalid, cells: invalid.cells.map((cell, index) => index === 1 ? { ...cell, links: ['https://other.example/manage/members/synthetic-review-member-b'] } : cell) };
  const malformed = { ...row('synthetic-review-member-c'), cells: row().cells.slice(0, 14) };
  const headerTable = new ObserverElement('', {}, { 'thead th': COMPANY_MEMBER_HEADERS.map(header => new ObserverElement(header)) });
  const bodyTable = new ObserverElement('', {}, { 'tbody tr': [observerRow(valid), observerRow(valid), observerRow(invalidLink), observerRow(malformed)] });
  const page = new ObserverPage({
    table: [headerTable, bodyTable],
    '[role="combobox"]': [new ObserverElement('\uc804\uccb4'), new ObserverElement('\uc9c4\ud589')],
    'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])': [Object.assign(new ObserverElement(''), { value: 'SYNTHETIC_PRIVATE_FILTER_DO_NOT_REPORT' })],
    '[data-test=account]': [new ObserverElement('', { 'data-account-id': 'stable-synthetic-account' })],
  });
  const observation = await observeCompanyVerificationDom(page, { profile: profile(), binding });
  assert.equal(observation.authentication, 'observed');
  assert.equal(observation.memberListRoute, true);
  assert.equal(observation.headersMatch, true);
  assert.equal(observation.tableCount, 2);
  assert.equal(observation.rowCount, 4);
  assert.equal(observation.malformedRowCount, 1);
  assert.equal(observation.invalidMemberLinkCount, 1);
  assert.equal(observation.duplicateMemberLinkCount, 1);
  assert.equal(observation.accountIdentity, 'matched');
  assert.deepEqual(observation.controls, { comboboxes: 2, allMarkers: 1, activeProgressMarkers: 1, nonemptyTextInputs: 1 });
  assert.deepEqual(observation.status, { active: 2, excluded: 1 });
  const serialized = JSON.stringify(observation);
  for (const value of ['synthetic-review-member-a', 'SYNTHETIC_NAME_DO_NOT_REPORT', 'SYNTHETIC_EMAIL_DO_NOT_REPORT', 'SYNTHETIC_PRIVATE_PROGRESS_DO_NOT_REPORT', 'SYNTHETIC_PRIVATE_FILTER_DO_NOT_REPORT', 'stable-synthetic-account']) assert.equal(serialized.includes(value), false);
});

test('observer counts only the evidence-bound active row representation', async () => {
  const configured = profile();
  const verifiedY: VerifiedDomProfile = { ...configured, coverage: { ...configured.coverage!,
    activeMembership: { ...configured.coverage!.activeMembership, rowValue: 'Y', rowValueEvidence: evidence },
  } };
  const missingEvidence: VerifiedDomProfile = { ...verifiedY, coverage: { ...verifiedY.coverage!,
    activeMembership: { ...verifiedY.coverage!.activeMembership, rowValueEvidence: undefined },
  } };
  const emptyEvidence: VerifiedDomProfile = { ...verifiedY, coverage: { ...verifiedY.coverage!,
    activeMembership: { ...verifiedY.coverage!.activeMembership, rowValueEvidence: { ...evidence, reference: '' } },
  } };
  for (const scenario of [
    { configured: undefined, expected: { active: 2, excluded: 3 } },
    { configured, expected: { active: 2, excluded: 3 } },
    { configured: verifiedY, expected: { active: 1, excluded: 4 } },
    { configured: missingEvidence, expected: { active: 2, excluded: 3 } },
    { configured: emptyEvidence, expected: { active: 2, excluded: 3 } },
  ]) {
    const values = ['\uc9c4\ud589', '\uc9c4\ud589', 'Y', 'N', 'UNKNOWN_PRIVATE_PROGRESS'];
    const headerTable = new ObserverElement('', {}, { 'thead th': COMPANY_MEMBER_HEADERS.map(header => new ObserverElement(header)) });
    const bodyTable = new ObserverElement('', {}, { 'tbody tr': values.map((value,index) => observerRow(row('synthetic-observer-'+index,value))) });
    const observation = await observeCompanyVerificationDom(new ObserverPage({table:[headerTable,bodyTable]}),{profile:scenario.configured});
    assert.deepEqual(observation.status,scenario.expected);
    assert.equal(JSON.stringify(observation).includes('UNKNOWN_PRIVATE_PROGRESS'),false);
    assert.equal(verifyCompanyDomReadiness({observation}).canReadInventory,false);
  }
  const ySnapshot=snapshot({rows:[row('synthetic-review-member-a','Y')]});
  assert.equal(parseCompanyInventoryForReview(verifiedY,binding,ySnapshot,{cursor:null,snapshotId:'synthetic-readiness-scan'}).records.length,1);
  assert.throws(()=>parseCompanyInventoryForReview(missingEvidence,binding,ySnapshot,{cursor:null,snapshotId:'synthetic-readiness-scan'}),/COMPANY_ACTIVE_SCOPE_UNVERIFIED/);
});
