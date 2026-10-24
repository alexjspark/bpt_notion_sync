import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DashboardSnapshot } from '@trainer/db';
import { Dashboard, ManualSyncView, manualCount, manualMemberReference, manualPreviewReason, manualErrorMessage, type ManualSyncRun, type ManualSyncSnapshot } from '../components/dashboard.js';

function run(overrides: Partial<ManualSyncRun> = {}): ManualSyncRun {
  return {
    id: 'run-test', mode: 'dry_run', status: 'needs_connection', stage: 'connection_required', attempts: 0,
    progressPercent: null, counts: { added: null, skipped: null, failed: null, plannedAdds: null, review: null },
    missingCapabilities: ['company_read_session', 'notion_read_integration'], errorCode: 'CONNECTION_REQUIRED',
    previewPlan: null, createdAt: '2026-10-22T12:00:00Z', finishedAt: null, ...overrides,
  };
}

function snapshot(runs: ManualSyncRun[] = []): ManualSyncSnapshot {
  return { mode: 'dry_run', connected: false, requiredConnections: ['company_read_session', 'notion_read_integration'],
    automaticSyncEnabled: false, previewOnly: true, externalWritesEnabled: false, runs };
}

function render(value: ManualSyncSnapshot | null, overrides = {}) {
  return renderToStaticMarkup(createElement(ManualSyncView, {
    snapshot: value, busy: false, loadError: false, notice: '', timezone: 'Asia/Seoul',
    onPreview() {}, onRefresh() {}, ...overrides,
  }));
}

test('withdrawal preview names the exact existing option, separates requests and preserves the write barrier', () => {
  const html = render(snapshot([run({ status: 'succeeded', stage: 'complete', missingCapabilities: [],
    previewPlan: { version: 1, mode: 'dry_run', companyCoverage: 'active_assigned', sourceScope: 'active-assigned',
      companyCount: 1, notionIdentityCount: 1,
      withdrawal: { coverage: 'complete', requestCount: 1, plannedStatusUpdates: 1, calendarPolicy: 'continue_existing_training' },
      members: [{ memberKey: 'ab'.repeat(32), decision: 'planned_status_update', reason: 'withdrawal_request_matched',
        targetStatus: '탈퇴 요청', targetOptionName: '탈퇴요청', targetOptionId: 'PRIVATE_OPTION_ID' }] } })]));
  assert.match(html, /상태 변경 예정: 1/);
  assert.match(html, /목표 상태: 탈퇴요청/);
  assert.match(html, /실제 상태 변경은 실행하지 않았습니다/);
  assert.match(html, /유지·보충/);
  assert.doesNotMatch(html, /PRIVATE_OPTION_ID/);
});

test('unknown counts stay unknown while a confirmed zero remains zero', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, 1.5]) assert.equal(manualCount(value), '—');
  assert.equal(manualCount(0), '0');
  assert.equal(manualCount(1200), '1,200');
});

test('a blocked run renders no successful execution or invented zero counts', () => {
  const html = render(snapshot([run({ counts: { added: 0, skipped: 0, failed: 0, plannedAdds: 0, review: 0 } })]));
  assert.match(html, /연결 필요 · 미실행/);
  assert.match(html, /동기화와 미리보기는 아직 실행되지 않았습니다/);
  assert.match(html, /<dd>—<\/dd>/);
  assert.doesNotMatch(html, /<dd>0<\/dd>|<progress|미리보기 완료/);
  assert.match(html, /회사 읽기 세션/);
  assert.match(html, /노션 읽기 연결/);
});

test('the disconnected primary button can record a connection check and explains its limits', () => {
  const html = render(snapshot());
  assert.match(html, /지금 회사 → 노션 동기화/);
  assert.match(html, /연결 확인 및 dry-run/);
  const button = html.match(/<button[^>]*aria-describedby="manual-sync-action-note"[^>]*>/)?.[0];
  assert.ok(button);
  assert.doesNotMatch(button, /disabled/);
  assert.match(html, /실제 동기화는 동작하지 않습니다/);
  assert.match(html, /일일 자동 실행은 꺼져 있습니다/);
  assert.match(html, /첫 쓰기 승인 전에는 읽기 전용 미리보기만/);
  assert.doesNotMatch(html, />반영하기<|>적용<|>승인</);
});

