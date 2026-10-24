import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveCompanyAdapter } from '../src/live-company.ts';
import { BrowserCompanyReadSession } from '../src/live-company-browser.ts';
import { parseCompanyListSnapshot, parseCompanySurveySnapshot } from '../src/live-company-dom.ts';
import { COMPANY_MEMBER_HEADERS } from '../src/live-company-types.ts';
import type { CompanyBrowserPage, CompanyListDomSnapshot, CompanyReadSession, CompanySurveyDomSnapshot, CompanyTrainerBinding, VerifiedDomProfile } from '../src/live-company-types.ts';

// These fixtures describe invented DOM evidence. They contain no real account or member values.
const evidence = { reference: 'synthetic-dom-verification', verifiedAt: '2026-10-22T00:00:00.000Z' };
const binding: CompanyTrainerBinding = { trainerId: 'trainer-synthetic', accountBindingId: 'account-synthetic', evidence, accountIdentity: { selector: '[data-test=account]', attribute: 'data-account-id', expectedValue: 'stable-account-synthetic' } };
function profile(): VerifiedDomProfile {
  return {
    id: 'synthetic-company-profile', evidence, origin: 'https://admin.biz-pt.com',
    listUrl: 'https://admin.biz-pt.com/manage/members', memberPathPrefix: '/manage/members/',
    list: { evidence, headerSelector: '[data-test=headers] th', bodySelector: '[data-test=rows]', rowSelector: '[data-test=rows] tr', cellSelector: 'td', uidLinkSelector: 'a[href]', headers: COMPANY_MEMBER_HEADERS },
    coverage: {
      evidence, allFilterControlsSelector: '[data-test=filter]',
      activeMembership: { scope: 'active-assigned', filterKey: 'progress', activeValue: '\uc9c4\ud589' },
      filters: [
        { key: 'progress', selector: '[data-test=progress]', read: 'textContent', unrestrictedValue: 'ALL' },
        { key: 'name', selector: '[data-test=name]', read: 'value', unrestrictedValue: '' },
      ],
      ownership: { mode: 'stable-trainer-key', rowAttribute: 'data-test-trainer-key', sourceTrainerKey: 'trainer-source-synthetic', evidence },
      pagination: { evidence, cursorSelector: '[data-test=cursor]', initialCursorValue: '1', nextSelector: '[data-test=next]', nextCursorAttribute: 'data-next', endSelector: '[data-test=end]', endValue: 'end', nextUrl: cursor => `https://admin.biz-pt.com/manage/members?page=${encodeURIComponent(cursor)}` },
    },
    statusMap: { '\uc9c4\ud589': '\uc878\uc5c5' }, activityMap: { '\uc9c4\ud589': 'withdrawn' },
    registrationDate: { evidence, format: 'YYYY-MM-DD' },
    survey: { format: 'question-answer', evidence, url: id => `https://admin.biz-pt.com/manage/members/${id}/synthetic-survey`, identitySelector: '[data-test=member-id]', pairSelector: '[data-test=pair]', questionSelector: '[data-test=question]', answerSelector: '[data-test=answer]', emptySelector: '[data-test=empty]' },
  };
}
function row(id = 'synthetic-member-a', changes: { status?: string; trainerKey?: string | null; name?: string; href?: string; registration?: string } = {}): CompanyListDomSnapshot['rows'][number] {
  const values = ['1', id, changes.name ?? 'Synthetic Member A', 'Sunday 14:00', 'synthetic', '000-0000-0000', '', 'member@example.invalid', 'Synthetic Trainer', changes.status ?? '\uc9c4\ud589', '', '', '', '', changes.registration ?? '2026-09-01'];
  return { cells: values.map((textContent, index) => ({ textContent, ...(index === 1 ? { links: [changes.href ?? `/manage/members/${id}`] } : {}) })), sourceTrainerKey: changes.trainerKey === undefined ? 'trainer-source-synthetic' : changes.trainerKey };
}
function snapshot(changes: Partial<CompanyListDomSnapshot> = {}): CompanyListDomSnapshot {
  return {
    profileId: 'synthetic-company-profile', url: 'https://admin.biz-pt.com/manage/members', passwordInputCount: 0,
    accountBindingId: 'account-synthetic', snapshotId: 'scan-synthetic', headers: COMPANY_MEMBER_HEADERS,
    bodyCount: 1, rows: [row()], filters: [{ key: 'progress', value: '\uc9c4\ud589', matchCount: 1 }, { key: 'name', value: '', matchCount: 1 }], filterControlCount: 2,
    pagination: { cursor: null, nextCursor: null, endValue: 'end', nextCount: 0, endCount: 1 }, ...changes,
  };
}
function parse(value: CompanyListDomSnapshot = snapshot(), configured = profile()) {
  return parseCompanyListSnapshot(configured, binding, value, { cursor: null, snapshotId: 'scan-synthetic' });
}
function survey(changes: Partial<CompanySurveyDomSnapshot> = {}): CompanySurveyDomSnapshot {
  return { profileId: 'synthetic-company-profile', url: 'https://admin.biz-pt.com/manage/members/synthetic-member-a/synthetic-survey', passwordInputCount: 0, accountBindingId: 'account-synthetic', companyMemberId: 'synthetic-member-a', pairs: [{ question: '  Question\n original?  ', answer: '\tAnswer\n\n  original  ', questionCount: 1, answerCount: 1 }], emptyMarkerCount: 0, ...changes };
}
function emptySubmissionProfile(): VerifiedDomProfile {
  return { ...profile(), coverage: undefined, survey: {
    format: 'empty-submission-table', evidence,
    url: id => `https://admin.biz-pt.com/manage/members/${id}/synthetic-survey`, identitySelector: '[data-test=member-id]',
    selectedTabSelector: '[data-test=selected-tab]', expectedTabText: '\ud2b9\ubcc4 \ubb34\ub8cc \uac15\uc758 \ub2f5\ubcc0 \ud655\uc778',
    panelSelector: '[data-test=active-panel]', headerSelector: 'thead th', rowSelector: 'tbody tr', cellSelector: 'td',
    answerContainerSelector: '[data-test=answer]', emptyParagraphSelector: 'p', emptyText: '\ubbf8\uc81c\ucd9c',
  } };
}
function emptySubmissionTable(): NonNullable<CompanySurveyDomSnapshot['submissionTable']> {
  return { selectedTabCount: 1, selectedTabText: '\ud2b9\ubcc4 \ubb34\ub8cc \uac15\uc758 \ub2f5\ubcc0 \ud655\uc778', panelCount: 1,
    headers: ['\ud68c\ucc28', '\ub2f5\ubcc0'], rows: Array.from({ length: 4 }, () => ({ cellCount: 2, answerContainerCount: 1, answerParagraphCount: 1, answerText: '\ubbf8\uc81c\ucd9c', answerContainerText: '\ubbf8\uc81c\ucd9c' })) };
}
function session(pages: (input: Parameters<CompanyReadSession['readList']>[0]) => CompanyListDomSnapshot): CompanyReadSession {
  return { async readList(input) { return pages(input); }, async readSurvey(input) { return survey({ companyMemberId: input.companyMemberId, url: `https://admin.biz-pt.com/manage/members/${input.companyMemberId}/synthetic-survey` }); } };
}

