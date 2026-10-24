import type { Member, MemberStatus } from '@trainer/core';

/** References identify read-only verification notes; never put member values in them. */
export interface CompanyDomEvidence {
  readonly reference: string;
  readonly verifiedAt: string;
}
export const COMPANY_MEMBER_HEADERS = [
  '번호', 'UID', '이름', '고정 스케줄', '회원유형', '전화번호', '강의 수강', '이메일',
  '담당 트레이너', '진행 여부', '운영정책 동의서', '주차', '회차', '재결제일', '최초 등록 일자',
] as const;

export interface CompanyFilterBinding {
  readonly key: string;
  readonly selector: string;
  readonly read: 'value' | 'textContent';
  /** Exact observed UI values that mean unrestricted for this particular control. */
  readonly unrestrictedValue: string;
}
export interface CompanyPaginationBinding {
  readonly evidence: CompanyDomEvidence;
  /** A page cursor must be observable in the DOM, including the first page. */
  readonly cursorSelector: string;
  readonly cursorAttribute?: string;
  readonly initialCursorValue: string;
  readonly nextSelector: string;
  readonly nextCursorAttribute: string;
  /** An observed, explicit end marker is required. An absent next button is insufficient. */
  readonly endSelector: string;
  readonly endAttribute?: string;
  readonly endValue: string;
  readonly nextUrl: (cursor: string) => string;
}
export type CompanyOwnershipBinding = {
  readonly mode: 'stable-trainer-key';
  readonly rowAttribute: string;
  readonly sourceTrainerKey: string;
  readonly evidence: CompanyDomEvidence;
} | {
  readonly mode: 'account-scoped-all-assigned';
  readonly scopeSelector: string;
  readonly scopeAttribute?: string;
  readonly scopeValue: string;
  readonly evidence: CompanyDomEvidence;
};
export interface CompanyCoverageBinding {
  readonly evidence: CompanyDomEvidence;
  /** Completeness applies only to the exact company active-membership filter, never to withdrawn rows. */
  readonly activeMembership: { readonly scope: 'active-assigned'; readonly filterKey: string; readonly activeValue: '진행'; readonly rowValue?: 'Y'; readonly rowValueEvidence?: CompanyDomEvidence };
  readonly filters: readonly CompanyFilterBinding[];
  /** All matching controls must have a declared filter binding. */
  readonly allFilterControlsSelector: string;
  readonly ownership: CompanyOwnershipBinding;
  readonly pagination: CompanyPaginationBinding;
}
interface CompanySurveyIdentityBinding {
  readonly evidence: CompanyDomEvidence;
  readonly url: (companyMemberId: string) => string;
  readonly identitySelector: string;
  readonly identityAttribute?: string;
}
export type CompanySurveyBinding = CompanySurveyIdentityBinding & ({
  readonly format: 'question-answer';
  readonly pairSelector: string;
  readonly questionSelector: string;
  readonly answerSelector: string;
  /** An explicit marker distinguishes a genuinely empty survey from a bad selector. */
  readonly emptySelector?: string;
} | {
  /** Only the observed empty branch is verified; every submitted answer is held. */
  readonly format: 'empty-submission-table';
  readonly selectedTabSelector: string;
  readonly expectedTabText: '특별 무료 강의 답변 확인';
  readonly panelSelector: string;
  readonly headerSelector: string;
  readonly rowSelector: string;
  readonly cellSelector: string;
  readonly answerContainerSelector: string;
  readonly emptyParagraphSelector: string;
  readonly emptyText: '미제출';
});
export interface VerifiedDomProfile {
  readonly id: string;
  readonly evidence: CompanyDomEvidence;
  readonly origin: string;
  readonly listUrl: string;
  readonly memberPathPrefix: '/manage/members/';
  readonly list: {
    readonly evidence: CompanyDomEvidence;
    readonly headerSelector: string;
    readonly bodySelector: string;
    readonly rowSelector: string;
    readonly cellSelector: string;
    readonly uidLinkSelector: string;
    readonly headers: typeof COMPANY_MEMBER_HEADERS;
  };
  /** Omission leaves the observed list usable for inspection, but never for sync. */
  readonly coverage?: CompanyCoverageBinding;
  /** @deprecated Company progress is activity, not a Notion workflow status. Ignored by the reader. */
  readonly statusMap: Readonly<Record<string, MemberStatus>>;
  /** @deprecated Only the verified exact 진행 activity is accepted. Ignored by the reader. */
  readonly activityMap?: Readonly<Record<string, Member['membershipActivity']>>;
  readonly registrationDate?: {
    readonly evidence: CompanyDomEvidence;
    readonly format: 'YYYY-MM-DD' | 'YYYY.MM.DD';
  };
  readonly survey?: CompanySurveyBinding;
}
export interface CompanyTrainerBinding {
  readonly trainerId: string;
  /** An externally approved account binding, never a trainer display name or credential. */
  readonly accountBindingId: string;
  readonly evidence: CompanyDomEvidence;
  /** Stable DOM account identity, verified externally; display names are insufficient. */
  readonly accountIdentity: { readonly selector: string; readonly attribute?: string; readonly expectedValue: string };
}
export interface CompanyCellSnapshot {
  readonly textContent: string;
  readonly links?: readonly string[];
}
export interface CompanyListDomSnapshot {
  readonly profileId: string;
  readonly url: string;
  readonly passwordInputCount: number;
  readonly accountBindingId: string;
  readonly snapshotId: string;
  readonly headers: readonly string[];
  readonly bodyCount: number;
  readonly rows: readonly {
    readonly cells: readonly CompanyCellSnapshot[];
    readonly sourceTrainerKey?: string | null;
  }[];
  readonly filters: readonly { readonly key: string; readonly value: string; readonly matchCount: number }[];
  readonly filterControlCount: number;
  readonly accountScopeValue?: string | null;
  readonly pagination: {
    readonly cursor: string | null;
    readonly nextCursor: string | null;
    readonly endValue: string | null;
    readonly nextCount: number;
    readonly endCount: number;
  };
}
export interface CompanySurveyDomSnapshot {
  readonly profileId: string;
  readonly url: string;
  readonly passwordInputCount: number;
  readonly accountBindingId: string;
  readonly companyMemberId: string | null;
  readonly pairs: readonly { readonly question: string; readonly answer: string; readonly questionCount: number; readonly answerCount: number }[];
  readonly emptyMarkerCount: number;
  readonly submissionTable?: {
    readonly selectedTabCount: number;
    readonly selectedTabText: string | null;
    readonly panelCount: number;
    readonly headers: readonly string[];
    readonly rows: readonly { readonly cellCount: number; readonly answerContainerCount: number; readonly answerParagraphCount: number; readonly answerText: string | null; readonly answerContainerText: string | null }[];
  };
}
export interface CompanyReadRecord {
  readonly member: Member;
  /** Ephemeral values; listMembers deliberately does not project these into persisted Member. */
  readonly contact: { readonly phone: string | null; readonly email: string | null; readonly birthDate?: string | null; readonly gender?: string | null; readonly adminUrl: string };
  readonly source: { readonly progress: string; readonly trainerDisplayName: string; readonly fixedScheduleText: string; readonly registrationText: string };
}
export interface CompanyReadSession {
  readList(input: { readonly cursor: string | null; readonly snapshotId: string; readonly trainer: CompanyTrainerBinding }): Promise<CompanyListDomSnapshot>;
  readSurvey?(input: { readonly companyMemberId: string; readonly trainer: CompanyTrainerBinding }): Promise<CompanySurveyDomSnapshot>;
}
/** Structural subset of an externally supplied, already authenticated Playwright Page. */
export interface CompanyBrowserPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown>;
  evaluate<Result, Argument>(pageFunction: (argument: Argument) => Result | Promise<Result>, argument: Argument): Promise<Result>;
}