test('an unavailable initial read disables submission and offers refresh without false connection claims', () => {
  const html = render(null, { loadError: true });
  assert.match(html, /연결 상태 확인 불가/);
  assert.match(html, /disabled=""[^>]*aria-describedby="manual-sync-action-note"/);
  assert.match(html, /연결·기록 새로고침/);
  assert.doesNotMatch(html, /읽기 연결 확인<|<dd>0/);
});

test('pending and retry states never imply preview completion or known percentage', () => {
  for (const status of ['queued', 'running', 'retry'] as const) {
    const html = render(snapshot([run({ status, stage: status === 'running' ? 'company_snapshot' : 'queued' })]));
    assert.match(html, /<progress/);
    assert.doesNotMatch(html.match(/<progress[^>]*>/)?.[0] || '', /value=/);
    assert.doesNotMatch(html, /미리보기 완료/);
  }
});

test('completed dry-runs separate planned additions from zero actual writes', () => {
  const html = render({ ...snapshot([run({ status: 'succeeded', stage: 'complete', progressPercent: 100,
    missingCapabilities: [], counts: { plannedAdds: 2, skipped: 3, review: 1, failed: 0, added: 0 } })]), connected: true });
  assert.match(html, /미리보기 완료/);
  assert.match(html, /<dt>추가 예정<\/dt><dd>2<\/dd>/);
  assert.match(html, /<dt>실제 반영<\/dt><dd>0<\/dd>/);
  assert.match(html, /실제 쓰기는 비활성화/);
});

test('member preview renders only shortened opaque references and safe reason labels', () => {
  const memberKey = 'ab'.repeat(32);
  const html = render({ ...snapshot([run({ status: 'succeeded', stage: 'complete', missingCapabilities: [],
    previewPlan: { version: 1, mode: 'dry_run', companyCoverage: 'active_assigned', sourceScope: 'active-assigned', withdrawal: { coverage: 'not_connected', requestCount: null, plannedStatusUpdates: null, calendarPolicy: 'continue_existing_training' }, companyCount: 2, notionIdentityCount: 0,
      members: [{ memberKey, decision: 'planned_add', reason: 'PRIVATE_NAME_AND_EMAIL' },
        { memberKey: 'PRIVATE_REAL_NAME', decision: 'review', reason: 'https://private.invalid/error' }] } })]), connected: true });
  assert.match(html, /회원 · ababababab/);
  assert.match(html, /회원 식별자 확인 필요/);
  assert.match(html, /실제 반영 없음/);
  assert.doesNotMatch(html, new RegExp(memberKey));
  assert.doesNotMatch(html, /PRIVATE_NAME|PRIVATE_REAL_NAME|private\.invalid/);
  assert.equal(manualMemberReference('이름/회사-123'), '회원 식별자 확인 필요');
});

test('connection errors and unknown capability payloads cannot leak into presentation', () => {
  const html = render(snapshot([run({ status: 'failed', errorCode: 'SECRET_STACK_AND_TOKEN', missingCapabilities: ['SECRET_CONNECTION_NAME'] })]));
  assert.match(html, /미리보기 실패/);
  assert.match(html, /추가 필수 연결 확인/);
  assert.doesNotMatch(html, /SECRET_STACK|SECRET_CONNECTION/);
});

