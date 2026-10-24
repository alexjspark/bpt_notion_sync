import { parseFixedSlot, validateExplicitDate } from './parser.js';
import type { Issue, Member } from './types.js';
import { NEW_MEMBER_STATUS, normalizeMember } from './status.js';
import { withTrainingRecurrenceState } from './training-state.js';

/** Company ingestion never treats registration as assignment or replaces Notion/manual fields. */
export function prepareMember(source: Member, existing?: Member): { member: Member; issues: Issue[] } {
  source = normalizeMember(source);
  existing = existing ? normalizeMember(existing) : undefined;
  if (!source.trainerId || !source.companyMemberId) throw new Error('A trainer ID and a company member ID are required.');
  if (existing && (source.trainerId !== existing.trainerId || source.companyMemberId !== existing.companyMemberId)) {
    throw new Error('Tenant/member scope mismatch.');
  }
  const issues: Issue[] = [];
  const parsed = parseFixedSlot(source.memo);
  const explicitDate = validateExplicitDate(source.firstTrainingDate);
  issues.push(...parsed.issues, ...explicitDate.issues);
  const member: Member = {
    ...source,
    fixedSlot: source.fixedSlot ? { ...source.fixedSlot } : parsed.slot,
    firstTrainingDate: explicitDate.date,
    // Copy only the actual assignment field; never substitute registrationDate.
    assignmentDate: source.assignmentDate ?? null,
    survey: source.survey.map(({ question, answer }) => ({ question, answer })),
  };
  if (existing) {
    member.status = existing.status;
    member.notionPageId = existing.notionPageId;
    member.manualContent = existing.manualContent;
    // Null is also a deliberate saved value (for example, a date cleared in Notion).
    member.fixedSlot = existing.fixedSlot ? { ...existing.fixedSlot } : null;
    member.firstTrainingDate = existing.firstTrainingDate;
    member.callAt = existing.callAt;
    member.assignmentDate = existing.assignmentDate ?? member.assignmentDate;
    if (source.membershipActivity === 'withdrawn' && existing.status !== '\ud0c8\ud1f4') {
      issues.push({ code: 'WITHDRAWAL_REVIEW', message: 'Company withdrawal evidence differs from the saved status; confirm before changing it.' });
    }
  } else if (source.assignmentEvidence === 'new' && source.membershipActivity === 'active') {
    member.status = NEW_MEMBER_STATUS;
  } else {
    if (source.membershipActivity === 'withdrawn') member.status = '\ud0c8\ud1f4';
    else if (source.status === NEW_MEMBER_STATUS || source.assignmentEvidence === 'unknown') member.status = '\ud655\uc778\ud544\uc694';
    issues.push({ code: 'EXISTING_MEMBER_REVIEW', message: 'This omitted/existing member is not proven newly assigned. Confirm the saved status and membership activity.' });
  }
  if (source.membershipActivity === 'unknown') issues.push({ code: 'MEMBERSHIP_REVIEW', message: 'Membership activity is unknown; do not assume an active or newly assigned member.' });
  return { member: withTrainingRecurrenceState(member, existing), issues: issues.map(issue => ({ ...issue, companyMemberId: source.companyMemberId })) };
}
