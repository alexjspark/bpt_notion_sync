// Source-only probe for the freshly built worker. Do not run until the parent confirms build completion.
// Member identities and source content exist only in this process; output is counts/booleans/fixed codes.
import { chromium } from '@playwright/test';
import { readCompanySpecialVideoContent, COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE } from './packages/engine/src/live-company-special-videos.ts';
import { COMPANY_MEMBER_HEADERS } from './packages/engine/src/live-company-types.ts';

const origin = 'https://admin.biz-pt.com';
const membersUrl = `${origin}/manage/members`;
const maximumReads = 11;
const safeCodes = new Set(['COMPANY_AUTH_REQUIRED', 'COMPANY_MEMBER_ID_INVALID', 'COMPANY_SURVEY_IDENTITY_MISMATCH', 'COMPANY_SURVEY_SHAPE_MISMATCH', 'COMPANY_SURVEY_SUBMITTED_SHAPE_UNVERIFIED', 'COMPANY_SURVEY_READ_FAILED']);
const report = {
  phase: 'actual-company-survey-reader',
  libraryLoaded: typeof readCompanySpecialVideoContent === 'function',
  memberListSchemaVerified: false,
  activeFilterObserved: false,
  memberRowsObserved: 0,
  canonicalCandidates: 0,
  attemptedReads: 0,
  parsedReads: 0,
  rejectedReads: 0,
  rejectedCodes: {},
  submittedExample: { found: false, rounds: 0, submittedRounds: 0, pairs: 0, exactTextPreserved: false },
  emptyExample: { found: false, rounds: 0, emptyRounds: 0, pairs: 0, exactTextPreserved: false },
  singleMemberScopeOnly: true,
  ownershipClaimed: false,
  listCoverageClaimed: false,
  pageRestoredToMembers: false,
  browserLeftRunning: true,
};
let page;

function recordFailure(error) {
  const code = typeof error?.code === 'string' && safeCodes.has(error.code) ? error.code : 'COMPANY_SURVEY_READ_FAILED';
  report.rejectedReads++;
  report.rejectedCodes[code] = (report.rejectedCodes[code] ?? 0) + 1;
  return code;
}

