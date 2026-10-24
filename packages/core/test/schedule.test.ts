import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { detectScheduleConflicts, reconcileSchedules } from '../src/index.js';
import type { Member, ScheduleEvent, ScheduleOptions } from '../src/index.js';

const member = (overrides: Partial<Member> = {}): Member => ({ trainerId: 'trainer-demo', companyMemberId: 'member-1', name: 'Synthetic member', status: '\uc9c4\ud589', notionPageId: 'mock-page-1', registrationDate: '2020-01-01', assignmentDate: null, assignmentEvidence: 'existing', membershipActivity: 'active', memo: '\uc77c\uc694\uc77c 14', fixedSlot: { weekday: 7, hour: 14, minute: 0, durationMinutes: 60 }, firstTrainingDate: '2026-10-25', callAt: null, survey: [], manualContent: '', ...overrides });
const options: ScheduleOptions = { now: '2026-10-22T02:00:00Z', timezone: 'Asia/Seoul', horizonMonths: 3 };
const active = (events: ScheduleEvent[]): ScheduleEvent[] => events.filter(event => event.status === 'active');
const localDate = (event: ScheduleEvent): string => DateTime.fromISO(event.start).setZone('Asia/Seoul').toISODate()!;

test('weekly training uses three calendar months, one-hour real Date values, and stable tenant-qualified keys', () => {
  const result = reconcileSchedules(member(), [], options);
  assert.deepEqual(result.issues, []);
  assert.equal(result.events.length, 13);
  assert.equal(result.events[0]!.start, '2026-10-25T14:00:00+09:00');
  assert.equal(result.events[0]!.end, '2026-10-25T15:00:00+09:00');
  assert.equal(localDate(result.events.at(-1)!), '2027-01-17');
  assert.ok(result.events.every(event => event.key.startsWith('trainer-demo:member-1:training:2026-10-25:week:')));
  assert.ok(result.events.every(event => DateTime.fromISO(event.end).diff(DateTime.fromISO(event.start), 'minutes').minutes === 60));
  assert.deepEqual(reconcileSchedules(member(), result.events, options).events, result.events);
});

test('three calendar months is not silently replaced with ninety days', () => {
  const result = reconcileSchedules(member({ firstTrainingDate: '2026-01-04' }), [], { ...options, now: '2026-01-01T00:00:00+09:00' });
  assert.equal(localDate(result.events.at(-1)!), '2026-03-29');
  assert.ok(result.events.every(event => DateTime.fromISO(event.start).toMillis() < DateTime.fromISO('2026-04-01T00:00:00+09:00').toMillis()));
});

test('no first training date means no guessed schedule even if registration exists', () => {
  const result = reconcileSchedules(member({ firstTrainingDate: null }), [], options);
  assert.equal(result.events.length, 0);
  assert.ok(result.issues.some(issue => issue.code === 'MISSING_FIRST_TRAINING_DATE'));
});

test('ambiguous year/date and a future first-date weekday mismatch require review', () => {
  const ambiguous = reconcileSchedules(member({ firstTrainingDate: '10/25' }), [], options);
  assert.equal(ambiguous.events.length, 0);
  assert.ok(ambiguous.issues.some(issue => issue.code === 'AMBIGUOUS_DATE'));
  const mismatch = reconcileSchedules(member({ firstTrainingDate: '2026-10-26' }), [], options);
  assert.equal(mismatch.events.length, 0);
  assert.ok(mismatch.issues.some(issue => issue.code === 'FIRST_DATE_WEEKDAY_MISMATCH'));
});

test('call status creates exactly one one-hour event from the explicit call timestamp', () => {
  const callMember = member({ status: '\ud1b5\ud654', callAt: '2026-10-23T16:30:00+09:00', firstTrainingDate: null });
  const result = reconcileSchedules(callMember, [], options);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.kind, 'call');
  assert.equal(result.events[0]!.start, '2026-10-23T16:30:00+09:00');
  assert.equal(result.events[0]!.end, '2026-10-23T17:30:00+09:00');
  assert.deepEqual(reconcileSchedules(callMember, result.events, options).events, result.events);
});

