import type { LegacyMemberStatus, Member, MemberStatus } from './types.js';

export const NEW_MEMBER_STATUS = '\uc2e0\uaddc' as const;
export const LEGACY_NEW_MEMBER_STATUS = '\uce74\ud1a1\uc804' as const;
/** Exact legacy alias only. Unknown and every other workflow status remain untouched. */
export function normalizeMemberStatus(status: MemberStatus | LegacyMemberStatus): MemberStatus;
export function normalizeMemberStatus(status: string): string;
export function normalizeMemberStatus(status: string): string {
  return status === LEGACY_NEW_MEMBER_STATUS ? NEW_MEMBER_STATUS : status;
}
/** Pure read normalization; never updates stored rows or external Notion options. */
export function normalizeMember(member: Member): Member {
  return { ...member, status: normalizeMemberStatus(member.status) };
}
