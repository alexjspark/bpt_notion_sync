import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE, companySpecialVideoUrl, parseCompanySpecialVideoContent, readCompanySpecialVideoContent } from '../src/live-company-special-videos.ts';
import type { CompanySpecialVideoContentSnapshot } from '../src/live-company-special-videos.ts';
import type { CompanyBrowserPage } from '../src/live-company-types.ts';
import { CompanyDomError } from '../src/live-company-dom.ts';

// Synthetic original text only; this suite contains no actual company member answers.
const memberId = 'synthetic-special-video-member';
const emptyText = '\ubbf8\uc81c\ucd9c';
type Round = CompanySpecialVideoContentSnapshot['rows'][number];
type Paragraph = Round['paragraphs'][number];
function paragraph(question = '  1. Synthetic question? ', separator = '\n\t ', answer = '  Synthetic answer\nwith original spacing.  '): Paragraph {
  return { childElements: 0, nodeTypes: [3, 3, 3], nodeTextContent: [question, separator, answer], textContent: question + separator + answer };
}
function submittedRound(paragraphs: readonly Paragraph[] = [paragraph()], roundText = '  1\ud68c\ucc28 '): Round {
  return { cellCount: 2, roundText, answerCellChildElements: 1, containerCount: 1, containerChildElements: paragraphs.length, containerTextContent: paragraphs.map(item => item.textContent).join(''), paragraphs };
}
function emptyRound(roundText = '2\ud68c\ucc28'): Round {
  return submittedRound([{ childElements: 0, nodeTypes: [3], nodeTextContent: [emptyText], textContent: emptyText }], roundText);
}
function snapshot(changes: Partial<CompanySpecialVideoContentSnapshot> = {}): CompanySpecialVideoContentSnapshot {
  return { url: companySpecialVideoUrl(memberId), passwordInputCount: 0, selectedTabCount: 1,
    selectedTabText: '\ud2b9\ubcc4 \ubb34\ub8cc \uac15\uc758 \ub2f5\ubcc0 \ud655\uc778', activePanelCount: 1, tableCount: 1,
    headers: ['\ud68c\ucc28', '\ub2f5\ubcc0'], rows: [submittedRound(), emptyRound('2\ud68c\ucc28'), emptyRound('3\ud68c\ucc28'), emptyRound('4\ud68c\ucc28')], ...changes };
}
function withFirstRound(first: Round): CompanySpecialVideoContentSnapshot { return snapshot({ rows: [first, ...snapshot().rows.slice(1)] }); }

test('canonical special-video URL rejects invented or noncanonical member identities', () => {
  assert.equal(companySpecialVideoUrl(memberId), `https://admin.biz-pt.com/manage/members/${memberId}?tab=specialVideos`);
  for (const invalid of ['', '../member', 'member?other=1', '%61', 'a/b', 'a'.repeat(129)]) assert.throws(() => companySpecialVideoUrl(invalid), /COMPANY_MEMBER_ID_INVALID/);
  assert.throws(() => parseCompanySpecialVideoContent('different-synthetic-member', snapshot()), /COMPANY_SURVEY_IDENTITY_MISMATCH/);
});

test('submitted answers preserve all original question, separator and answer text across fifteen paragraphs', () => {
  const paragraphs = Array.from({ length: 15 }, (_, index) => paragraph(` \t${index + 1}. Synthetic question ${index + 1}? `, '\n \t\n', `\tSynthetic answer ${index + 1}\n\n  `));
  const result = parseCompanySpecialVideoContent(memberId, withFirstRound(submittedRound(paragraphs)));
  assert.equal(result.companyMemberId, memberId);
  assert.equal(result.scope, 'single-member-content-only');
  assert.equal(result.trainerOwnershipVerified, false);
  assert.equal(result.memberListCoverageVerified, false);
  assert.equal(result.rounds[0]!.roundText, '  1\ud68c\ucc28 ');
  assert.equal(result.rounds[0]!.submission, 'submitted');
  assert.equal(result.rounds[0]!.survey.length, 15);
  for (const [index, pair] of result.rounds[0]!.survey.entries()) {
    assert.equal(pair.question, paragraphs[index]!.nodeTextContent[0]! + paragraphs[index]!.nodeTextContent[1]!);
    assert.equal(pair.answer, paragraphs[index]!.nodeTextContent[2]);
    assert.equal(pair.question + pair.answer, paragraphs[index]!.textContent);
  }
});

test('verified sole-paragraph not-submitted branch produces empty content without coverage claims', () => {
  const result = parseCompanySpecialVideoContent(memberId, snapshot({ rows: [1, 2, 3, 4].map(round => emptyRound(`${round}\ud68c\ucc28`)) }));
  assert.deepEqual(result.rounds.map(round => ({ submission: round.submission, survey: round.survey })), Array.from({ length: 4 }, () => ({ submission: 'empty', survey: [] })));
  assert.equal(COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE.trainerOwnershipVerified, false);
  assert.equal(COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE.memberListCoverageVerified, false);
  assert.equal(result.scope, 'single-member-content-only');
});