test('missing or timezone-free call dates never become invented appointments', () => {
  const missing = reconcileSchedules(member({ status: '\ud1b5\ud654', callAt: null }), [], options);
  assert.equal(missing.events.length, 0);
  assert.equal(missing.issues[0]!.code, 'MISSING_CALL_DATE');
  const ambiguous = reconcileSchedules(member({ status: '\ud1b5\ud654', callAt: '2026-10-23T16:30:00' }), [], options);
  assert.equal(ambiguous.events.length, 0);
  assert.equal(ambiguous.issues[0]!.code, 'AMBIGUOUS_CALL_DATE');
});

test('a new explicit call time preserves an earlier historical call record', () => {
  const before = reconcileSchedules(member({ status: '\ud1b5\ud654', callAt: '2026-10-23T16:30:00+09:00' }), [], options);
  const after = reconcileSchedules(member({ status: '\ud1b5\ud654', callAt: '2026-11-05T16:30:00+09:00' }), before.events, { ...options, now: '2026-11-01T00:00:00Z' });
  assert.equal(after.events.length, 2);
  assert.deepEqual(after.events[0], before.events[0]);
  assert.equal(after.events[1]!.start, '2026-11-05T16:30:00+09:00');
});

test('graduation, withdrawal, and pause cancel future events while preserving all past data', () => {
  const before = reconcileSchedules(member(), [], options).events;
  const now = '2026-11-02T00:00:00Z';
  const manual = { ...before[2]!, start: '2026-11-09T16:00:00+09:00', end: '2026-11-09T17:00:00+09:00', manualOverride: true };
  const original = [before[0]!, before[1]!, manual, ...before.slice(3)];
  for (const status of ['\uc878\uc5c5', '\ud0c8\ud1f4', '\uc720\uc608'] as const) {
    const result = reconcileSchedules(member({ status }), original, { ...options, now });
    assert.deepEqual(result.events[0], before[0]);
    assert.deepEqual(result.events[1], before[1]);
    assert.ok(result.events.slice(2).every(event => event.status === 'cancelled'));
    const preserved = result.events.find(event => event.key === manual.key)!;
    assert.equal(preserved.start, manual.start);
    assert.equal(preserved.sourceStart, manual.sourceStart);
    assert.equal(preserved.manualOverride, true);
  }
});

test('fixed weekday/time changes update future stable occurrences and preserve history', () => {
  const before = reconcileSchedules(member(), [], options).events;
  const result = reconcileSchedules(member({ fixedSlot: { weekday: 1, hour: 15, minute: 0, durationMinutes: 60 } }), before, { ...options, now: '2026-11-02T00:00:00Z' });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.events[0], before[0]);
  assert.deepEqual(result.events[1], before[1]);
  const updated = result.events.find(event => event.key === before[2]!.key)!;
  assert.equal(updated.start, '2026-11-02T15:00:00+09:00');
  assert.equal(updated.sourceStart, updated.start);
});

test('a same-week time change never moves an already completed occurrence into the future', () => {
  const before = reconcileSchedules(member(), [], options).events;
  const result = reconcileSchedules(member({ fixedSlot: { weekday: 7, hour: 18, minute: 0, durationMinutes: 60 } }), before, { ...options, now: '2026-10-25T15:00:00+09:00' });
  assert.deepEqual(result.events.find(event => event.key === before[0]!.key), before[0]);
  assert.equal(result.events.filter(event => localDate(event) === '2026-10-25').length, 1);
});

