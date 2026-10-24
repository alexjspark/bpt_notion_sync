import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTemplateMappings, parseFixedSlot, prepareMember, validateExplicitDate } from '../src/index.js';
import type { Member, TemplateBlock } from '../src/index.js';

const fixture = (overrides: Partial<Member> = {}): Member => ({ trainerId: 'trainer-demo', companyMemberId: 'member-1', name: 'Synthetic member', status: '\uc2e0\uaddc', notionPageId: null, registrationDate: '2020-01-01', assignmentDate: null, assignmentEvidence: 'new', membershipActivity: 'active', memo: '\uc77c\uc694\uc77c 14', fixedSlot: null, firstTrainingDate: null, callAt: null, survey: [{ question: 'Question?\r\nRaw question', answer: '  Answer\nline 2\n@@ $$$ \ud55c\uae00  ' }], manualContent: '', ...overrides });

test('Sunday 14 and explicit one-hour variants parse to Sunday 14 through 15', () => {
  for (const input of ['\uc77c\uc694\uc77c 14', '\uc77c\uc694\uc77c 14:00', '\uc77c\uc694\uc77c 14\uc2dc', '\uc77c\uc694\uc77c 14~15', '\uc77c\uc694\uc77c 14:00~15:00']) {
    assert.deepEqual(parseFixedSlot(input), { slot: { weekday: 7, hour: 14, minute: 0, durationMinutes: 60 }, issues: [] });
  }
});

test('unconfirmed memo formats, multiple days, and non-one-hour ranges require review', () => {
  for (const input of ['\uc77c\uc694\uc77c 2 \uc624\ud6c4', '\uc77c\uc694\uc77c 14 \uc218\uc694\uc77c 15', '\uc77c\uc694\uc77c 14~16', '\uc77c\uc694\uc77c 24', '\uc77c\uc694\uc77c 14:99', '\uc77c\uc694\uc77c 23~00', '\ub9e4\uc8fc \uc77c\uc694\uc77c 14']) {
    const result = parseFixedSlot(input);
    assert.equal(result.slot, null, input);
    assert.ok(result.issues.length > 0, input);
  }
  assert.deepEqual(parseFixedSlot(''), { slot: null, issues: [] });
});

test('full dates are validated without guessing years, date order or impossible calendar days', () => {
  assert.deepEqual(validateExplicitDate('2028-02-29'), { date: '2028-02-29', issues: [] });
  assert.deepEqual(validateExplicitDate(null), { date: null, issues: [] });
  for (const value of ['10/25', '26-10-25', '2026-2-3', '2026-02-29', '2026-13-01', '2026-10-25T00:00:00Z']) {
    const result = validateExplicitDate(value);
    assert.equal(result.date, null);
    assert.ok(result.issues.length > 0);
  }
});

test('only proven newly assigned active members enter pre-contact status', () => {
  const source = fixture({ status: '\uc9c4\ud589' });
  const result = prepareMember(source);
  assert.equal(result.member.status, '\uc2e0\uaddc');
  assert.deepEqual(result.member.fixedSlot, { weekday: 7, hour: 14, minute: 0, durationMinutes: 60 });
  assert.equal(result.member.assignmentDate, null);
  assert.equal(result.member.registrationDate, '2020-01-01');
  assert.equal(result.member.firstTrainingDate, null);
});

test('omitted existing members retain meaningful status and get activity/status review instead of blanket reset', () => {
  const known = prepareMember(fixture({ assignmentEvidence: 'existing', status: '\uc9c4\ud589' }));
  assert.equal(known.member.status, '\uc9c4\ud589');
  assert.ok(known.issues.some(issue => issue.code === 'EXISTING_MEMBER_REVIEW'));
  const unverified = prepareMember(fixture({ assignmentEvidence: 'existing', membershipActivity: 'unknown' }));
  assert.equal(unverified.member.status, '\ud655\uc778\ud544\uc694');
  assert.ok(unverified.issues.some(issue => issue.code === 'MEMBERSHIP_REVIEW'));
  const withdrawn = prepareMember(fixture({ assignmentEvidence: 'existing', membershipActivity: 'withdrawn' }));
  assert.equal(withdrawn.member.status, '\ud0c8\ud1f4');
});