test('authentication, route and member identity changes reject content before parsing', () => {
  for (const changes of [{ passwordInputCount: 1 }, { url: 'https://admin.biz-pt.com/login' }, { url: 'https://other.example/manage/members/synthetic' }, { url: 'https://%' }]) assert.throws(() => parseCompanySpecialVideoContent(memberId, snapshot(changes)), /COMPANY_AUTH_REQUIRED/);
  for (const url of [`https://admin.biz-pt.com/manage/members/${memberId}`, `${companySpecialVideoUrl(memberId)}&other=1`, `${companySpecialVideoUrl(memberId)}#other`]) assert.throws(() => parseCompanySpecialVideoContent(memberId, snapshot({ url })), /COMPANY_SURVEY_IDENTITY_MISMATCH/);
});

test('tab, active panel, table, headers and exactly four round rows must match the verified layout', () => {
  for (const changes of [
    { selectedTabCount: 0 }, { selectedTabCount: 2 }, { selectedTabText: 'Synthetic wrong tab' }, { activePanelCount: 0 },
    { activePanelCount: 2 }, { tableCount: 2 }, { headers: ['wrong', 'headers'] }, { rows: snapshot().rows.slice(0, 3) },
  ]) assert.throws(() => parseCompanySpecialVideoContent(memberId, snapshot(changes)), /COMPANY_SURVEY_SHAPE_MISMATCH/);
});

test('answer cell requires one verified container containing only its direct paragraphs', () => {
  const original = submittedRound();
  for (const first of [
    { ...original, cellCount: 3 }, { ...original, roundText: ' ' }, { ...original, answerCellChildElements: 2 },
    { ...original, containerCount: 0 }, { ...original, containerCount: 2 }, { ...original, containerChildElements: 2 },
    { ...original, containerTextContent: 'Synthetic extra source text' }, { ...original, paragraphs: [], containerChildElements: 0, containerTextContent: '' },
  ]) assert.throws(() => parseCompanySpecialVideoContent(memberId, withFirstRound(first)), /COMPANY_SURVEY_SHAPE_MISMATCH/);
  const empty = emptyRound();
  assert.throws(() => parseCompanySpecialVideoContent(memberId, withFirstRound({ ...empty, paragraphs: [{ ...empty.paragraphs[0]!, childElements: 1 }] })), /COMPANY_SURVEY_SHAPE_MISMATCH/);
});

test('submitted paragraph requires three original text nodes, a numbered question and whitespace separator', () => {
  const original = paragraph();
  for (const changed of [
    { ...original, childElements: 1 }, { ...original, nodeTypes: [3, 1, 3] },
    { ...original, nodeTextContent: original.nodeTextContent.slice(0, 2) }, { ...original, textContent: 'Synthetic inconsistent textContent' },
    paragraph('Synthetic unnumbered question'), paragraph('1. Synthetic question', ' - '), paragraph('1. Synthetic question', ''),
  ]) assert.throws(() => parseCompanySpecialVideoContent(memberId, withFirstRound(submittedRound([changed]))), /COMPANY_SURVEY_SUBMITTED_SHAPE_UNVERIFIED/);
  const blankAnswer = paragraph('Q. 2 Synthetic numbered question', ' \t\n ', '');
  assert.equal(parseCompanySpecialVideoContent(memberId, withFirstRound(submittedRound([blankAnswer]))).rounds[0]!.survey[0]!.answer, '');
});

test('read-only reader visits only the canonical member content URL and validates returned snapshot', async () => {
  const visits: string[] = [];
  let calls = 0;
  const page: CompanyBrowserPage = {
    async goto(url, options) { visits.push(url); assert.deepEqual(options, { waitUntil: 'domcontentloaded' }); },
    async evaluate<Result, Argument>(_callback: (argument: Argument) => Result | Promise<Result>, argument: Argument): Promise<Result> {
      calls++;
      assert.ok(argument !== null && typeof argument === 'object');
      assert.equal(Object.values(argument).some(value => typeof value === 'function'), false);
      assert.equal(JSON.stringify(argument).includes(memberId), false);
      return snapshot() as unknown as Result;
    },
  };
  const result = await readCompanySpecialVideoContent(page, memberId);
  assert.deepEqual(visits, [companySpecialVideoUrl(memberId)]);
  assert.equal(calls, 1);
  assert.equal(result.memberListCoverageVerified, false);
});

test('reader sanitizes transport errors without private URLs or body text in message or stack', async () => {
  const privateFailure = 'https://admin.biz-pt.com/manage/members/SYNTHETIC_PRIVATE_ID?body=SYNTHETIC_PRIVATE_BODY_AND_SECRET';
  for (const stage of ['goto', 'evaluate'] as const) {
    const page: CompanyBrowserPage = {
      async goto() { if (stage === 'goto') throw new Error(privateFailure); },
      async evaluate<Result, Argument>(_callback: (argument: Argument) => Result | Promise<Result>, _argument: Argument): Promise<Result> { throw new Error(privateFailure); },
    };
    await assert.rejects(readCompanySpecialVideoContent(page, memberId), error => {
      assert.ok(error instanceof CompanyDomError);
      assert.equal(error.code, 'COMPANY_SURVEY_READ_FAILED');
      assert.equal(error.message, 'COMPANY_SURVEY_READ_FAILED');
      for (const marker of [privateFailure, 'SYNTHETIC_PRIVATE_ID', 'SYNTHETIC_PRIVATE_BODY_AND_SECRET']) {
        assert.equal(error.message.includes(marker), false);
        assert.equal(error.stack?.includes(marker), false);
      }
      return true;
    });
  }
});
