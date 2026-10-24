import { CompanyDomError } from './live-company-dom.ts';
import type { CompanyBrowserPage, CompanyDomEvidence } from './live-company-types.ts';

/** Independently verified content layout. This is not list-coverage or trainer-ownership evidence. */
export const COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE = {
  evidence: { reference: 'dedicated-worker-readonly-special-video-dom:2026-10-22', verifiedAt: '2026-10-22' } satisfies CompanyDomEvidence,
  origin: 'https://admin.biz-pt.com',
  selectedTabSelector: '[role="tab"][aria-selected="true"]',
  selectedTabText: '특별 무료 강의 답변 확인',
  activePanelSelector: '[role="tabpanel"][data-state="active"]',
  headerSelector: 'table thead th', rowSelector: 'table tbody tr', cellSelector: ':scope > td',
  answerContainerSelector: ':scope > div.flex.flex-col[class~="gap-[30px]"][class~="leading-[150%]"]',
  paragraphSelector: ':scope > p',
  headers: ['회차', '답변'], expectedRounds: 4, emptyText: '미제출',
  submittedFormat: 'numbered-question-whitespace-answer-text-nodes',
  trainerOwnershipVerified: false, memberListCoverageVerified: false,
} as const;

export interface CompanySpecialVideoContentSnapshot {
  readonly url: string;
  readonly passwordInputCount: number;
  readonly selectedTabCount: number;
  readonly selectedTabText: string | null;
  readonly activePanelCount: number;
  readonly tableCount: number;
  readonly headers: readonly string[];
  readonly rows: readonly {
    readonly cellCount: number;
    readonly roundText: string;
    readonly answerCellChildElements: number;
    readonly containerCount: number;
    readonly containerChildElements: number;
    readonly containerTextContent: string | null;
    readonly paragraphs: readonly {
      readonly childElements: number;
      readonly nodeTypes: readonly number[];
      readonly nodeTextContent: readonly string[];
      readonly textContent: string;
    }[];
  }[];
}
export interface CompanySpecialVideoContent {
  /** Ephemeral identity and original source text; never log or save this inspection result. */
  readonly companyMemberId: string;
  readonly scope: 'single-member-content-only';
  readonly trainerOwnershipVerified: false;
  readonly memberListCoverageVerified: false;
  readonly rounds: readonly {
    readonly roundText: string;
    readonly submission: 'empty' | 'submitted';
    readonly survey: readonly { readonly question: string; readonly answer: string }[];
  }[];
}
export interface CompanySpecialVideoBrowserPage extends CompanyBrowserPage {
  waitForSelector?(selector: string, options: { state: 'attached'; timeout: number }): Promise<unknown>;
}
export function companySpecialVideoUrl(companyMemberId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(companyMemberId)) throw new CompanyDomError('COMPANY_MEMBER_ID_INVALID');
  return `${COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE.origin}/manage/members/${companyMemberId}?tab=specialVideos`;
}
export function parseCompanySpecialVideoContent(companyMemberId: string, snapshot: CompanySpecialVideoContentSnapshot): CompanySpecialVideoContent {
  const profile = COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE;
  const expectedUrl = companySpecialVideoUrl(companyMemberId);
  let url: URL;
  try { url = new URL(snapshot.url); } catch { throw new CompanyDomError('COMPANY_AUTH_REQUIRED'); }
  if (snapshot.passwordInputCount !== 0 || url.origin !== profile.origin || /\/(?:login|signin|sign-in|auth)(?:\/|$)/i.test(url.pathname)) throw new CompanyDomError('COMPANY_AUTH_REQUIRED');
  if (url.href !== expectedUrl) throw new CompanyDomError('COMPANY_SURVEY_IDENTITY_MISMATCH');
  if (snapshot.selectedTabCount !== 1 || snapshot.selectedTabText !== profile.selectedTabText || snapshot.activePanelCount !== 1 || snapshot.tableCount !== 1 || JSON.stringify(snapshot.headers) !== JSON.stringify(profile.headers) || snapshot.rows.length !== profile.expectedRounds) throw new CompanyDomError('COMPANY_SURVEY_SHAPE_MISMATCH');
  const rounds = snapshot.rows.map(row => {
    if (row.cellCount !== 2 || !row.roundText.trim() || row.answerCellChildElements !== 1 || row.containerCount !== 1 || row.containerChildElements !== row.paragraphs.length || !row.paragraphs.length || row.containerTextContent !== row.paragraphs.map(paragraph => paragraph.textContent).join('')) throw new CompanyDomError('COMPANY_SURVEY_SHAPE_MISMATCH');
    if (row.containerTextContent === profile.emptyText) {
      if (row.paragraphs.length !== 1 || row.paragraphs[0]!.childElements !== 0 || row.paragraphs[0]!.textContent !== profile.emptyText) throw new CompanyDomError('COMPANY_SURVEY_SHAPE_MISMATCH');
      return { roundText: row.roundText, submission: 'empty' as const, survey: [] };
    }
    const survey = row.paragraphs.map(paragraph => {
      if (paragraph.childElements !== 0 || JSON.stringify(paragraph.nodeTypes) !== JSON.stringify([3, 3, 3]) || paragraph.nodeTextContent.length !== 3 || paragraph.nodeTextContent.join('') !== paragraph.textContent) throw new CompanyDomError('COMPANY_SURVEY_SUBMITTED_SHAPE_UNVERIFIED');
      const [question, separator, answer] = paragraph.nodeTextContent as readonly [string, string, string];
      if (!/^\s*(?:Q\.?\s*\d+|\d+[.)])/i.test(question) || !/^\s+$/.test(separator)) throw new CompanyDomError('COMPANY_SURVEY_SUBMITTED_SHAPE_UNVERIFIED');
      // Keep the exact source separator with the question, so question+answer equals textContent.
      return { question: question + separator, answer };
    });
    return { roundText: row.roundText, submission: 'submitted' as const, survey };
  });
  return { companyMemberId, scope: 'single-member-content-only', trainerOwnershipVerified: false, memberListCoverageVerified: false, rounds };
}