test('only allowlisted comparison reasons become explanatory labels', () => {
  assert.match(manualPreviewReason('already_exists'), /동일한 회사 회원 ID/);
  assert.match(manualPreviewReason('unknown_status'), /상태 확인 필요 · 자동 변경 없음/);
  assert.match(manualPreviewReason('duplicate_notion_identity'), /여러 개/);
  for (const reason of ['RAW_PRIVATE_ERROR', 'constructor', '__proto__']) assert.equal(manualPreviewReason(reason), '비교 근거 확인 필요');
  const html = render(snapshot([run({ missingCapabilities: ['constructor', '__proto__'] })]));
  assert.match(html, /추가 필수 연결 확인/);
  assert.doesNotMatch(html, /constructor|__proto__/);
});

test('safe error messages distinguish connection, source coverage, read permission, throttling and recovery', () => {
  assert.match(manualErrorMessage('CONNECTION_REQUIRED')!, /읽기 연결이 필요/);
  assert.match(manualErrorMessage('COMPANY_COVERAGE_UNVERIFIED')!, /회사 담당 회원 전체/);
  assert.match(manualErrorMessage('NOTION_COVERAGE_UNVERIFIED')!, /노션 회원 전체/);
  assert.match(manualErrorMessage('READ_FAILED')!, /인증 세션과 읽기 권한/);
  assert.match(manualErrorMessage('READ_RATE_LIMITED')!, /요청 속도를 제한/);
  assert.match(manualErrorMessage('READ_RETRYABLE')!, /일시적인 조회 오류.*재시도/);
  assert.match(manualErrorMessage('WORKER_INTERRUPTED')!, /작업 처리가 중단.*재시도/);
  assert.match(manualErrorMessage('EXECUTION_BUSY')!, /다른 작업이 처리 중/);
  assert.match(manualErrorMessage('MANUAL_SYNC_LEASE_LOST')!, /최신 요청 상태/);
  assert.equal(manualErrorMessage(null), null);
  const safeUnknown = '오류 원인을 확인할 수 없습니다. 연결 상태와 읽기 권한을 확인해 주세요.';
  for (const code of ['NAME_TOKEN_AND_RAW_ERROR', 'constructor', '__proto__']) assert.equal(manualErrorMessage(code), safeUnknown);
  const html = render(snapshot([run({ status: 'failed', errorCode: 'NOTION_COVERAGE_UNVERIFIED' })]));
  assert.match(html, /원인 안내.*노션 회원 전체를 확인하지 못해/);
  assert.doesNotMatch(html, /NOTION_COVERAGE_UNVERIFIED/);
});

test('the dashboard places the real manual entry before clearly marked synthetic operations', () => {
  const data: DashboardSnapshot = {
    trainer: { id: 'trainer-demo', name: '합성 트레이너' }, mode: 'mock', connections: [],
    settings: { dailyTime: null, timezone: 'Asia/Seoul', horizonMonths: 3, notionPollMinutes: 5, mockScheduleEnabled: false },
    members: [], jobs: [], issues: [], schedules: [], stats: { members: 0, activeSchedules: 0, needsReview: 0, lastSuccess: null },
  };
  const html = renderToStaticMarkup(createElement(Dashboard, { initialData: data }));
  assert.ok(html.indexOf('id="manual-sync"') < html.indexOf('class="mock-banner"'));
  assert.match(html, /합성 회원 확인 실행/);
  assert.match(html, /합성 Notion 변경 확인/);
  assert.match(html, /합성 작업의 완료는 실제 회사·노션 동기화 성공을 의미하지 않습니다/);
  assert.match(html, /마지막 합성 작업 성공/);
});

test('account binding failures render a specific safe cause and keep preview counts unknown',()=>{
  for(const code of ['COMPANY_ACCOUNT_BINDING_UNVERIFIED','COMPANY_ACCOUNT_MISMATCH']){
    const html=render({...snapshot([run()]),companyReviewCode:code});
    const message=manualErrorMessage(code);
    assert.ok(message);assert.ok(html.includes(message));
    assert.match(html,/<dd>\u2014<\/dd>/);
    assert.doesNotMatch(html,/<dd>0<\/dd>/);
  }
});