test('existing Notion status, manual content, and explicit scheduling fields survive company refresh', () => {
  const original = fixture({ status: '\ud1b5\ud654', notionPageId: 'saved-notion-page', manualContent: 'User manual text\nDO NOT CHANGE', assignmentDate: '2026-10-01', fixedSlot: { weekday: 2, hour: 10, minute: 0, durationMinutes: 60 }, firstTrainingDate: '2026-10-27', callAt: '2026-10-23T09:00:00+09:00' });
  const source = fixture({ manualContent: 'Replace?', membershipActivity: 'withdrawn', assignmentDate: null });
  const result = prepareMember(source, original);
  assert.equal(result.member.status, original.status);
  assert.equal(result.member.manualContent, original.manualContent);
  assert.equal(result.member.notionPageId, original.notionPageId);
  assert.deepEqual(result.member.fixedSlot, original.fixedSlot);
  assert.equal(result.member.firstTrainingDate, original.firstTrainingDate);
  assert.equal(result.member.callAt, original.callAt);
  assert.equal(result.member.assignmentDate, original.assignmentDate);
  assert.ok(result.issues.some(issue => issue.code === 'WITHDRAWAL_REVIEW'));
});

test('survey questions and answers remain verbatim including whitespace, newlines and placeholder-looking text', () => {
  const source = fixture();
  const result = prepareMember(source);
  assert.deepEqual(result.member.survey, source.survey);
  assert.notEqual(result.member.survey, source.survey);
  assert.notEqual(result.member.survey[0], source.survey[0]);
});

test('explicitly cleared Notion dates and fixed slots stay cleared during a company refresh', () => {
  const saved = fixture({ firstTrainingDate: null, callAt: null, fixedSlot: null });
  const incoming = fixture({ firstTrainingDate: '2026-10-25', callAt: '2026-10-23T09:00:00+09:00', fixedSlot: { weekday: 7, hour: 14, minute: 0, durationMinutes: 60 } });
  const result = prepareMember(incoming, saved);
  assert.equal(result.member.firstTrainingDate, null);
  assert.equal(result.member.callAt, null);
  assert.equal(result.member.fixedSlot, null);
});

test('member refresh rejects tenant or member mismatch', () => {
  assert.throws(() => prepareMember(fixture(), fixture({ trainerId: 'trainer-other' })), /scope mismatch/);
  assert.throws(() => prepareMember(fixture(), fixture({ companyMemberId: 'another-member' })), /scope mismatch/);
});

test('template token meanings are explicit per block/context, including nested growth-history title', () => {
  const blocks: TemplateBlock[] = [
    { id: 'name', text: '$$$ profile', ownership: 'template' },
    { id: 'coach', text: '@@ coach / $$$ code', children: [{ id: 'growth', text: '000\ub2d8 \uc131\uc7a5 \ud788\uc2a4\ud1a0\ub9ac' }] },
  ];
  const result = applyTemplateMappings(blocks, [
    { blockId: 'name', token: '$$$', contextKey: 'memberName', expectedText: '$$$ profile' },
    { blockId: 'coach', token: '@@', contextKey: 'coachName' },
    { blockId: 'coach', token: '$$$', contextKey: 'companyCode' },
    { blockId: 'growth', token: '000', contextKey: 'memberName' },
  ], { memberName: 'Member A', coachName: 'Coach B', companyCode: 'Code C' });
  assert.deepEqual(result.issues, []);
  assert.equal(result.blocks[0]!.text, 'Member A profile');
  assert.equal(result.blocks[1]!.text, 'Coach B coach / Code C code');
  assert.equal(result.blocks[1]!.children![0]!.text, 'Member A\ub2d8 \uc131\uc7a5 \ud788\uc2a4\ud1a0\ub9ac');
  assert.equal(blocks[0]!.text, '$$$ profile');
});

test('unmapped or stale-context placeholders remain visible for confirmation', () => {
  const result = applyTemplateMappings([{ id: 'source', text: '$$$ / @@' }], [{ blockId: 'source', token: '$$$', contextKey: 'memberName', expectedText: 'An older template' }], { memberName: 'Member A' });
  assert.equal(result.blocks[0]!.text, '$$$ / @@');
  assert.ok(result.issues.some(issue => issue.code === 'TEMPLATE_CONTEXT_MISMATCH'));
  assert.ok(result.issues.some(issue => issue.code === 'UNMAPPED_TEMPLATE_TOKEN'));
});