/** Reads one observed canonical member identity only. It cannot supply a complete company inventory. */
export async function readCompanySpecialVideoContent(page: CompanySpecialVideoBrowserPage, companyMemberId: string): Promise<CompanySpecialVideoContent> {
  const profile = COMPANY_SPECIAL_VIDEO_CONTENT_PROFILE;
  try {
  await page.goto(companySpecialVideoUrl(companyMemberId), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector?.(`${profile.activePanelSelector} table tbody tr`, { state: 'attached', timeout: 10000 });
  const snapshot = await page.evaluate(argument => {
    const tabs = document.querySelectorAll(argument.selectedTabSelector);
    const panels = document.querySelectorAll(argument.activePanelSelector);
    const panel = panels.length === 1 ? panels[0]! : null;
    return {
      url: location.href, passwordInputCount: document.querySelectorAll('input[type="password"]').length,
      selectedTabCount: tabs.length, selectedTabText: tabs.length === 1 ? tabs[0]!.textContent?.trim() ?? null : null,
      activePanelCount: panels.length, tableCount: panel?.querySelectorAll('table').length ?? 0,
      headers: panel ? Array.from(panel.querySelectorAll(argument.headerSelector), header => header.textContent?.trim() ?? '') : [],
      rows: panel ? Array.from(panel.querySelectorAll(argument.rowSelector), row => {
        const cells = row.querySelectorAll(argument.cellSelector);
        const answerCell = cells[1];
        const containers = answerCell?.querySelectorAll(argument.answerContainerSelector);
        const container = containers?.length === 1 ? containers[0]! : null;
        return {
          cellCount: cells.length, roundText: cells[0]?.textContent ?? '', answerCellChildElements: answerCell?.children.length ?? 0,
          containerCount: containers?.length ?? 0, containerChildElements: container?.children.length ?? 0,
          containerTextContent: container?.textContent ?? null,
          paragraphs: container ? Array.from(container.querySelectorAll(argument.paragraphSelector), paragraph => ({
            childElements: paragraph.children.length, nodeTypes: Array.from(paragraph.childNodes, node => node.nodeType),
            nodeTextContent: Array.from(paragraph.childNodes, node => node.textContent ?? ''), textContent: paragraph.textContent ?? '',
          })) : [],
        };
      }) : [],
    };
  }, {
    selectedTabSelector: profile.selectedTabSelector, activePanelSelector: profile.activePanelSelector,
    headerSelector: profile.headerSelector, rowSelector: profile.rowSelector, cellSelector: profile.cellSelector,
    answerContainerSelector: profile.answerContainerSelector, paragraphSelector: profile.paragraphSelector,
  });
  return parseCompanySpecialVideoContent(companyMemberId, snapshot);
  } catch (error) {
    if (error instanceof CompanyDomError) throw error;
    // Playwright transport errors may contain the member URL. Never forward those details.
    throw new CompanyDomError('COMPANY_SURVEY_READ_FAILED');
  }
}