test('active-only list keeps contacts ephemeral and does not map company progress into workflow status', () => {
  assert.deepEqual(COMPANY_MEMBER_HEADERS, [
    '\ubc88\ud638', 'UID', '\uc774\ub984', '\uace0\uc815 \uc2a4\ucf00\uc904', '\ud68c\uc6d0\uc720\ud615', '\uc804\ud654\ubc88\ud638', '\uac15\uc758 \uc218\uac15', '\uc774\uba54\uc77c',
    '\ub2f4\ub2f9 \ud2b8\ub808\uc774\ub108', '\uc9c4\ud589 \uc5ec\ubd80', '\uc6b4\uc601\uc815\ucc45 \ub3d9\uc758\uc11c', '\uc8fc\ucc28', '\ud68c\ucc28', '\uc7ac\uacb0\uc81c\uc77c', '\ucd5c\ucd08 \ub4f1\ub85d \uc77c\uc790',
  ]);
  const { records, nextCursor } = parse();
  assert.equal(nextCursor, null);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.member.companyMemberId, 'synthetic-member-a');
  assert.equal(records[0]!.member.status, '\ud655\uc778\ud544\uc694');
  assert.equal(records[0]!.member.membershipActivity, 'active');
  assert.equal(records[0]!.source.progress, '\uc9c4\ud589');
  assert.equal(records[0]!.member.registrationDate, '2026-09-01');
  assert.equal(records[0]!.member.assignmentDate, null);
  assert.equal(records[0]!.member.assignmentEvidence, 'unknown');
  assert.equal(records[0]!.member.fixedSlot, null);
  assert.equal(records[0]!.member.memo, '');
  assert.equal(records[0]!.source.fixedScheduleText, 'Sunday 14:00');
  assert.equal(records[0]!.contact.email, 'member@example.invalid');
  assert.equal(records[0]!.contact.phone, '000-0000-0000');
  assert.equal(Object.hasOwn(records[0]!.member, 'email'), false);
  assert.equal(Object.hasOwn(records[0]!.member, 'contact'), false);
  const noWorkflowMappings = parse(snapshot(), { ...profile(), statusMap: {}, activityMap: undefined }).records[0]!.member;
  assert.equal(noWorkflowMappings.status, '\ud655\uc778\ud544\uc694');
  assert.equal(noWorkflowMappings.membershipActivity, 'active');
  const unverifiedDate = { ...profile(), registrationDate: undefined };
  assert.equal(parse(snapshot(), unverifiedDate).records[0]!.member.registrationDate, null);
});

