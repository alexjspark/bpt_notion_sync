import { DateTime } from 'luxon';
import type { Member } from '@trainer/core';

/** Generated synthetic fixtures only. No company or Notion customer data. */
export function syntheticMembers(trainerId: string, now = new Date().toISOString()): Member[] {
  const today = DateTime.fromISO(now, { zone: 'Asia/Seoul' });
  const sunday = today.plus({ days: (7 - today.weekday + 7) % 7 || 7 }).toISODate()!;
  const base = {
    trainerId,
    notionPageId: null,
    registrationDate: '2025-01-15',
    assignmentDate: null,
    assignmentEvidence: 'existing' as const,
    membershipActivity: 'active' as const,
    memo: '일요일 14',
    fixedSlot: { weekday: 7, hour: 14, minute: 0, durationMinutes: 60 as const },
    firstTrainingDate: null,
    callAt: null,
    survey: [{ question: '운동 목표는?', answer: '합성 응답: 체력을 기르고 싶습니다.\n원문 줄바꿈과 $$$, @@를 보존합니다.' }],
    manualContent: '',
  };
  return [
    { ...base, companyMemberId: 'demo-001', name: '합성 신규회원', status: '신규', assignmentDate: today.toISODate(), assignmentEvidence: 'new' },
    { ...base, companyMemberId: 'demo-002', name: '합성 진행회원', status: '진행', firstTrainingDate: sunday, manualContent: '사용자가 직접 작성한 메모입니다.' },
    { ...base, companyMemberId: 'demo-003', name: '합성 확인회원', status: '확인필요', membershipActivity: 'unknown', memo: '일요일 오후쯤 / 첫 수업 11월 초', fixedSlot: null },
    { ...base, companyMemberId: 'demo-004', name: '합성 통화회원', status: '통화', memo: '', fixedSlot: null, callAt: today.plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toISO() },
  ];
}