test('Calendar time edits are inferred as manual exceptions and preserved across repeated polls', () => {
  const before = reconcileSchedules(member(), [], options).events;
  const exception = { ...before[2]!, start: '2026-11-09T16:00:00+09:00', end: '2026-11-09T17:00:00+09:00' };
  const modified = before.map(event => event.key === exception.key ? exception : event);
  const changed = member({ fixedSlot: { weekday: 1, hour: 15, minute: 0, durationMinutes: 60 } });
  const nextOptions = { ...options, now: '2026-11-02T00:00:00Z' };
  const once = reconcileSchedules(changed, modified, nextOptions);
  const twice = reconcileSchedules(changed, once.events, nextOptions);
  const saved = twice.events.find(event => event.key === exception.key)!;
  assert.equal(saved.start, exception.start);
  assert.equal(saved.end, exception.end);
  assert.equal(saved.sourceStart, exception.sourceStart);
  assert.equal(saved.sourceEnd, exception.sourceEnd);
  assert.equal(saved.manualOverride, true);
  assert.deepEqual(twice.events, once.events);
});

test('a Calendar status-only cancellation is preserved across repeated polls and fixed-time changes', () => {
  const before = reconcileSchedules(member(), [], options).events;
  const cancelled = { ...before[2]!, status: 'cancelled' as const, manualOverride: false };
  const remote = before.map(event => event.key === cancelled.key ? cancelled : event);
  const once = reconcileSchedules(member(), remote, options);
  const saved = once.events.find(event => event.key === cancelled.key)!;
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.sourceStatus, 'active');
  assert.equal(saved.manualOverride, true);
  const twice = reconcileSchedules(member({ fixedSlot: { weekday: 7, hour: 16, minute: 0, durationMinutes: 60 } }), once.events, options);
  const preserved = twice.events.find(event => event.key === cancelled.key)!;
  assert.deepEqual(preserved, saved);
});

test('a cancelled legacy event without a status baseline is never silently resurrected', () => {
  const before = reconcileSchedules(member(), [], options).events;
  const { sourceStatus: _sourceStatus, ...legacy } = before[0]!;
  const cancelled = { ...legacy, status: 'cancelled' as const, manualOverride: false };
  const result = reconcileSchedules(member(), [cancelled, ...before.slice(1)], options);
  const saved = result.events.find(event => event.key === cancelled.key)!;
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.manualOverride, true);
});

test('automatic pause cancellation records a baseline and can resume without becoming a manual exception', () => {
  const before = reconcileSchedules(member(), [], options).events;
  const paused = reconcileSchedules(member({ status: '\uc720\uc608' }), before, options);
  assert.ok(paused.events.every(event => event.status === 'cancelled' && event.sourceStatus === 'cancelled' && !event.manualOverride));
  const resumed = reconcileSchedules(member(), paused.events, options);
  assert.ok(resumed.events.every(event => event.status === 'active' && event.sourceStatus === 'active' && !event.manualOverride));
  assert.equal(resumed.events.length, before.length);
});

test('progressing to call status cancels automated future training and preserves past sessions', () => {
  const before = reconcileSchedules(member(), [], options).events;
  const nextOptions = { ...options, now: '2026-11-02T00:00:00Z' };
  const result = reconcileSchedules(member({ status: '\ud1b5\ud654', callAt: '2026-11-05T10:00:00+09:00' }), before, nextOptions);
  assert.deepEqual(result.events[0], before[0]);
  assert.deepEqual(result.events[1], before[1]);
  assert.equal(active(result.events).filter(event => event.kind === 'call').length, 1);
  assert.ok(result.events.filter(event => event.kind === 'training' && DateTime.fromISO(event.start).toMillis() >= DateTime.fromISO(nextOptions.now).toMillis()).every(event => event.status === 'cancelled'));
});

test('manual exception collisions are flagged and do not create a duplicate automated event', () => {
  const before = reconcileSchedules(member(), [], options).events;
  const exception = { ...before[2]!, start: before[3]!.start, end: before[3]!.end, manualOverride: true };
  const changed = before.map(event => event.key === exception.key ? exception : event);
  const result = reconcileSchedules(member(), changed, options);
  assert.ok(result.issues.some(issue => issue.code === 'SCHEDULE_CONFLICT'));
  assert.equal(active(result.events).filter(event => event.start === exception.start).length, 1);
  assert.equal(result.events.find(event => event.key === before[3]!.key)!.status, 'cancelled');
});