test('column drift and malformed body rows fail closed', () => {
  assert.throws(() => parse(snapshot({ headers: [...COMPANY_MEMBER_HEADERS].reverse() })), /COMPANY_HEADERS_MISMATCH/);
  assert.throws(() => parse(snapshot({ bodyCount: 0, rows: [] })), /COMPANY_.*(?:BODY|ROW)/);
  assert.throws(() => parse(snapshot({ rows: [{ ...row(), cells: row().cells.slice(0, 14) }] })), /COMPANY_ROW_SHAPE_MISMATCH/);
  assert.throws(() => parse(snapshot({ rows: [row('synthetic-member-a', { name: ' ' })] })), /COMPANY_MEMBER_NAME_MISSING/);
  assert.throws(() => parse(snapshot({ rows: [row('synthetic-member-a', { registration: '2026-02-30' })] })), /COMPANY_REGISTRATION_FORMAT_MISMATCH/);
});

test('member identity comes only from one canonical same-origin UID link', () => {
  for (const href of ['https://other.example/manage/members/synthetic-member-a', '/manage/members/synthetic-member-a?other=1', '/manage/members/a/b', '/manage/members/%61', '/manage/members/']) {
    assert.throws(() => parse(snapshot({ rows: [row('synthetic-member-a', { href })] })), /COMPANY_MEMBER_ID_INVALID/);
  }
  const cells = row().cells.map((cell, index) => index === 1 ? { ...cell, links: [] } : cell);
  assert.throws(() => parse(snapshot({ rows: [{ ...row(), cells }] })), /COMPANY_MEMBER_ID_INVALID/);
  assert.throws(() => parse(snapshot({ rows: [row(), row()] })), /COMPANY_DUPLICATE_MEMBER_ID/);
});

