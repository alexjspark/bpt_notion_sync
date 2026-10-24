import { DateTime } from 'luxon';
import { validFixedSlot, validateExplicitDate } from './parser.js';
import type { Issue, Member, ScheduleEvent, ScheduleOptions } from './types.js';
import { trainingRecurrenceState } from './training-state.js';

const terminalStatuses = new Set(['\uc878\uc5c5', '\ud0c8\ud1f4', '\uc720\uc608']);
const offsetPattern = /(?:Z|[+-]\d{2}:\d{2})$/i;
const scopeKey = (member: Pick<Member, 'trainerId' | 'companyMemberId'>): string => `${encodeURIComponent(member.trainerId)}:${encodeURIComponent(member.companyMemberId)}`;
const timestamp = (value: string): number => DateTime.fromISO(value, { setZone: true }).toMillis();
const asIso = (date: DateTime): string => date.toISO({ suppressMilliseconds: true })!;
const isFuture = (event: ScheduleEvent, now: DateTime): boolean => timestamp(event.start) >= now.toMillis();

function eventFor(member: Member, key: string, kind: ScheduleEvent['kind'], start: DateTime): ScheduleEvent {
  const startIso = asIso(start);
  const endIso = asIso(start.plus({ hours: 1 }));
  return { key, trainerId: member.trainerId, companyMemberId: member.companyMemberId, kind, start: startIso, end: endIso, status: 'active', manualOverride: false, sourceStart: startIso, sourceEnd: endIso, sourceStatus: 'active' };
}

function sortEvents(events: ScheduleEvent[]): ScheduleEvent[] {
  return events.sort((a, b) => timestamp(a.start) - timestamp(b.start) || a.key.localeCompare(b.key));
}

/** Compare actual instants, not string offsets. Exact adjacency is not an overlap. */
export function detectScheduleConflicts(events: ScheduleEvent[]): Issue[] {
  const active = events.filter(event => event.status === 'active' && Number.isFinite(timestamp(event.start)) && Number.isFinite(timestamp(event.end)));
  const issues: Issue[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      if (a.trainerId !== b.trainerId || a.key === b.key) continue;
      if (timestamp(a.start) < timestamp(b.end) && timestamp(b.start) < timestamp(a.end)) {
        issues.push({ code: 'SCHEDULE_CONFLICT', message: `Confirm overlapping schedule entries ${a.key} and ${b.key}.`, companyMemberId: b.companyMemberId });
      }
    }
  }
  return issues;
}

function overlaps(a: ScheduleEvent, b: ScheduleEvent): boolean {
  return a.status === 'active' && b.status === 'active' && a.key !== b.key && timestamp(a.start) < timestamp(b.end) && timestamp(b.start) < timestamp(a.end);
}

/**
 * Stable weekly identity uses the explicit first-date's calendar week and ordinal.
 * A weekday/time change moves the same future occurrence key. Calendar edits retain
 * their actual start/end and source baseline, including on subsequent reconciles.
 */
