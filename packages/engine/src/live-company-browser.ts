import { assertCompanyProfile, assertCompanyReadUrl, CompanyDomError, companyMemberUrl } from './live-company-dom.ts';
import type { CompanyBrowserPage, CompanyListDomSnapshot, CompanyReadSession, CompanySurveyDomSnapshot, CompanyTrainerBinding, VerifiedDomProfile } from './live-company-types.ts';

/** Only DOM reads and verified URL navigations. No login, cookies, local storage, API calls or writes. */
export class BrowserCompanyReadSession implements CompanyReadSession {
  constructor(private readonly page: CompanyBrowserPage, private readonly profile: VerifiedDomProfile) {
    assertCompanyProfile(profile, false);
  }
  async readList(input: { cursor: string | null; snapshotId: string; trainer: CompanyTrainerBinding }): Promise<CompanyListDomSnapshot> {
    const profile = this.profile;
    assertCompanyProfile(profile);
    const coverage = profile.coverage!;
    const url = input.cursor === null ? profile.listUrl : coverage.pagination.nextUrl(input.cursor);
    assertCompanyReadUrl(profile, url, new URL(profile.listUrl).pathname);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    return this.page.evaluate(argument => {
      const { list, coverage, identity } = argument;
      const read = (element: Element | null, attribute?: string): string | null => element === null ? null : attribute ? element.getAttribute(attribute) : element.textContent;
      const one = (selector: string): Element | null => {
        const elements = document.querySelectorAll(selector);
        return elements.length === 1 ? elements[0]! : null;
      };
      const accountValue = read(one(identity.selector), identity.attribute)?.trim();
      const rawCursor = read(one(coverage.pagination.cursorSelector), coverage.pagination.cursorAttribute)?.trim();
      const next = document.querySelectorAll(coverage.pagination.nextSelector);
      const end = document.querySelectorAll(coverage.pagination.endSelector);
      const ownership = coverage.ownership;
      return {
        profileId: argument.profileId,
        url: location.href,
        passwordInputCount: document.querySelectorAll('input[type="password"]').length,
        accountBindingId: accountValue === identity.expectedValue ? argument.accountBindingId : '',
        snapshotId: argument.snapshotId,
        headers: Array.from(document.querySelectorAll(list.headerSelector), element => (element.textContent ?? '').trim()),
        bodyCount: document.querySelectorAll(list.bodySelector).length,
        rows: Array.from(document.querySelectorAll(list.rowSelector), row => ({
          cells: Array.from(row.querySelectorAll(list.cellSelector), (cell, index) => ({
            textContent: cell.textContent ?? '',
            ...(index === 1 ? { links: Array.from(cell.querySelectorAll(list.uidLinkSelector), link => link.getAttribute('href') ?? '') } : {}),
          })),
          ...(ownership.mode === 'stable-trainer-key' ? { sourceTrainerKey: row.getAttribute(ownership.rowAttribute) } : {}),
        })),
        filters: coverage.filters.map(filter => {
          const element = one(filter.selector);
          const value = filter.read === 'value' && element !== null && 'value' in element ? String(element.value) : element?.textContent ?? '';
          return { key: filter.key, value: value.trim(), matchCount: document.querySelectorAll(filter.selector).length };
        }),
        filterControlCount: document.querySelectorAll(coverage.allFilterControlsSelector).length,
        ...(ownership.mode === 'account-scoped-all-assigned' ? { accountScopeValue: read(one(ownership.scopeSelector), ownership.scopeAttribute)?.trim() ?? null } : {}),
        pagination: {
          cursor: rawCursor === undefined ? '__missing_cursor__' : argument.initial && rawCursor === coverage.pagination.initialCursorValue ? null : rawCursor,
          nextCursor: next.length === 0 ? null : next.length === 1 ? next[0]!.getAttribute(coverage.pagination.nextCursorAttribute) ?? '' : '',
          endValue: end.length === 1 ? read(end[0]!, coverage.pagination.endAttribute)?.trim() ?? null : null,
          nextCount: next.length,
          endCount: end.length,
        },
      };
    }, {
      profileId: profile.id, list: profile.list,
      coverage: {
        filters: coverage.filters, allFilterControlsSelector: coverage.allFilterControlsSelector, ownership: coverage.ownership,
        pagination: {
          cursorSelector: coverage.pagination.cursorSelector, cursorAttribute: coverage.pagination.cursorAttribute,
          initialCursorValue: coverage.pagination.initialCursorValue, nextSelector: coverage.pagination.nextSelector,
          nextCursorAttribute: coverage.pagination.nextCursorAttribute, endSelector: coverage.pagination.endSelector,
          endAttribute: coverage.pagination.endAttribute,
        },
      },
      identity: input.trainer.accountIdentity, accountBindingId: input.trainer.accountBindingId,
      snapshotId: input.snapshotId, initial: input.cursor === null,
    });
  }
  async readSurvey(input: { companyMemberId: string; trainer: CompanyTrainerBinding }): Promise<CompanySurveyDomSnapshot> {
    const profile = this.profile;
    const survey = profile.survey;
    if (!survey?.evidence.reference || !Number.isFinite(Date.parse(survey.evidence.verifiedAt))) throw new CompanyDomError('COMPANY_SURVEY_UNVERIFIED');
    companyMemberUrl(profile, input.companyMemberId);
    const url = survey.url(input.companyMemberId);
    assertCompanyReadUrl(profile, url);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    const surveySelectors = survey.format === 'question-answer' ? {
      format: survey.format, identitySelector: survey.identitySelector, identityAttribute: survey.identityAttribute,
      pairSelector: survey.pairSelector, questionSelector: survey.questionSelector, answerSelector: survey.answerSelector, emptySelector: survey.emptySelector,
    } : {
      format: survey.format, identitySelector: survey.identitySelector, identityAttribute: survey.identityAttribute,
      selectedTabSelector: survey.selectedTabSelector, panelSelector: survey.panelSelector, headerSelector: survey.headerSelector,
      rowSelector: survey.rowSelector, cellSelector: survey.cellSelector, answerContainerSelector: survey.answerContainerSelector, emptyParagraphSelector: survey.emptyParagraphSelector,
    };
    return this.page.evaluate(argument => {
      const { survey, identity } = argument;
      const one = (selector: string): Element | null => {
        const elements = document.querySelectorAll(selector);
        return elements.length === 1 ? elements[0]! : null;
      };
      const read = (element: Element | null, attribute?: string): string | null => element === null ? null : attribute ? element.getAttribute(attribute) : element.textContent;
      const accountValue = read(one(identity.selector), identity.attribute)?.trim();
      if (survey.format === 'empty-submission-table') {
        const tabs = document.querySelectorAll(survey.selectedTabSelector);
        const panels = document.querySelectorAll(survey.panelSelector);
        const panel = panels.length === 1 ? panels[0]! : null;
        return {
          profileId: argument.profileId, url: location.href,
          passwordInputCount: document.querySelectorAll('input[type="password"]').length,
          accountBindingId: accountValue === identity.expectedValue ? argument.accountBindingId : '',
          companyMemberId: read(one(survey.identitySelector), survey.identityAttribute)?.trim() ?? null,
          pairs: [], emptyMarkerCount: 0,
          submissionTable: {
            selectedTabCount: tabs.length, selectedTabText: tabs.length === 1 ? tabs[0]!.textContent?.trim() ?? null : null,
            panelCount: panels.length, headers: panel ? Array.from(panel.querySelectorAll(survey.headerSelector), element => element.textContent?.trim() ?? '') : [],
            rows: panel ? Array.from(panel.querySelectorAll(survey.rowSelector), row => {
              const cells = row.querySelectorAll(survey.cellSelector);
              const containers = cells[1]?.querySelectorAll(survey.answerContainerSelector);
              const container = containers?.length === 1 ? containers[0]! : null;
              const paragraphs = container?.querySelectorAll(survey.emptyParagraphSelector);
              return { cellCount: cells.length, answerContainerCount: containers?.length ?? 0, answerParagraphCount: paragraphs?.length ?? 0, answerText: paragraphs?.length === 1 ? paragraphs[0]!.textContent : null, answerContainerText: container?.textContent ?? null };
            }) : [],
          },
        };
      }
      return {
        profileId: argument.profileId, url: location.href,
        passwordInputCount: document.querySelectorAll('input[type="password"]').length,
        accountBindingId: accountValue === identity.expectedValue ? argument.accountBindingId : '',
        companyMemberId: read(one(survey.identitySelector), survey.identityAttribute)?.trim() ?? null,
        pairs: Array.from(document.querySelectorAll(survey.pairSelector), pair => {
          const questions = pair.querySelectorAll(survey.questionSelector);
          const answers = pair.querySelectorAll(survey.answerSelector);
          return { question: questions[0]?.textContent ?? '', answer: answers[0]?.textContent ?? '', questionCount: questions.length, answerCount: answers.length };
        }),
        emptyMarkerCount: survey.emptySelector ? document.querySelectorAll(survey.emptySelector).length : 0,
      };
    }, {
      profileId: profile.id,
      survey: surveySelectors,
      identity: input.trainer.accountIdentity, accountBindingId: input.trainer.accountBindingId,
    });
  }
}