test('active progress filter, all other declared filters and explicit pagination end proof are required', () => {
  assert.throws(() => parse(snapshot(), { ...profile(), coverage: undefined }), /COMPANY_COVERAGE_UNVERIFIED/);
  assert.throws(() => parse(snapshot(), { ...profile(), coverage: { ...profile().coverage!, activeMembership: undefined } } as unknown as VerifiedDomProfile), /COMPANY_(?:ACTIVE_SCOPE|COVERAGE)_UNVERIFIED/);
  assert.throws(() => parse(snapshot({ filters: [{ key: 'progress', value: 'ALL', matchCount: 1 }, { key: 'name', value: '', matchCount: 1 }] })), /COMPANY_FILTER_SCOPE_PARTIAL/);
  assert.throws(() => parse(snapshot({ filters: [{ key: 'progress', value: '\uc804\uccb4', matchCount: 1 }, { key: 'name', value: '', matchCount: 1 }] })), /COMPANY_FILTER_SCOPE_PARTIAL/);
  assert.throws(() => parse(snapshot({ filterControlCount: 3 })), /COMPANY_FILTER_SCOPE_PARTIAL/);
  assert.throws(() => parse(snapshot({ filters: [{ key: 'progress', value: '\uc9c4\ud589', matchCount: 1 }, { key: 'progress', value: '\uc9c4\ud589', matchCount: 1 }] })), /COMPANY_FILTER_SCOPE_PARTIAL/);
  assert.throws(() => parse(snapshot({ filters: [{ key: 'progress', value: '\uc9c4\ud589', matchCount: 1 }, { key: 'name', value: '', matchCount: 0 }] })), /COMPANY_FILTER_SCOPE_PARTIAL/);
  assert.throws(() => parse(snapshot({ pagination: { cursor: null, nextCursor: null, nextCount: 0, endCount: 0, endValue: null } })), /COMPANY_PAGINATION_END_UNVERIFIED/);
  assert.throws(() => parse(snapshot({ pagination: { cursor: null, nextCursor: '2', nextCount: 1, endCount: 1, endValue: 'end' } })), /COMPANY_PAGINATION_INVALID/);
  assert.throws(() => parse(snapshot({ pagination: { cursor: '2', nextCursor: null, nextCount: 0, endCount: 1, endValue: 'end' } })), /COMPANY_CURSOR_MISMATCH/);
});

test('trainer ownership requires stable evidence and never uses the trainer display name', () => {
  assert.throws(() => parse(snapshot({ rows: [row('synthetic-member-a', { trainerKey: null })] })), /COMPANY_OWNERSHIP_UNVERIFIED/);
  assert.deepEqual(parse(snapshot({ rows: [row('synthetic-member-a', { trainerKey: 'other-stable-trainer' })] })).records, []);
  const accountProfile = profile();
  const scoped: VerifiedDomProfile = { ...accountProfile, coverage: { ...accountProfile.coverage!, ownership: { mode: 'account-scoped-all-assigned', scopeSelector: '[data-test=scope]', scopeValue: 'all-assigned', evidence } } };
  assert.throws(() => parse(snapshot({ accountScopeValue: 'current-only' }), scoped), /COMPANY_OWNERSHIP_UNVERIFIED/);
  assert.equal(parse(snapshot({ accountScopeValue: 'all-assigned' }), scoped).records.length, 1);
});

test('non-active and unknown company progress, account changes and authentication redirects fail closed', () => {
  for (const status of ['SYNTHETIC_UNKNOWN_PROGRESS', '\uc878\uc5c5', '\ud0c8\ud1f4']) assert.throws(() => parse(snapshot({ rows: [row('synthetic-member-a', { status })] })), /COMPANY_NONACTIVE_ROW/);
  assert.throws(() => parse(snapshot({ rows: [row('synthetic-other-member', { status: '\uc878\uc5c5', trainerKey: 'other-stable-trainer' })] })), /COMPANY_NONACTIVE_ROW/);
  assert.throws(() => parse(snapshot({ accountBindingId: 'other-account' })), /COMPANY_ACCOUNT_MISMATCH/);
  assert.throws(() => parse(snapshot({ profileId: 'other-profile' })), /COMPANY_PROFILE_MISMATCH/);
  assert.throws(() => parse(snapshot({ snapshotId: 'other-scan' })), /COMPANY_SNAPSHOT_CHANGED/);
  assert.throws(() => parse(snapshot({ url: 'https://admin.biz-pt.com/login' })), /COMPANY_AUTH_REQUIRED/);
  assert.throws(() => parse(snapshot({ passwordInputCount: 1 })), /COMPANY_AUTH_REQUIRED/);
});