try {
  const browser = await chromium.connectOverCDP('http://company-browser:9222');
  page = browser.contexts().flatMap(context => context.pages()).find(candidate => {
    try { return new URL(candidate.url()).origin === origin; } catch { return false; }
  });
  if (!page) throw new Error('COMPANY_PAGE_MISSING');
  await page.goto(membersUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table tbody tr', { state: 'attached', timeout: 10000 });
  const inventory = await page.evaluate(({ origin, headers }) => {
    const tables = document.querySelectorAll('table');
    const rows = tables[1] ? Array.from(tables[1].querySelectorAll('tbody tr')) : [];
    const observedHeaders = tables[0] ? Array.from(tables[0].querySelectorAll('thead th'), header => header.textContent?.trim() ?? '') : [];
    const boxes = Array.from(document.querySelectorAll('[role="combobox"]'));
    const ids = [];
    let invalidLinks = 0;
    for (const row of rows) {
      const links = row.querySelectorAll('td')[1]?.querySelectorAll('a[href]') ?? [];
      if (links.length !== 1) { invalidLinks++; continue; }
      try {
        const url = new URL(links[0].getAttribute('href'), origin);
        const id = url.pathname.slice('/manage/members/'.length);
        if (url.origin !== origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/manage/members/') || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) { invalidLinks++; continue; }
        ids.push(id);
      } catch { invalidLinks++; }
    }
    return {
      authenticatedRoute: location.origin === origin && location.pathname === '/manage/members' && document.querySelectorAll('input[type="password"]').length === 0,
      schemaVerified: tables.length === 2 && JSON.stringify(observedHeaders) === JSON.stringify(headers) && rows.every(row => row.querySelectorAll('td').length === 15),
      activeFilterObserved: boxes.length === 6 && boxes.filter(box => box.textContent?.trim() === '\uc9c4\ud589').length === 1 && boxes.filter(box => box.textContent?.trim() === '\uc804\uccb4').length === 5,
      rowCount: rows.length, invalidLinks, duplicateIds: ids.length - new Set(ids).size,
      // Private memory only. Never serialize the inventory object into output or files.
      ids,
    };
  }, { origin, headers: COMPANY_MEMBER_HEADERS });
  report.memberRowsObserved = inventory.rowCount;
  report.memberListSchemaVerified = inventory.authenticatedRoute && inventory.schemaVerified && inventory.invalidLinks === 0 && inventory.duplicateIds === 0;
  report.activeFilterObserved = inventory.activeFilterObserved;
  report.canonicalCandidates = inventory.ids.length;
  if (!report.memberListSchemaVerified || !report.activeFilterObserved) throw new Error('COMPANY_LIST_PREFLIGHT_FAILED');

  for (const companyMemberId of inventory.ids.slice(0, maximumReads)) {
    if (report.submittedExample.found && report.emptyExample.found) break;
    report.attemptedReads++;
    try {
      const content = await readCompanySpecialVideoContent(page, companyMemberId);
      report.parsedReads++;
      const originalRounds = await page.evaluate(({ panelSelector, rowSelector, containerSelector, paragraphSelector, emptyText }) => {
        const panels = document.querySelectorAll(panelSelector);
        if (panels.length !== 1) return null;
        return Array.from(panels[0].querySelectorAll(rowSelector), row => {
          const cells = row.querySelectorAll(':scope > td');
          const containers = cells[1]?.querySelectorAll(containerSelector);
          if (containers?.length !== 1) return null;
          const container = containers[0];
          return { empty: container.textContent === emptyText, paragraphs: Array.from(container.querySelectorAll(paragraphSelector), paragraph => paragraph.textContent ?? '') };
        });
      }, {
        panelSelector: COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE.activePanelSelector,
        rowSelector: COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE.rowSelector,
        containerSelector: COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE.answerContainerSelector,
        paragraphSelector: COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE.paragraphSelector,
        emptyText: COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE.emptyText,
      });
      const submittedRounds = content.rounds.filter(round => round.submission === 'submitted').length;
      const emptyRounds = content.rounds.filter(round => round.submission === 'empty').length;
      const pairs = content.rounds.reduce((count, round) => count + round.survey.length, 0);
      const sourceMatches = Array.isArray(originalRounds) && originalRounds.length === content.rounds.length && content.rounds.every((round, index) => {
        const source = originalRounds[index];
        return source !== null && (round.submission === 'empty'
          ? source.empty && round.survey.length === 0
          : !source.empty && source.paragraphs.length === round.survey.length && round.survey.every((pair, paragraph) => pair.question + pair.answer === source.paragraphs[paragraph]));
      });
      const isolatedScope = content.scope === 'single-member-content-only' && content.trainerOwnershipVerified === false && content.memberListCoverageVerified === false;
      report.singleMemberScopeOnly &&= isolatedScope;
      if (!report.submittedExample.found && submittedRounds > 0) report.submittedExample = { found: true, rounds: content.rounds.length, submittedRounds, pairs, exactTextPreserved: sourceMatches };
      if (!report.emptyExample.found && submittedRounds === 0 && emptyRounds === content.rounds.length) report.emptyExample = { found: true, rounds: content.rounds.length, emptyRounds, pairs, exactTextPreserved: sourceMatches };
    } catch (error) {
      const code = recordFailure(error);
      if (code === 'COMPANY_AUTH_REQUIRED') break;
    }
    console.log(JSON.stringify({ phase: 'actual-company-survey-reader-progress', attemptedReads: report.attemptedReads, parsedReads: report.parsedReads, rejectedReads: report.rejectedReads, submittedFound: report.submittedExample.found, emptyFound: report.emptyExample.found }));
  }
} catch {
  report.probeFailed = true;
} finally {
  if (page) {
    try {
      await page.goto(membersUrl, { waitUntil: 'domcontentloaded' });
      report.pageRestoredToMembers = await page.evaluate(origin => location.origin === origin && location.pathname === '/manage/members', origin);
    } catch { report.pageRestoredToMembers = false; }
  }
  // Exiting disconnects this client only. Never call browser.close() on the preserved browser.
  console.log(JSON.stringify(report));
  process.exit(!report.probeFailed && report.singleMemberScopeOnly && report.submittedExample.found && report.emptyExample.found && report.submittedExample.exactTextPreserved && report.emptyExample.exactTextPreserved && report.pageRestoredToMembers ? 0 : 2);
}
