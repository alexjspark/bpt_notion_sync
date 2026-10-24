import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMember, reconcileSchedules, withTrainingRecurrenceState } from '../src/index.js';
import type { Member, ScheduleOptions } from '../src/index.js';

const progressing = '\uc9c4\ud589';
const request = '\ud0c8\ud1f4 \uc694\uccad';
const member = (overrides: Partial<Member> = {}): Member => ({
  trainerId: 'synthetic-trainer', companyMemberId: 'synthetic-member', name: 'Synthetic member',
  status: progressing, notionPageId: 'synthetic-page', registrationDate: null,
  assignmentDate: null, assignmentEvidence: 'existing', membershipActivity: 'active', memo: '',
  fixedSlot: { weekday: 7, hour: 14, minute: 0, durationMinutes: 60 }, firstTrainingDate: '2026-10-25',
  callAt: null, survey: [], manualContent: '', ...overrides,
});
const options: ScheduleOptions = { now: '2026-10-22T00:00:00Z', timezone: 'Asia/Seoul', horizonMonths: 3 };

test('progress to withdrawal request preserves its active recurring series and replenishes the rolling horizon', () => {
  const before = reconcileSchedules(member(), [], options).events;
  const requested = withTrainingRecurrenceState(member({ status: request }), member());
  assert.equal(requested.trainingRecurrenceActive, true);
  const later = { ...options, now: '2026-12-01T00:00:00+09:00' };
  const once = reconcileSchedules(requested, before, later);
  assert.deepEqual(once.issues, []);
  for (const old of before) assert.deepEqual(once.events.find(event => event.key === old.key), old);
  assert.ok(once.events.some(event => event.start.startsWith('2027-02-28') && event.status === 'active'));
  const persisted = JSON.parse(JSON.stringify(requested)) as Member;
  const repeated = withTrainingRecurrenceState({ ...persisted, trainingRecurrenceActive: undefined }, persisted);
  assert.equal(repeated.trainingRecurrenceActive, true);
  assert.deepEqual(reconcileSchedules(repeated, once.events, later).events, once.events);
});

test('new and call phases never begin training solely because a withdrawal request arrives', () => {
  for (const status of ['\uc2e0\uaddc', '\ud1b5\ud654'] as const) {
    const previous = member({ status, callAt: '2026-10-23T14:00:00+09:00' });
    const old = reconcileSchedules(previous, [], options).events;
    const requested = withTrainingRecurrenceState({ ...previous, status: request, trainingRecurrenceActive: true }, previous);
    assert.equal(requested.trainingRecurrenceActive, false);
    const result = reconcileSchedules(requested, old, options);
    assert.deepEqual(result.events, old);
    assert.equal(result.events.filter(event => event.kind === 'training').length, 0);
  }
});

test('request with unrecorded prior activation preserves existing events and asks for review', () => {
  const old = reconcileSchedules(member(), [], options).events;
  const result = reconcileSchedules(member({ status: request }), old, { ...options, now: '2026-12-01T00:00:00+09:00' });
  assert.deepEqual(result.events, old);
  assert.equal(result.issues[0]?.code, 'TRAINING_ACTIVATION_REVIEW');
});

test('manual Calendar exceptions survive the request and future time changes', () => {
  const old = reconcileSchedules(member(), [], options).events;
  const exception = { ...old[2]!, start: '2026-11-09T17:00:00+09:00', end: '2026-11-09T18:00:00+09:00', manualOverride: true };
  const requested = withTrainingRecurrenceState(member({ status: request, fixedSlot: { weekday: 1, hour: 15, minute: 0, durationMinutes: 60 } }), member());
  const result = reconcileSchedules(requested, old.map(event => event.key === exception.key ? exception : event), { ...options, now: '2026-11-02T00:00:00Z' });
  assert.deepEqual(result.events.find(event => event.key === exception.key), exception);
  assert.equal(result.events.find(event => event.key === old[3]!.key)?.start, '2026-11-09T15:00:00+09:00');
});

test('confirmed withdrawal stops future recurrence, preserves history and cannot be resumed by another request', () => {
  const old = reconcileSchedules(member(), [], options).events;
  const requested = withTrainingRecurrenceState(member({ status: request }), member());
  const withdrawn = withTrainingRecurrenceState({ ...requested, status: '\ud0c8\ud1f4' }, requested);
  assert.equal(withdrawn.trainingRecurrenceActive, false);
  const later = { ...options, now: '2026-11-02T00:00:00Z' };
  const stopped = reconcileSchedules(withdrawn, old, later);
  assert.deepEqual(stopped.events.slice(0, 2), old.slice(0, 2));
  assert.ok(stopped.events.slice(2).every(event => event.status === 'cancelled'));
  const requestedAgain = withTrainingRecurrenceState({ ...withdrawn, status: request }, withdrawn);
  assert.equal(requestedAgain.trainingRecurrenceActive, false);
  assert.deepEqual(reconcileSchedules(requestedAgain, stopped.events, later).events, stopped.events);
});

test('company reimport preserves a saved request and its activation regardless of company progress', () => {
  const previous = withTrainingRecurrenceState(member({ status: request }), member());
  const result = prepareMember(member({ assignmentEvidence: 'new' }), previous);
  assert.equal(result.member.status, request);
  assert.equal(result.member.trainingRecurrenceActive, true);
  assert.throws(() => withTrainingRecurrenceState(member(), member({ trainerId: 'other-trainer' })), /scope mismatch/);
});