test('survey extraction requires verified containers and preserves source text verbatim', () => {
  const result = parseCompanySurveySnapshot(profile(), binding, 'synthetic-member-a', survey());
  assert.deepEqual(result, [{ question: '  Question\n original?  ', answer: '\tAnswer\n\n  original  ' }]);
  assert.throws(() => parseCompanySurveySnapshot({ ...profile(), survey: undefined }, binding, 'synthetic-member-a', survey()), /COMPANY_SURVEY_UNVERIFIED/);
  assert.throws(() => parseCompanySurveySnapshot(profile(), binding, 'synthetic-member-a', survey({ companyMemberId: 'synthetic-member-b' })), /COMPANY_SURVEY_IDENTITY_MISMATCH/);
  assert.throws(() => parseCompanySurveySnapshot(profile(), binding, 'synthetic-member-a', survey({ pairs: [{ question: 'Question', answer: '', questionCount: 2, answerCount: 1 }] })), /COMPANY_SURVEY_SHAPE_MISMATCH/);
  assert.throws(() => parseCompanySurveySnapshot(profile(), binding, 'synthetic-member-a', survey({ pairs: [], emptyMarkerCount: 0 })), /COMPANY_SURVEY_EMPTY_UNVERIFIED/);
  assert.deepEqual(parseCompanySurveySnapshot(profile(), binding, 'synthetic-member-a', survey({ pairs: [], emptyMarkerCount: 1 })), []);
});

test('verified not-submitted survey table yields an empty survey without claiming list coverage', () => {
  const configured = emptySubmissionProfile();
  assert.equal(configured.coverage, undefined);
  assert.deepEqual(parseCompanySurveySnapshot(configured, binding, 'synthetic-member-a', survey({ pairs: [], submissionTable: emptySubmissionTable() })), []);
});

test('empty-only survey mapping holds submitted content, additional content and unverified table shape', () => {
  const configured = emptySubmissionProfile();
  const table = emptySubmissionTable();
  for (const replacement of [
    { ...table.rows[0]!, answerText: 'Synthetic submitted answer', answerContainerText: 'Synthetic submitted answer' },
    { ...table.rows[0]!, answerContainerText: '\ubbf8\uc81c\ucd9c Synthetic extra content' },
    { ...table.rows[0]!, answerParagraphCount: 2 },
  ]) {
    assert.throws(() => parseCompanySurveySnapshot(configured, binding, 'synthetic-member-a', survey({ pairs: [], submissionTable: { ...table, rows: [replacement, ...table.rows.slice(1)] } })), /COMPANY_SURVEY_NONEMPTY_UNVERIFIED/);
  }
  assert.throws(() => parseCompanySurveySnapshot(configured, binding, 'synthetic-member-a', survey({ pairs: [], submissionTable: { ...table, selectedTabCount: 0 } })), /COMPANY_SURVEY_SHAPE_MISMATCH/);
  assert.throws(() => parseCompanySurveySnapshot(configured, binding, 'synthetic-member-a', survey({ pairs: [], submissionTable: { ...table, headers: ['unknown', 'columns'] } })), /COMPANY_SURVEY_SHAPE_MISMATCH/);
});

test('adapter proves every page before returning one complete trainer-scoped result', async () => {
  const calls: Array<string | null> = [];
  const source = session(input => {
    calls.push(input.cursor);
    return snapshot({ snapshotId: input.snapshotId, rows: [row(input.cursor === null ? 'synthetic-member-a' : 'synthetic-member-b')], pagination: input.cursor === null ? { cursor: null, nextCursor: '2', nextCount: 1, endCount: 0, endValue: null } : { cursor: '2', nextCursor: null, nextCount: 0, endCount: 1, endValue: 'end' } });
  });
  const adapter = new LiveCompanyAdapter({ session: source, profile: profile(), binding });
  const result = await adapter.listMembers({ trainerId: binding.trainerId, cursor: null, scope: 'all_assigned' });
  assert.deepEqual(calls, [null, '2']);
  assert.equal(result.completeCoverage, true);
  assert.equal(result.scope, 'all_assigned');
  assert.equal(result.nextCursor, null);
  assert.equal(result.members.length, 2);
  assert.equal(Object.hasOwn(result.members[0]!, 'contact'), false);
});

