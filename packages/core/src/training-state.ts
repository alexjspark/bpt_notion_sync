import type { Member } from './types.js';

const trainingStatus = '\uc9c4\ud589';
const withdrawalRequestStatus = '\ud0c8\ud1f4 \uc694\uccad';

/**
 * Training activation is local scheduling state, not a company membership flag.
 * A request keeps the previously authorized series; it never starts one.
 */
export function withTrainingRecurrenceState(next: Member, previous?: Member): Member {
  if (previous && (next.trainerId !== previous.trainerId || next.companyMemberId !== previous.companyMemberId)) {
    throw new Error('Tenant/member scope mismatch.');
  }
  let active: boolean | undefined;
  if (next.status === trainingStatus) active = true;
  else if (next.status !== withdrawalRequestStatus) active = false;
  else if (previous) {
    active = previous.status === trainingStatus
      ? true
      : previous.status === withdrawalRequestStatus ? previous.trainingRecurrenceActive : false;
  } else active = next.trainingRecurrenceActive;
  const member = { ...next };
  if (typeof active === 'boolean') member.trainingRecurrenceActive = active;
  else delete member.trainingRecurrenceActive;
  return member;
}

/** undefined means there is no proof of the pre-request activation state. */
export function trainingRecurrenceState(member: Member): boolean | undefined {
  if (member.status === trainingStatus) return true;
  if (member.status === withdrawalRequestStatus) return typeof member.trainingRecurrenceActive === 'boolean' ? member.trainingRecurrenceActive : undefined;
  return false;
}