export function reconcileSchedules(member: Member, existing: ScheduleEvent[], options: ScheduleOptions): { events: ScheduleEvent[]; issues: Issue[] } {
  if (existing.some(event => event.trainerId !== member.trainerId || event.companyMemberId !== member.companyMemberId)) throw new Error('Tenant/member scope mismatch.');
  if (new Set(existing.map(event => event.key)).size !== existing.length) throw new Error('Duplicate schedule keys in existing state.');
  const original = existing.map(event => ({ ...event }));
  const issues: Issue[] = [];
  const issue = (code: string, message: string): void => { issues.push({ code, message, companyMemberId: member.companyMemberId }); };
  const now = DateTime.fromISO(options.now, { setZone: true }).setZone(options.timezone);
  if (!now.isValid || !offsetPattern.test(options.now)) {
    issue('INVALID_SCHEDULE_CONTEXT', 'A valid IANA timezone and explicit current timestamp with offset are required.');
    return { events: original, issues };
  }
  if (!Number.isInteger(options.horizonMonths) || options.horizonMonths < 1 || options.horizonMonths > 12) {
    issue('INVALID_HORIZON', 'The schedule horizon must be 1 through 12 calendar months.');
    return { events: original, issues };
  }
  const malformed = original.some(event => !offsetPattern.test(event.start) || !offsetPattern.test(event.end) || !Number.isFinite(timestamp(event.start)) || !Number.isFinite(timestamp(event.end)) || timestamp(event.end) <= timestamp(event.start));
  if (malformed) {
    issue('INVALID_EXISTING_EVENT', 'An existing event has invalid timestamps. Confirm it before reconciling.');
    return { events: original, issues };
  }
  const working = original.map(event => {
    if (!isFuture(event, now)) return event;
    const statusChanged = event.sourceStatus === undefined ? event.status === 'cancelled' : event.status !== event.sourceStatus;
    const changed = statusChanged || timestamp(event.start) !== timestamp(event.sourceStart) || timestamp(event.end) !== timestamp(event.sourceEnd);
    return { ...event, manualOverride: event.manualOverride || changed };
  });
  if (terminalStatuses.has(member.status)) {
    return { events: sortEvents(working.map(event => isFuture(event, now) ? { ...event, status: 'cancelled' as const, sourceStatus: 'cancelled' as const } : event)), issues };
  }
  const desired = new Map<string, ScheduleEvent>();
  let relevantKind: ScheduleEvent['kind'];
  if (member.status === '\ud1b5\ud654') {
    relevantKind = 'call';
    if (!member.callAt) { issue('MISSING_CALL_DATE', 'No call event is generated until a call date and time are explicitly supplied.'); return { events: working, issues }; }
    const call = DateTime.fromISO(member.callAt, { setZone: true }).setZone(options.timezone);
    if (!offsetPattern.test(member.callAt) || !call.isValid) { issue('AMBIGUOUS_CALL_DATE', 'Confirm the call timestamp, including timezone offset.'); return { events: working, issues }; }
    if (call.toMillis() >= now.toMillis()) {
      const event = eventFor(member, `${scopeKey(member)}:call:${encodeURIComponent(asIso(call.toUTC()))}`, 'call', call);
      desired.set(event.key, event);
    }
  } else if (trainingRecurrenceState(member) === true) {
    relevantKind = 'training';
    if (!member.fixedSlot) { issue('MISSING_FIXED_SLOT', 'Confirm a fixed weekday and time before generating training sessions.'); return { events: working, issues }; }
    if (!validFixedSlot(member.fixedSlot)) { issue('INVALID_FIXED_SLOT', 'The fixed weekday/time is invalid or is not one hour.'); return { events: working, issues }; }
    const validated = validateExplicitDate(member.firstTrainingDate);
    if (!validated.date) {
      issues.push(...validated.issues.map(value => ({ ...value, companyMemberId: member.companyMemberId })));
      if (!validated.issues.length) issue('MISSING_FIRST_TRAINING_DATE', 'No training events are generated without an explicit first training date.');
      return { events: working, issues };
    }
    const firstDate = DateTime.fromISO(validated.date, { zone: options.timezone });
    const hasTrainingHistory = existing.some(event => event.kind === 'training');
    // An established series may legitimately change weekday after it began.
    if (firstDate.weekday !== member.fixedSlot.weekday && !(hasTrainingHistory && firstDate.startOf('day').toMillis() < now.startOf('day').toMillis())) {
      issue('FIRST_DATE_WEEKDAY_MISMATCH', 'The explicit first training date disagrees with the fixed weekday. Confirm which is correct.');
      return { events: working, issues };
    }
    const anchorWeek = firstDate.startOf('week');
    const horizon = now.plus({ months: options.horizonMonths });
    const firstIndex = Math.max(0, Math.floor(now.startOf('week').diff(anchorWeek, 'weeks').weeks) - 1);
    for (let index = firstIndex; index < firstIndex + 60; index++) {
      const calendarDay = anchorWeek.plus({ weeks: index, days: member.fixedSlot.weekday - 1 });
      const start = calendarDay.set({ hour: member.fixedSlot.hour, minute: member.fixedSlot.minute, second: 0, millisecond: 0 });
      if (start.toMillis() >= horizon.toMillis()) break;
      if (start.toMillis() < now.toMillis() || start.startOf('day').toMillis() < firstDate.startOf('day').toMillis()) continue;
      // DST gaps and repeated times need a human choice. Never silently shift them.
      if (!start.isValid || start.hour !== member.fixedSlot.hour || start.minute !== member.fixedSlot.minute || start.getPossibleOffsets().length !== 1) {
        issue('AMBIGUOUS_TIMEZONE_SLOT', `Confirm the daylight-saving transition occurrence on ${calendarDay.toISODate()}.`);
        continue;
      }
      const key = `${scopeKey(member)}:training:${validated.date}:week:${index}`;
      const event = eventFor(member, key, 'training', start);
      desired.set(key, event);
    }
  } else {
    if (member.status === '\ud0c8\ud1f4 \uc694\uccad' && trainingRecurrenceState(member) === undefined) {
      issue('TRAINING_ACTIVATION_REVIEW', 'The pre-request training activation is unknown. Existing appointments are preserved without starting a new series.');
    }
    // Unknown or pre-contact statuses are not authority to destroy an existing series.
    return { events: working, issues };
  }
  const output = new Map<string, ScheduleEvent>();
  for (const event of working) {
    if (!isFuture(event, now)) { output.set(event.key, event); desired.delete(event.key); continue; }
    if (event.manualOverride) {
      output.set(event.key, event);
      desired.delete(event.key);
      if (relevantKind === 'call' && event.kind === 'call') {
        for (const [key, candidate] of desired) if (candidate.kind === 'call') desired.delete(key);
      }
      continue;
    }
    const replacement = desired.get(event.key);
    if (replacement) {
      output.set(event.key, { ...replacement, ...(event.notionPageId !== undefined ? { notionPageId: event.notionPageId } : {}) });
      desired.delete(event.key);
    } else output.set(event.key, { ...event, status: 'cancelled', sourceStatus: 'cancelled' });
  }
  for (const event of desired.values()) output.set(event.key, event);
  const candidates = [...output.values()];
  const conflicts = detectScheduleConflicts(candidates);
  issues.push(...conflicts);
  // Preserve manual exceptions, but do not generate a new colliding automated event.
  const manual = candidates.filter(event => event.manualOverride && event.status === 'active');
  for (const event of candidates) {
    if (!event.manualOverride && isFuture(event, now) && manual.some(exception => overlaps(event, exception))) {
      const old = original.find(value => value.key === event.key);
      if (old && !isFuture(old, now)) output.set(old.key, old);
      else if (old) output.set(old.key, { ...old, status: 'cancelled', sourceStatus: 'cancelled' });
      else output.delete(event.key);
    }
  }
  return { events: sortEvents([...output.values()]), issues };
}