test('repeated tokens require explicit original occurrence positions and are replaced simultaneously', () => {
  const blocks = [{ id: 'repeated', text: '$$$ one / $$$ two' }];
  const ambiguous = applyTemplateMappings(blocks, [{ blockId: 'repeated', token: '$$$', contextKey: 'first' }], { first: 'Alpha' });
  assert.equal(ambiguous.blocks[0]!.text, blocks[0]!.text);
  assert.ok(ambiguous.issues.some(issue => issue.code === 'AMBIGUOUS_TEMPLATE_TOKEN'));
  const exact = applyTemplateMappings(blocks, [
    { blockId: 'repeated', token: '$$$', contextKey: 'first', occurrence: 1 },
    { blockId: 'repeated', token: '$$$', contextKey: 'second', occurrence: 2 },
  ], { first: 'Alpha', second: 'Beta' });
  assert.equal(exact.blocks[0]!.text, 'Alpha one / Beta two');
  assert.deepEqual(exact.issues, []);
});

test('manual blocks and descendants cannot be overwritten even with a matching mapping', () => {
  const blocks: TemplateBlock[] = [{ id: 'manual', text: '$$$ user note', ownership: 'manual', children: [{ id: 'child', text: '@@ manual child' }] }];
  const result = applyTemplateMappings(blocks, [{ blockId: 'manual', token: '$$$', contextKey: 'name' }, { blockId: 'child', token: '@@', contextKey: 'name' }], { name: 'Wrong replacement' });
  assert.deepEqual(result.blocks, blocks);
  assert.equal(result.issues.filter(issue => issue.code === 'MANUAL_BLOCK_PRESERVED').length, 2);
});

test('missing template IDs and context values are reported instead of fabricated', () => {
  const result = applyTemplateMappings([{ id: 'real', text: '@@' }], [
    { blockId: 'not-found', token: '@@', contextKey: 'value' },
    { blockId: 'real', token: '@@', contextKey: 'unknown' },
  ], { value: 'Supplied' });
  assert.ok(result.issues.some(issue => issue.code === 'MISSING_TEMPLATE_BLOCK'));
  assert.ok(result.issues.some(issue => issue.code === 'MISSING_TEMPLATE_VALUE'));
  assert.equal(result.blocks[0]!.text, '@@');
});

test('compact and spaced Korean weekday plus 24-hour hour use one-hour duration', () => {
  for (const input of ['\uc77c\uc694\uc77c13', '\uc77c\uc694\uc77c 13', '\uc77c\uc694\uc77c13:00', '\uc77c\uc694\uc77c13~14']) {
    assert.deepEqual(parseFixedSlot(input), {slot:{weekday:7,hour:13,minute:0,durationMinutes:60},issues:[]});
  }
  for (const input of ['\uc77c\uc694\uc77c14', '\uc77c\uc694\uc77c 14']) assert.deepEqual(parseFixedSlot(input).slot, {weekday:7,hour:14,minute:0,durationMinutes:60});
});
test('compact notation still rejects impossible, ambiguous, or multiple slots', () => {
  for (const input of ['\uc77c\uc694\uc77c135','\uc77c\uc694\uc77c24','\uc77c\uc694\uc77c13:99','\uc77c\uc694\uc77c13~15','\uc77c\uc694\uc77c13 \uc218\uc694\uc77c14','\uc77c\uc694\uc77c1 \uc624\ud6c4']) {
    const parsed=parseFixedSlot(input);assert.equal(parsed.slot,null,input);assert.ok(parsed.issues.length,input);
  }
});
test('compact memo ingestion maps a new source while existing manual scheduling stays preserved', () => {
  const source=fixture({memo:'\uc77c\uc694\uc77c13'});
  assert.deepEqual(prepareMember(source).member.fixedSlot,{weekday:7,hour:13,minute:0,durationMinutes:60});
  const saved=fixture({fixedSlot:{weekday:2,hour:10,minute:0,durationMinutes:60}});
  assert.deepEqual(prepareMember(source,saved).member.fixedSlot,saved.fixedSlot);
  assert.equal(prepareMember(source,fixture({fixedSlot:null})).member.fixedSlot,null);
});