test('restart catch-up fills the horizon and never fabricates missed historical occurrences', () => {
  const before = reconcileSchedules(member(), [], options).events;
  const now = '2026-12-01T00:00:00+09:00';
  const result = reconcileSchedules(member(), before, { ...options, now });
  for (const event of before.filter(value => DateTime.fromISO(value.start).toMillis() < DateTime.fromISO(now).toMillis())) {
    assert.deepEqual(result.events.find(value => value.key === event.key), event);
  }
  assert.equal(localDate(active(result.events).at(-1)!), '2027-02-28');
  const emptyRecovery = reconcileSchedules(member(), [], { ...options, now });
  assert.ok(emptyRecovery.events.every(event => DateTime.fromISO(event.start).toMillis() >= DateTime.fromISO(now).toMillis()));
});

test('tenant-qualified keys differ and cross-tenant supplied state is rejected', () => {
  const first = reconcileSchedules(member(), [], options);
  const second = reconcileSchedules(member({ trainerId: 'trainer-other' }), [], options);
  assert.notEqual(first.events[0]!.key, second.events[0]!.key);
  assert.throws(() => reconcileSchedules(member(), second.events, options), /scope mismatch/);
});

test('invalid timezone, offset-free now, invalid slot, and invalid stored events are held for review', () => {
  assert.equal(reconcileSchedules(member(), [], { ...options, timezone: 'Not/AZone' }).issues[0]!.code, 'INVALID_SCHEDULE_CONTEXT');
  assert.equal(reconcileSchedules(member(), [], { ...options, now: '2026-10-22T00:00:00' }).issues[0]!.code, 'INVALID_SCHEDULE_CONTEXT');
  assert.equal(reconcileSchedules(member({ fixedSlot: { weekday: 8, hour: 14, minute: 0, durationMinutes: 60 } }), [], options).issues[0]!.code, 'INVALID_FIXED_SLOT');
  const existing = reconcileSchedules(member(), [], options).events[0]!;
  const broken = { ...existing, end: existing.start };
  const result = reconcileSchedules(member(), [broken], options);
  assert.equal(result.issues[0]!.code, 'INVALID_EXISTING_EVENT');
  assert.deepEqual(result.events, [broken]);
});

test('DST gaps and repeated local times require explicit confirmation', () => {
  const gapMember = member({ firstTrainingDate: '2026-03-08', fixedSlot: { weekday: 7, hour: 2, minute: 30, durationMinutes: 60 } });
  const gap = reconcileSchedules(gapMember, [], { now: '2026-03-01T00:00:00-05:00', timezone: 'America/New_York', horizonMonths: 1 });
  assert.ok(gap.issues.some(issue => issue.code === 'AMBIGUOUS_TIMEZONE_SLOT'));
  assert.ok(gap.events.every(event => !event.start.startsWith('2026-03-08')));
  const repeated = reconcileSchedules(member({ firstTrainingDate: '2026-11-01', fixedSlot: { weekday: 7, hour: 1, minute: 30, durationMinutes: 60 } }), [], { now: '2026-10-25T00:00:00-04:00', timezone: 'America/New_York', horizonMonths: 1 });
  assert.ok(repeated.issues.some(issue => issue.code === 'AMBIGUOUS_TIMEZONE_SLOT'));
  assert.ok(repeated.events.every(event => !event.start.startsWith('2026-11-01')));
});

test('trainer-wide conflict detection excludes adjacent, cancelled, and other-tenant events', () => {
  const event = reconcileSchedules(member(), [], options).events[0]!;
  const other = { ...event, key: 'other', companyMemberId: 'member-2', start: event.start, end: event.end };
  assert.equal(detectScheduleConflicts([event, other]).length, 1);
  assert.equal(detectScheduleConflicts([event, { ...other, start: event.end, end: '2026-10-25T16:00:00+09:00' }]).length, 0);
  assert.equal(detectScheduleConflicts([event, { ...other, status: 'cancelled' }]).length, 0);
  assert.equal(detectScheduleConflicts([event, { ...other, trainerId: 'trainer-other' }]).length, 0);
});