test('adapter rejects conflicting duplicate members, cursor loops and unproven final pages', async () => {
  const duplicate = session(input => snapshot({ snapshotId: input.snapshotId, rows: [row('synthetic-member-a', { name: input.cursor === null ? 'Synthetic A' : 'Synthetic Changed' })], pagination: input.cursor === null ? { cursor: null, nextCursor: '2', nextCount: 1, endCount: 0, endValue: null } : { cursor: '2', nextCursor: null, nextCount: 0, endCount: 1, endValue: 'end' } }));
  await assert.rejects(new LiveCompanyAdapter({ session: duplicate, profile: profile(), binding }).readRecords(binding.trainerId), /COMPANY_.*DUPLICATE/);
  const looping = session(input => snapshot({ snapshotId: input.snapshotId, rows: [], pagination: { cursor: input.cursor, nextCursor: input.cursor === '3' ? '2' : input.cursor === '2' ? '3' : '2', nextCount: 1, endCount: 0, endValue: null } }));
  await assert.rejects(new LiveCompanyAdapter({ session: looping, profile: profile(), binding }).readRecords(binding.trainerId), /COMPANY_PAGINATION_LOOP/);
  const incomplete = session(input => snapshot({ snapshotId: input.snapshotId, pagination: { cursor: input.cursor, nextCursor: null, nextCount: 0, endCount: 0, endValue: null } }));
  await assert.rejects(new LiveCompanyAdapter({ session: incomplete, profile: profile(), binding }).readRecords(binding.trainerId), /COMPANY_PAGINATION_END_UNVERIFIED/);
});

class SyntheticElement {
  constructor(readonly textContent: string, readonly attributes: Record<string, string> = {}, readonly selectors: Record<string, SyntheticElement[]> = {}) {}
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  querySelectorAll(selector: string): SyntheticElement[] { return this.selectors[selector] ?? []; }
}
class SyntheticDomPage implements CompanyBrowserPage {
  readonly visits: string[] = [];
  readonly arguments: unknown[] = [];
  constructor(readonly selectors: Record<string, SyntheticElement[]>) {}
  async goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown> {
    assert.deepEqual(options, { waitUntil: 'domcontentloaded' });
    this.visits.push(url);
    return undefined;
  }
  async evaluate<Result, Argument>(callback: (argument: Argument) => Result | Promise<Result>, argument: Argument): Promise<Result> {
    const assertSerializable = (value: unknown): void => {
      assert.notEqual(typeof value, 'function', 'page evaluation arguments must not contain profile callback functions');
      if (value !== null && typeof value === 'object') for (const nested of Object.values(value)) assertSerializable(nested);
    };
    assertSerializable(argument);
    this.arguments.push(argument);
    const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const locationBefore = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: (selector: string) => this.selectors[selector] ?? [] } });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: this.visits.at(-1) } });
    try { return await callback(argument); }
    finally {
      if (documentBefore) Object.defineProperty(globalThis, 'document', documentBefore); else Reflect.deleteProperty(globalThis, 'document');
      if (locationBefore) Object.defineProperty(globalThis, 'location', locationBefore); else Reflect.deleteProperty(globalThis, 'location');
    }
  }
}
function syntheticDomPage(): SyntheticDomPage {
  const source = row();
  const cells = source.cells.map((cell, index) => new SyntheticElement(index === 3 ? ' \n  Fixed schedule source\t ' : cell.textContent, {}, index === 1 ? { 'a[href]': [new SyntheticElement('synthetic-member-a', { href: '/manage/members/synthetic-member-a' })] } : {}));
  const progress = new SyntheticElement(' \uc9c4\ud589 ');
  const name = Object.assign(new SyntheticElement(''), { value: '' });
  return new SyntheticDomPage({
    '[data-test=account]': [new SyntheticElement('', { 'data-account-id': 'stable-account-synthetic' })],
    '[data-test=headers] th': COMPANY_MEMBER_HEADERS.map(header => new SyntheticElement(` ${header} `)),
    '[data-test=rows]': [new SyntheticElement('')],
    '[data-test=rows] tr': [new SyntheticElement('', { 'data-test-trainer-key': 'trainer-source-synthetic' }, { td: cells })],
    '[data-test=progress]': [progress], '[data-test=name]': [name], '[data-test=filter]': [progress, name],
    '[data-test=cursor]': [new SyntheticElement('1')], '[data-test=end]': [new SyntheticElement('end')],
  });
}

