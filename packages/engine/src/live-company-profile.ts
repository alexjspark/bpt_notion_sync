import { COMPANY_MEMBER_HEADERS } from './live-company-types.ts';

/** Read-only observations, not an operational VerifiedDomProfile or an authorization binding. */
export const COMPANY_OBSERVED_DOM = {
  evidence: { reference: 'read-only-company-dom-observations:2026-10-22', verifiedAt: '2026-10-22' },
  origin: 'https://admin.biz-pt.com',
  listUrl: 'https://admin.biz-pt.com/manage/members',
  memberPathPrefix: '/manage/members/',
  list: {
    tableCount: 2,
    headerTableIndex: 0,
    bodyTableIndex: 1,
    headers: COMPANY_MEMBER_HEADERS,
    cellCount: 15,
    columns: { uid: 1, name: 2, fixedSchedule: 3, phone: 5, email: 7, trainerDisplayName: 8, progress: 9, registrationDate: 14 },
    uidLinkSelector: 'a[href]',
    filterLabels: ['UID', '이름', '회원유형', '이메일', '휴대전화번호', '진행여부', '강의', '운영정책동의서', '콘텐츠상태', '센터'],
    observedProgressFilter: '진행',
    observedProgressFilterScope: 'active-membership',
    requestedSourceScope: 'active-assigned',
    observedActiveRowCount: 11,
    observedCountProvesCompletion: false,
    intendedProgressFilter: '진행',
    excludedProgressFilters: ['전체', '탈퇴'],
    companyProgressMeaning: 'membership-activity-only',
    observedProgressCells: 'empty-text-and-no-descendants',
  },
  specialVideos: {
    selectedTabSelector: '[role="tab"][aria-selected="true"]',
    selectedTabText: '특별 무료 강의 답변 확인',
    activePanelSelector: '[role="tabpanel"][data-state="active"]',
    tableHeaders: ['회차', '답변'],
    observedRowCount: 4,
    cellCount: 2,
    answerCellIndex: 1,
    answerContainerClasses: ['flex', 'flex-col', 'gap-[30px]', 'leading-[150%]'],
    emptyParagraphSelector: 'p',
    emptyText: '미제출',
    verifiedBranch: 'empty-and-numbered-text-node-submissions',
    observedSubmittedParagraphCount: 15,
    submittedParagraphChildNodeTypes: [3, 3, 3],
    submittedNodeMeaning: ['numbered-question', 'whitespace-separator', 'answer'],
    submittedParagraphElementChildren: 0,
  },
  readiness: {
    completeListCoverage: 'unverified', accountOwnership: 'unverified', paginationEnd: 'unverified',
    stableTrainerKey: 'unverified', assignmentDate: 'unverified', submittedQuestionAnswerContainers: 'verified-numbered-text-node-subset',
  },
} as const;

/** Observed request-list layouts only. Neither list proves assignment scope or complete pagination. */
export const COMPANY_OBSERVED_WITHDRAWAL_DOM = {
  evidence: { reference: 'read-only-company-withdrawal-dom-observations:2026-10-22', verifiedAt: '2026-10-22' },
  meaning: 'withdrawal-request-only-not-confirmed-withdrawal',
  selfWithdrawals: {
    navigationText: '회원 탈퇴 요청 리스트', path: '/manage/self-withdrawals',
    tableCount: 2, headerTableIndex: 0, bodyTableIndex: 1,
    headers: ['번호', 'UID', '이름', '상품명', '담당 트레이너', '센터', '주 차', '탈퇴 언급 날짜', '신청 구분', '요청 처리'],
    observedRowCount: 1, observedCellCount: 10,
    uidCellIndex: 1, uidLinkSelector: 'a[href]', memberPathPrefix: '/manage/members/',
    filterLabels: ['UID', '이름', '탈퇴언급날짜'], observedComboboxCount: 0,
    observedApplicationCategoryText: '환불 회원',
  },
  withdrawalRequests: {
    navigationText: '탈퇴 신청 리스트', path: '/manage/withdrawal-requests',
    headers: ['번호', 'UID', '이름', '상품명', '담당 트레이너', '센터', '주 차', '탈퇴 언급 날짜', '신청 구분', '탈퇴 구분', '신청 상태', '탈퇴 신청자', '상세 보기'],
    observedRowCount: 8,
    filterLabels: ['UID', '이름', '탈퇴언급날짜'],
    comboboxLabels: ['탈퇴구분', '탈퇴신청자', '신청상태'], observedComboboxCount: 3,
  },
  readiness: {
    adapter: 'unverified', assignmentScope: 'unverified', completeCoverage: 'unverified',
    explicitTerminalOrTotal: 'unverified', requestStatusSemantics: 'unverified',
  },
} as const;