test('browser port reads split header/body DOM and keeps cell text while serializing only data', async () => {
  const page = syntheticDomPage();
  const reader = new BrowserCompanyReadSession(page, profile());
  const observed = await reader.readList({ cursor: null, snapshotId: 'scan-synthetic', trainer: binding });
  assert.deepEqual(page.visits, ['https://admin.biz-pt.com/manage/members']);
  assert.equal(page.arguments.length, 1);
  assert.deepEqual(observed.headers, COMPANY_MEMBER_HEADERS);
  assert.equal(observed.bodyCount, 1);
  assert.equal(observed.rows.length, 1);
  assert.equal(observed.rows[0]!.cells[3]!.textContent, ' \n  Fixed schedule source\t ');
  assert.deepEqual(observed.filters.map(filter => filter.matchCount), [1, 1]);
  assert.equal(observed.accountBindingId, binding.accountBindingId);
  assert.equal(observed.pagination.cursor, null);
  assert.equal(parse(observed).records[0]!.source.fixedScheduleText, ' \n  Fixed schedule source\t ');
});

test('browser port invalidates a changed account and missing filter and rejects unverified navigation', async () => {
  const page = syntheticDomPage();
  page.selectors['[data-test=account]'] = [new SyntheticElement('', { 'data-account-id': 'different-stable-account' })];
  page.selectors['[data-test=name]'] = [];
  const reader = new BrowserCompanyReadSession(page, profile());
  const observed = await reader.readList({ cursor: null, snapshotId: 'scan-synthetic', trainer: binding });
  assert.equal(observed.accountBindingId, '');
  assert.equal(observed.filters.find(filter => filter.key === 'name')!.matchCount, 0);
  assert.throws(() => parse(observed), /COMPANY_ACCOUNT_MISMATCH/);
  const configured = profile();
  const unsafe: VerifiedDomProfile = { ...configured, coverage: { ...configured.coverage!, pagination: { ...configured.coverage!.pagination, nextUrl: () => 'https://other.example/manage/members' } } };
  const unsafeReader = new BrowserCompanyReadSession(page, unsafe);
  await assert.rejects(unsafeReader.readList({ cursor: '2', snapshotId: 'scan-synthetic', trainer: binding }), /COMPANY_AUTH_REQUIRED/);
  assert.deepEqual(page.visits, ['https://admin.biz-pt.com/manage/members']);
});

test('verified Y row marker maps activity only and does not alter Notion workflow status', () => {
  const configured = profile();
  (configured.coverage!.activeMembership as { rowValue?: 'Y'; rowValueEvidence?: typeof evidence }).rowValue = 'Y';
  (configured.coverage!.activeMembership as { rowValueEvidence?: typeof evidence }).rowValueEvidence = evidence;
  const result = parse(snapshot({ rows: [row('synthetic-y-member', { status: 'Y' })] }), configured);
  assert.equal(result.records[0]!.member.membershipActivity, 'active');
  assert.equal(result.records[0]!.member.status, '\ud655\uc778\ud544\uc694');
  assert.equal(result.records[0]!.source.progress, 'Y');
  assert.throws(() => parse(snapshot({ rows: [row('synthetic-n-member', { status: 'N' })] }), configured), /COMPANY_NONACTIVE_ROW/);
  assert.throws(() => parse(snapshot({ rows: [row('synthetic-empty-member', { status: '' })] }), configured), /COMPANY_NONACTIVE_ROW/);
});

test('Y row marker without independent verified evidence remains rejected', () => {
  const configured = profile();
  (configured.coverage!.activeMembership as { rowValue?: 'Y' }).rowValue = 'Y';
  assert.throws(() => parse(snapshot({ rows: [row('synthetic-y-member', { status: 'Y' })] }), configured), /COMPANY_ACTIVE_SCOPE_UNVERIFIED/);
  assert.throws(() => parse(snapshot({ rows: [row('synthetic-y-member', { status: 'Y' })] })), /COMPANY_NONACTIVE_ROW/);
});
test('visible company UID is checked independently from href and preserves leading zeroes',()=>{
 assert.equal(parse(snapshot({rows:[row('001234')]})).records[0]!.member.companyMemberId,'001234');
 assert.throws(()=>parse(snapshot({rows:[row('001234',{href:'/manage/members/1234'})]})),/COMPANY_UID_MISMATCH/);
 assert.throws(()=>parse(snapshot({rows:[row('',{href:'/manage/members/1234'})]})),/COMPANY_UID_MISMATCH/);
});
