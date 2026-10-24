'use client';

import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { DashboardSnapshot } from '@trainer/db';
import {StorageTestPanel} from './storage-test-panel';
import {ContactSaveOncePanel} from './contact-save-once-panel';
import {ProfileSaveOncePanel} from './profile-save-once-panel';

type Settings = DashboardSnapshot['settings'];
type Tone = 'neutral' | 'good' | 'warning' | 'danger' | 'blue';

const weekdays = ['', '월', '화', '수', '목', '금', '토', '일'];
const kindLabels: Record<string, string> = { company_sync: '합성 회원 전체 확인', notion_poll: '합성 Notion 변경 확인', call: '통화', training: '수업' };
const jobLabels: Record<string, string> = { pending: '대기', queued: '대기', running: '실행 중', completed: '완료', succeeded: '완료', retry: '재시도 대기', retrying: '재시도 대기', failed: '실패' };

function formatDate(value: string | null | undefined, timezone: string, full = false): string {
  if (!value) return '아직 없음';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '날짜 확인 필요';
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      ...(full ? { year: 'numeric' as const } : {}), hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function badgeTone(value: string): Tone {
  if (['완료', '진행', 'active', 'completed', 'succeeded', 'connected', 'mock'].includes(value)) return 'good';
  if (['failed', '실패', '탈퇴'].includes(value)) return 'danger';
  if (['확인필요', 'retry', 'retrying', '유예', 'unverified', 'disabled'].includes(value)) return 'warning';
  if (['running', '통화'].includes(value)) return 'blue';
  return 'neutral';
}

/** Legacy initial-status values are display-only compatibility inputs. */
export function memberStatusLabel(status: string): string {
  return status === '\uce74\ud1a1\uc804' ? '\uc2e0\uaddc' : status;
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: Tone }) {
  return <span className={`badge ${tone}`}>{typeof children === 'string' ? memberStatusLabel(children) : children}</span>;
}

function SectionTitle({ number, title, detail, children }: { number: string; title: string; detail: string; children?: React.ReactNode }) {
  return <div className="section-title"><div><span className="section-number">{number}</span><h2>{title}</h2><p>{detail}</p></div>{children}</div>;
}

export type ManualSyncPreviewPlan = {
  version: 1;
  mode: 'dry_run';
  companyCoverage: 'active_assigned';
  sourceScope: 'active-assigned';
  companyCount: number;
  notionIdentityCount: number;
  notionIdentityCoverage?: 'complete' | 'partial';
  unresolvedNotionRows?: number;
  members: Array<{ memberKey: string; decision: 'planned_add' | 'planned_status_update' | 'skip' | 'review'; reason: string; targetStatus?: string; targetOptionName?: string; targetOptionId?: string }>;
  withdrawal: { coverage: 'not_connected' | 'complete'; requestCount: number | null; plannedStatusUpdates: number | null; calendarPolicy: 'continue_existing_training' };
};

export type ManualSyncRun = {
  id: string;
  mode: 'dry_run';
  status: 'needs_connection' | 'queued' | 'running' | 'retry' | 'succeeded' | 'failed';
  stage: 'connection_required' | 'queued' | 'company_snapshot' | 'notion_inventory' | 'planning' | 'complete';
  attempts: number;
  progressPercent: number | null;
  counts: { added: number | null; skipped: number | null; failed: number | null; plannedAdds: number | null; review: number | null };
  missingCapabilities: string[];
  errorCode: string | null;
  previewPlan: ManualSyncPreviewPlan | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ManualSyncSnapshot = {
  mode: 'dry_run';
  connected: boolean;
  requiredConnections: string[];
  automaticSyncEnabled: false;
  previewOnly: true;
  externalWritesEnabled: false;
  runs: ManualSyncRun[];
  companyReviewCode?:string|null;
};

const manualStatusLabels: Record<ManualSyncRun['status'], string> = {
  needs_connection: '연결 필요 · 미실행', queued: '미리보기 대기', running: '미리보기 실행 중',
  retry: '미리보기 재시도 대기', succeeded: '미리보기 완료', failed: '미리보기 실패',
};
const manualStageLabels: Record<ManualSyncRun['stage'], string> = {
  connection_required: '시작 전 · 조회와 비교 미실행', queued: '읽기 작업 대기',
  company_snapshot: '회사 회원 읽기', notion_inventory: '노션 회원 읽기', planning: '추가 예정 항목 비교', complete: '읽기 전용 비교 완료',
};
const connectionLabels: Record<string, string> = {
  company_read_session: '회사 읽기 세션', notion_read_integration: '노션 읽기 연결',
};

export function manualCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('ko-KR') : '—';
}

function manualTone(status: ManualSyncRun['status']): Tone {
  if (status === 'succeeded') return 'good';
  if (status === 'failed') return 'danger';
  if (status === 'needs_connection' || status === 'retry') return 'warning';
  if (status === 'running') return 'blue';
  return 'neutral';
}

function connectionNames(capabilities: string[]): string[] {
  return [...new Set(capabilities.map((capability) => Object.hasOwn(connectionLabels, capability) ? connectionLabels[capability] : '추가 필수 연결 확인'))];
}

export function manualMemberReference(memberKey: string): string {
  return /^[a-f0-9]{64}$/i.test(memberKey) ? `회원 · ${memberKey.slice(0, 10)}` : '회원 식별자 확인 필요';
}

const previewDecisionLabels: Record<string, string> = { planned_add: '추가 예정', skip: '건너뜀', review: '확인 필요' };
previewDecisionLabels.planned_status_update = '상태 변경 예정';
const previewReasonLabels: Record<string, string> = {
  notion_identity_unresolved: '\uc5b4\ub4dc\ubbfc URL\uc774 \uc5c6\ub294 Notion \ud589\uacfc \uc911\ubcf5\ub420 \uc218 \uc788\uc5b4 \uc2e0\uaddc \uacc4\ud68d\uc744 \ubcf4\ub958\ud569\ub2c8\ub2e4.',
  withdrawal_status_already_set: '\uc774\ubbf8 \ud0c8\ud1f4\uc694\uccad \uc0c1\ud0dc \u00b7 \uc720\uc9c0',
  withdrawal_request_matched: '탈퇴 요청 UID가 기존 Notion 회원 한 명과 일치합니다.',
  withdrawal_member_missing: '탈퇴 요청 UID와 일치하는 기존 Notion 회원이 없습니다. 새 회원은 만들지 않습니다.',
  withdrawal_status_unverified: 'Notion의 정확한 탈퇴요청 옵션을 읽기 검증해야 합니다.',
  missing_in_notion: '노션에서 일치하는 회사 회원 ID를 찾지 못함', already_exists: '노션에 동일한 회사 회원 ID가 있음',
  excluded_status: '졸업·탈퇴·유예 상태로 추가 대상에서 제외', withdrawn_member: '탈퇴 회원으로 추가 대상에서 제외',
  unknown_status: '상태 확인 필요 · 자동 변경 없음', unknown_activity: '회원 활동 여부 확인 필요',
  duplicate_notion_identity: '노션에 동일한 회사 회원 ID가 여러 개 있음',
};

export function manualPreviewReason(reason: string): string {
  return Object.hasOwn(previewReasonLabels, reason) ? previewReasonLabels[reason] : '비교 근거 확인 필요';
}

const manualErrorLabels: Record<string, string> = {
  COMPANY_ACCOUNT_BINDING_UNVERIFIED: '\uD68C\uC0AC \uACC4\uC815\uC758 \uC548\uC815 ID\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD574 \uC218\uC9D1\uC744 \uBCF4\uB958\uD588\uC2B5\uB2C8\uB2E4.',
  COMPANY_ACCOUNT_MISMATCH: '\uD68C\uC0AC \uACC4\uC815\uC774 \uBC14\uB010 \uAC83\uC73C\uB85C \uD655\uC778\uB418\uC5B4 \uC218\uC9D1\uC744 \uCC28\uB2E8\uD588\uC2B5\uB2C8\uB2E4.',
  COMPANY_FILTER_SCOPE_PARTIAL: '\uD68C\uC0AC \uD544\uD130 \uBC94\uC704\uB97C \uD655\uC778\uD574\uC57C \uD569\uB2C8\uB2E4.',
  COMPANY_ROW_SHAPE_MISMATCH: '\uD68C\uC0AC \uD45C \uAD6C\uC870\uAC00 \uB2EC\uB77C \uC218\uC9D1\uC744 \uBCF4\uB958\uD588\uC2B5\uB2C8\uB2E4.',
  WITHDRAWAL_COVERAGE_UNVERIFIED: '탈퇴 요청 목록의 담당 범위와 마지막 페이지가 검증되지 않았습니다.',
  WITHDRAWAL_SNAPSHOT_CHANGED: '탈퇴 요청 목록이 조회 중 바뀌었습니다. 안전하게 다시 확인합니다.',
  WITHDRAWAL_PAGINATION_INVALID: '탈퇴 요청 페이지 이동 구조가 검증된 설정과 다릅니다.',
  WITHDRAWAL_IDENTITY_INVALID: '탈퇴 요청 UID를 안전하게 확인할 수 없습니다.',
  READ_AUTH_REQUIRED: '읽기 연결의 로그인이 만료되었거나 대상 접근 권한이 없습니다. 연결 상태를 확인해 주세요.',
  CONNECTION_REQUIRED: '회사 읽기 세션 또는 노션 읽기 연결이 필요합니다. 조회와 비교는 시작되지 않았습니다.',
  COMPANY_COVERAGE_UNVERIFIED: '회사 담당 회원 전체를 확인하지 못해 비교를 중단했습니다.',
  COMPANY_SNAPSHOT_CHANGED: '회사 회원 조회 중 원본이 변경되었습니다. 동일한 기준의 목록으로 다시 조회해야 합니다.',
  COMPANY_PAGINATION_INVALID: '회사 회원 목록의 페이지 연결을 확인하지 못했습니다. 전체 목록 확인이 필요합니다.',
  COMPANY_CONFLICTING_DUPLICATE: '회사 회원 목록에서 동일한 회원 ID의 정보가 서로 달라 확인이 필요합니다.',
  NOTION_COVERAGE_UNVERIFIED: '노션 회원 전체를 확인하지 못해 비교를 중단했습니다.',
  NOTION_SNAPSHOT_CHANGED: '노션 회원 조회 중 원본이 변경되었습니다. 동일한 기준의 목록으로 다시 조회해야 합니다.',
  NOTION_PAGINATION_INVALID: '노션 회원 목록의 페이지 연결을 확인하지 못했습니다. 전체 목록 확인이 필요합니다.',
  TENANT_MISMATCH: '조회 결과의 트레이너 범위가 일치하지 않아 중단했습니다.',
  INVALID_IDENTITY: '회원 식별 정보가 올바르지 않아 비교를 중단했습니다.',
  PREVIEW_KEY_REQUIRED: '회원 식별자를 안전하게 마스킹할 서버 설정이 필요합니다.',
  MANUAL_SYNC_LEASE_LOST: '작업 처리 권한이 다른 실행으로 넘어갔습니다. 최신 요청 상태를 확인해 주세요.',
  READ_FAILED: '회원 조회에 실패했습니다. 인증 세션과 읽기 권한을 확인해 주세요.',
  READ_RETRYABLE: '일시적인 조회 오류가 발생했습니다. 작업의 재시도 상태를 확인해 주세요.',
  READ_RATE_LIMITED: '서비스가 요청 속도를 제한하여 조회를 마치지 못했습니다.',
  WORKER_INTERRUPTED: '작업 처리가 중단되었습니다. 재시도 상태와 최신 기록을 확인해 주세요.',
  EXECUTION_BUSY: '같은 트레이너의 다른 작업이 처리 중입니다. 재시도 상태를 확인해 주세요.',
};

export function manualErrorMessage(errorCode: string | null): string | null {
  if (!errorCode) return null;
  return Object.hasOwn(manualErrorLabels, errorCode) ? manualErrorLabels[errorCode] : '오류 원인을 확인할 수 없습니다. 연결 상태와 읽기 권한을 확인해 주세요.';
}

export function manualTargetLabel(member: ManualSyncPreviewPlan['members'][number]): string {
  if (member.decision === 'planned_status_update') return member.targetOptionName === '탈퇴요청' || member.targetOptionName === '탈퇴 요청' ? member.targetOptionName : '상태 옵션 확인 필요';
  return member.decision === 'planned_add' ? '신규' : '—';
}

function WithdrawalPreview({ plan }: { plan: ManualSyncPreviewPlan | null | undefined }) {
  const withdrawal = plan?.withdrawal;
  return <div className="manual-withdrawal" role="note"><p>신규 가져오기는 회사 ‘진행’ 회원만 비교합니다. 기존 Notion 상태는 유지하며, 조회 누락을 탈퇴로 추측하지 않습니다.</p><strong>탈퇴 요청 상태 변경 예정: {manualCount(withdrawal?.plannedStatusUpdates)}</strong><p>{withdrawal?.coverage === 'complete' ? `요청 목록 ${manualCount(withdrawal.requestCount)}건을 UID로 비교했습니다.` : '탈퇴 요청 목록은 아직 연결·완전성 검증 전입니다.'} 실제 상태 변경은 실행하지 않았습니다.</p><p>이미 진행하던 반복 트레이닝은 탈퇴 확정 전까지 유지·보충하며, 신규·통화 단계에서 트레이닝을 새로 시작하지 않습니다.</p></div>;
}

export function ManualSyncView({ snapshot, busy, loadError, notice, timezone, onPreview, onRefresh }: {
  snapshot: ManualSyncSnapshot | null;
  busy: boolean;
  loadError: boolean;
  notice: string;
  timezone: string;
  onPreview: () => void;
  onRefresh: () => void;
}) {
  const latest = snapshot?.runs[0];
  const blocked = latest?.status === 'needs_connection';
  const count = (key: keyof ManualSyncRun['counts']) => manualCount(blocked ? null : latest?.counts[key]);
  const required = connectionNames(latest?.missingCapabilities.length ? latest.missingCapabilities : snapshot?.requiredConnections || []);
  const progress = latest?.progressPercent;
  const validProgress = typeof progress === 'number' && Number.isFinite(progress) && progress >= 0 && progress <= 100;

  return (
    <section className="section manual-sync card" id="manual-sync" aria-labelledby="manual-sync-heading" aria-busy={busy}>
      <div className="manual-sync-heading">
        <div><span className="eyebrow">COMPANY → NOTION · DRY-RUN</span><h2 id="manual-sync-heading">회사 → 노션 수동 동기화</h2><p>내 담당 회원을 조회하고, 노션에 추가할 항목을 미리 확인합니다.</p></div>
        <Badge tone={snapshot?.connected ? 'blue' : 'warning'}>{snapshot ? snapshot.connected ? '읽기 연결 확인' : '연결 필요' : loadError ? '연결 상태 확인 불가' : '연결 확인 중'}</Badge>
      </div>
      <div className="manual-sync-action">
        <div><button className="button primary manual-sync-button" type="button" disabled={busy || !snapshot} onClick={onPreview} aria-describedby="manual-sync-action-note">{busy ? '연결 확인 요청 중…' : '지금 회사 → 노션 동기화'}<span aria-hidden="true">↗</span></button><small id="manual-sync-action-note">연결 확인 및 dry-run</small></div>
        <p>실제 일일 자동 실행은 꺼져 있습니다. 첫 쓰기 승인 전에는 읽기 전용 미리보기만 제공하며, 노션에 실제 반영하지 않습니다.</p>
      </div>
      {snapshot && !snapshot.connected && <div className="manual-connection-note" role="note"><strong>아직 연결되지 않아 실제 동기화는 동작하지 않습니다.</strong><p>버튼을 누르면 필요한 연결을 확인하고, ‘연결 필요’ 기록을 남깁니다. 회사 회원 조회와 노션 비교는 시작하지 않습니다.</p></div>}
      {snapshot?.companyReviewCode && <p className="manual-run-note" role="note">{manualErrorMessage(snapshot.companyReviewCode)}</p>}
      {required.length > 0 && <ul className="manual-requirements" aria-label="필요한 읽기 연결">{required.map((requirement) => <li key={requirement}><span aria-hidden="true">○</span>{requirement}</li>)}</ul>}
      <div className="manual-feedback" role="status" aria-live="polite">{notice || (loadError ? '작업 기록을 새로 확인하지 못했습니다. 아래 기록이 있으면 마지막으로 확인한 결과입니다.' : '')}</div>
      {latest ? <div className="manual-latest">
        <div className="manual-run-heading"><div><h3>최근 미리보기 요청</h3><p>요청 {formatDate(latest.createdAt, timezone, true)}</p></div><Badge tone={manualTone(latest.status)}>{manualStatusLabels[latest.status] || '상태 확인 필요'}</Badge></div>
        <div className="manual-progress"><span>{manualStageLabels[latest.stage] || '진행 상태 확인 필요'}</span>{['queued', 'running', 'retry'].includes(latest.status) && <progress aria-label="읽기 전용 미리보기 진행" max={100} {...(validProgress ? { value: progress } : {})} />}</div>
        {blocked && <p className="manual-run-note">연결 확인 요청이 기록되었습니다. 동기화와 미리보기는 아직 실행되지 않았습니다.</p>}
        {latest.status === 'succeeded' && <p className="manual-run-note">읽기 전용 미리보기가 완료되었습니다. 추가 예정 건수는 계획이며 실제 반영 건수와 구분됩니다.</p>}
        {latest.status === 'failed' && <p className="manual-run-note">미리보기를 완료하지 못했습니다. 연결과 읽기 권한을 확인한 뒤 다시 요청해 주세요.</p>}
        {latest.errorCode && <p className="manual-run-note"><strong>원인 안내</strong> · {manualErrorMessage(latest.errorCode)}</p>}
        {latest.status === 'succeeded' && latest.previewPlan?.notionIdentityCoverage === 'partial' && <p className="manual-run-note" role="note">{'\ubd80\ubd84 \ubbf8\ub9ac\ubcf4\uae30 \uc644\ub8cc: Notion UID \ud655\uc778 \ud544\uc694 '}{manualCount(latest.previewPlan.unresolvedNotionRows)}{'\ud589. \uc911\ubcf5 \uac00\ub2a5\uc131\uc774 \uc788\ub294 \uc2e0\uaddc \uacc4\ud68d\uc740 \ubcf4\ub958\ud569\ub2c8\ub2e4.'}</p>}
        <dl className="manual-counts"><div><dt>추가 예정</dt><dd>{count('plannedAdds')}</dd></div><div><dt>건너뜀</dt><dd>{count('skipped')}</dd></div><div><dt>확인 필요</dt><dd>{count('review')}</dd></div><div><dt>실패</dt><dd>{count('failed')}</dd></div><div className="manual-actual-count"><dt>실제 반영</dt><dd>{count('added')}</dd></div></dl>
        <p className="manual-count-note">— 는 아직 확인하지 않은 건수입니다. 실제 쓰기는 비활성화되어 있습니다.</p>
        {!blocked && latest.previewPlan && <div className="manual-preview"><div className="manual-run-heading"><div><h3>회원별 읽기 전용 미리보기</h3><p>회사 담당 회원 {manualCount(latest.previewPlan.companyCount)}명 · 노션 회원 식별자 {manualCount(latest.previewPlan.notionIdentityCount)}개 비교</p><p>이름과 회사 회원 ID 대신 마스킹된 식별자를 표시합니다.</p></div><Badge tone="neutral">실제 반영 없음</Badge></div><div className="table-wrap"><table><caption className="sr-only">마스킹된 담당 회원별 추가 예정, 건너뜀, 확인 필요 계획</caption><thead><tr><th scope="col">회원 식별자</th><th scope="col">계획</th><th scope="col">확인 내용</th></tr></thead><tbody>{latest.previewPlan.members.map((member, index) => <tr key={`${member.memberKey}-${index}`}><td className="manual-member-ref">{manualMemberReference(member.memberKey)}</td><td><Badge tone={member.decision === 'review' ? 'warning' : 'neutral'}>{Object.hasOwn(previewDecisionLabels, member.decision) ? previewDecisionLabels[member.decision] : '확인 필요'}</Badge></td><td>{manualPreviewReason(member.reason)}<small className="manual-target-status">목표 상태: {manualTargetLabel(member)}</small></td></tr>)}{!latest.previewPlan.members.length && <tr><td colSpan={3}>비교 대상 회원이 없습니다.</td></tr>}</tbody></table></div></div>}
      </div> : <div className="manual-empty">{snapshot ? '아직 수동 동기화 요청이 없습니다. 연결 확인부터 시작하세요.' : loadError ? '연결·기록 새로고침으로 다시 확인해 주세요.' : '저장된 연결 상태와 요청 기록을 확인하고 있습니다.'}</div>}
      {snapshot && snapshot.runs.length > 0 && <details className="manual-history"><summary>최근 요청 기록 ({snapshot.runs.length}건)</summary><div className="table-wrap"><table><caption className="sr-only">합성 데모와 분리된 수동 dry-run 요청 기록</caption><thead><tr><th scope="col">요청 시각</th><th scope="col">상태</th><th scope="col">추가 예정</th><th scope="col">건너뜀</th><th scope="col">실패</th><th scope="col">실제 반영</th><th scope="col">원인 안내</th></tr></thead><tbody>{snapshot.runs.map((run) => <tr key={run.id}><td>{formatDate(run.createdAt, timezone, true)}</td><td><Badge tone={manualTone(run.status)}>{manualStatusLabels[run.status] || '상태 확인 필요'}</Badge></td><td>{manualCount(run.status === 'needs_connection' ? null : run.counts.plannedAdds)}</td><td>{manualCount(run.status === 'needs_connection' ? null : run.counts.skipped)}</td><td>{manualCount(run.status === 'needs_connection' ? null : run.counts.failed)}</td><td>{manualCount(run.status === 'needs_connection' ? null : run.counts.added)}</td><td className="error-cell">{manualErrorMessage(run.errorCode) || '—'}</td></tr>)}</tbody></table></div></details>}
      <WithdrawalPreview plan={blocked ? null : latest?.previewPlan} />
      <div className="manual-sync-footer"><span>서버에서 선택한 트레이너만 조회 · 읽기 전용</span><button className="button secondary" type="button" onClick={onRefresh} disabled={busy}>연결·기록 새로고침</button></div>
    </section>
  );
}

function ManualSyncPanel({ timezone }: { timezone: string }) {
  const [snapshot, setSnapshot] = useState<ManualSyncSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const refreshInFlight = useRef(false);
  const submitInFlight = useRef(false);
  const refreshController = useRef<AbortController | null>(null);
  const mutationRevision = useRef(0);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    const controller = new AbortController();
    refreshController.current = controller;
    const revision = mutationRevision.current;
    try {
      const response = await fetch('/api/manual-sync', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('manual_sync_read_failed');
      const next = await response.json() as ManualSyncSnapshot;
      if (next.mode !== 'dry_run' || next.automaticSyncEnabled !== false || next.previewOnly !== true || next.externalWritesEnabled !== false || typeof next.connected !== 'boolean' || !Array.isArray(next.requiredConnections) || !Array.isArray(next.runs)) throw new Error('manual_sync_read_invalid');
      if (mounted.current && revision === mutationRevision.current) { setSnapshot(next); setLoadError(false); }
    } catch {
      if (mounted.current && !controller.signal.aborted) setLoadError(true);
    } finally {
      if (refreshController.current === controller) refreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; refreshController.current?.abort(); refreshInFlight.current = false; };
  }, [refresh]);

  const active = snapshot?.runs.some((run) => ['queued', 'running', 'retry'].includes(run.status));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void refresh(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  async function preview() {
    if (submitInFlight.current || !snapshot) return;
    submitInFlight.current = true;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/manual-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'preview' }) });
      if (!response.ok) throw new Error('manual_sync_request_failed');
      const result = await response.json() as { run: ManualSyncRun; externalWritesEnabled: false };
      if (!result.run || result.externalWritesEnabled !== false) throw new Error('manual_sync_response_invalid');
      if (mounted.current) {
        mutationRevision.current += 1;
        setSnapshot((current) => current && ({ ...current, runs: [result.run, ...current.runs.filter((run) => run.id !== result.run.id)].slice(0, 20) }));
        setNotice(result.run.status === 'needs_connection' ? '연결 필요 상태를 기록했습니다. 실제 동기화는 실행되지 않았습니다.' : '읽기 전용 미리보기 요청을 접수했습니다. 실제 반영은 비활성화되어 있습니다.');
      }
      await refresh();
    } catch {
      if (mounted.current) setNotice('요청 결과를 확인하지 못했습니다. 연결·기록 새로고침으로 저장 여부를 확인해 주세요.');
    } finally {
      submitInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <ManualSyncView snapshot={snapshot} busy={busy} loadError={loadError} notice={notice} timezone={timezone} onPreview={() => { void preview(); }} onRefresh={() => { void refresh(); }} />;
}

export function Dashboard({ initialData }: { initialData: DashboardSnapshot }) {
  const [data, setData] = useState(initialData);
  const [settings, setSettings] = useState<Settings>(initialData.settings);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [refreshError, setRefreshError] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const mounted = useRef(false);
  const refreshInFlight = useRef(false);
  const timezone = data.settings.timezone;

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const response = await fetch('/api/dashboard', { cache: 'no-store' });
      if (!response.ok) throw new Error('refresh_failed');
      const next = await response.json() as DashboardSnapshot;
      if (mounted.current) {
        setData(next);
        setRefreshError(false);
        setLastRefresh(new Date().toISOString());
      }
    } catch {
      if (mounted.current) setRefreshError(true);
    } finally {
      refreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [refresh]);

  async function send(path: string, body: unknown, operation: string) {
    if (busy) return;
    setBusy(operation);
    setNotice('');
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error || '요청을 실행하지 못했습니다.');
      setNotice(result.message || '작업을 요청했습니다.');
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error && error.message !== 'Failed to fetch' ? error.message : '연결을 확인한 뒤 다시 시도해 주세요.');
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send('/api/settings', settings, 'settings');
  }

  const memberNames = new Map(data.members.map((member) => [member.companyMemberId, member.name]));
  const visibleSchedules = [...data.schedules].sort((a, b) => a.start.localeCompare(b.start)).slice(0, 24);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="Trainer Sync 대시보드"><span className="brand-mark">t.</span><span>trainer<span className="brand-light">sync</span><small>LOCAL WORKSPACE</small></span></a>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="대시보드 구역"><a href="#overview"><span>◫</span>운영 개요</a><a href="#manual-sync"><span>↗</span>회사 → 노션 동기화</a><a href="#members"><span>◉</span>합성 회원 데모</a><a href="#schedules"><span>▦</span>합성 수업 · 통화 일정</a><a href="#activity"><span>↻</span>합성 작업 기록</a><a href="#settings"><span>⚙</span>합성 실행 설정</a></nav>
        <div className="sidebar-bottom"><span className="avatar">T</span><div><strong>{data.trainer.name}</strong><small>합성 테스트 사용자</small></div></div>
      </aside>

      <main className="main-content" id="overview">
        <header className="topbar"><span>내 작업 공간 <span className="breadcrumb">/</span> 운영 개요</span><span className="local-indicator"><i />로컬 테스트</span></header>
        <div className="page-content">
          <div className="page-heading"><div><span className="eyebrow">TRAINER OPERATIONS</span><h1>회원 관리의 흐름을 한눈에.</h1><p>회원 확인부터 수업 일정까지, 서버에서 이어지는 작업을 확인하세요.</p></div><button className="button secondary" type="button" onClick={() => { void refresh(); }}>↻ 새로고침</button></div>

          <ManualSyncPanel timezone={timezone} />
          <ProfileSaveOncePanel /><ContactSaveOncePanel /><StorageTestPanel />

          <div className="mock-banner" role="note"><span className="banner-symbol">◇</span><div><strong>아래는 합성 데이터 전용 데모입니다</strong><p>아래 회원·일정·작업 기록은 수동 동기화 결과와 별개입니다. 합성 작업의 완료는 실제 회사·노션 동기화 성공을 의미하지 않습니다.</p></div><Badge tone="warning">MOCK ONLY</Badge></div>

          <div className="feedback" role="status" aria-live="polite">{notice || (refreshError ? '자동 새로고침을 하지 못했습니다. 표시된 결과는 마지막으로 확인한 데이터입니다.' : '')}</div>

          <div className="stats-grid">
            <article className="stat"><span>합성 관리 회원</span><strong>{data.stats.members}<small>명</small></strong><p>현재 사용자에게 연결된 합성 회원</p></article>
            <article className="stat"><span>합성 활성 일정</span><strong>{data.stats.activeSchedules}<small>회</small></strong><p>통화와 주간 트레이닝 회차</p></article>
            <article className={`stat ${data.stats.needsReview ? 'stat-review' : ''}`}><span>합성 확인 필요</span><strong>{data.stats.needsReview}<small>건</small></strong><p>날짜 · 상태 · 모호한 메모 확인</p></article>
            <article className="stat stat-time"><span>마지막 합성 작업 성공</span><strong>{formatDate(data.stats.lastSuccess, timezone)}</strong><p>화면 {lastRefresh ? `${formatDate(lastRefresh, timezone)} 갱신` : '10초마다 자동 갱신'}</p></article>
          </div>

          <section className="section" aria-labelledby="connection-heading">
            <div className="inline-heading"><h2 id="connection-heading">합성 데모 연결 안내</h2><span>사용자별 연결 분리 · 비밀 정보 저장 없음</span></div>
            <div className="connections">
              {data.connections.map((connection) => <article className="connection card" key={connection.type}><span className="connection-icon">{connection.type.toLowerCase().includes('notion') ? 'N' : 'C'}</span><div><h3>{connection.type.toLowerCase().includes('notion') ? 'Notion' : '회사 회원 사이트'}</h3><p>{connection.detail}</p><span className="connection-state">실제 어댑터 미완성 · 연결 승인 필요</span></div><Badge tone="warning">외부 연결 꺼짐</Badge></article>)}
            </div>
          </section>

          <section className="section" id="members">
            <SectionTitle number="01" title="합성 회원 데모" detail="합성 데이터로 신규 배정과 기존 회원 누락 처리 흐름을 확인합니다."><button type="button" className="button secondary" disabled={busy !== null} onClick={() => { void send('/api/jobs', { kind: 'company_sync' }, 'company_sync'); }}>{busy === 'company_sync' ? '합성 작업 요청 중…' : '합성 회원 확인 실행'}<span aria-hidden="true">↗</span></button></SectionTitle>
            <div className="card table-wrap"><table><caption className="sr-only">현재 트레이너의 합성 회원과 동기화 상태</caption><thead><tr><th scope="col">회원</th><th scope="col">상태</th><th scope="col">고정 시간</th><th scope="col">첫 트레이닝</th><th scope="col">배정 확인</th><th scope="col">기록</th></tr></thead><tbody>
              {data.members.map((member) => <tr key={member.companyMemberId}><td><strong className="member-name">{member.name}</strong><small className="mono">{member.companyMemberId}</small></td><td><Badge tone={badgeTone(member.status)}>{member.status}</Badge></td><td>{member.fixedSlot ? `${weekdays[member.fixedSlot.weekday]}요일 ${String(member.fixedSlot.hour).padStart(2, '0')}:${String(member.fixedSlot.minute).padStart(2, '0')}` : <span className="muted">확인 필요</span>}</td><td>{member.firstTrainingDate || <span className="muted">미입력</span>}</td><td><span>{member.assignmentEvidence === 'new' ? '신규 배정 확인' : member.assignmentEvidence === 'existing' ? '기존 회원' : '배정 근거 확인'}</span><small>배정일 {member.assignmentDate || '미확인'}</small><small>등록일 {member.registrationDate || '미확인'}</small></td><td><details className="member-detail"><summary>메모 · 설문</summary><div><strong>원본 메모</strong><p className="verbatim">{member.memo || '없음'}</p><strong>specialVideos 합성 설문 원문</strong>{member.survey.length ? member.survey.map((entry, index) => <div className="survey" key={`${member.companyMemberId}-${index}`}><p className="verbatim">{entry.question}</p><p className="verbatim">{entry.answer}</p></div>) : <p>제출된 합성 설문 없음</p>}<strong>수동 작성 내용 · 보존</strong><p className="verbatim">{member.manualContent || '없음'}</p></div></details></td></tr>)}
              {!data.members.length && <tr><td colSpan={6}><div className="empty-state">아직 동기화된 합성 회원이 없습니다. 회원 확인 작업을 실행해 주세요.</div></td></tr>}
            </tbody></table><div className="table-footer">등록일과 배정일은 별도로 관리합니다. 기존 회원의 상태를 일괄 초기화하지 않습니다.</div></div>
          </section>

          <section className="section review-section" aria-labelledby="review-heading"><div className="inline-heading"><h2 id="review-heading">합성 데이터 확인 필요 항목</h2><span>추측해서 일정을 만들지 않습니다</span></div><div className="card review-list">{data.issues.length ? data.issues.slice(0, 16).map((issue, index) => <article className="review-item" key={issue.id || `${issue.code}-${issue.companyMemberId}-${index}`}><span className="review-dot">!</span><div><strong>{issue.companyMemberId ? memberNames.get(issue.companyMemberId) || issue.companyMemberId : '동기화 확인'}</strong><p>{issue.message}</p></div><code>{issue.code}</code></article>) : <div className="empty-state compact"><span className="check-circle">✓</span>현재 확인이 필요한 항목이 없습니다.</div>}</div></section>

          <section className="section" id="schedules"><SectionTitle number="02" title="합성 수업 · 통화 일정" detail={`저장된 시간대 ${timezone} · 향후 ${data.settings.horizonMonths}개월 회차 유지`}><button className="button secondary" type="button" disabled={busy !== null} onClick={() => { void send('/api/jobs', { kind: 'notion_poll' }, 'notion_poll'); }}>{busy === 'notion_poll' ? '요청 중…' : '합성 Notion 변경 확인'}</button></SectionTitle><div className="card table-wrap"><table><caption className="sr-only">합성 Notion 일정 데이터베이스의 통화와 수업 회차</caption><thead><tr><th scope="col">회원 · 종류</th><th scope="col">시작</th><th scope="col">종료</th><th scope="col">회차 상태</th><th scope="col">예외</th></tr></thead><tbody>{visibleSchedules.map((event) => <tr key={event.key}><td><strong>{memberNames.get(event.companyMemberId) || event.companyMemberId}</strong><small>{kindLabels[event.kind] || event.kind}</small></td><td>{formatDate(event.start, timezone, true)}</td><td>{formatDate(event.end, timezone, true)}</td><td><Badge tone={event.status === 'active' ? 'good' : 'neutral'}>{event.status === 'active' ? '예정 / 기록' : '취소'}</Badge></td><td>{event.manualOverride ? <Badge tone="blue">수동 변경 보존</Badge> : <span className="muted">자동 관리</span>}</td></tr>)}{!visibleSchedules.length && <tr><td colSpan={5}><div className="empty-state">아직 생성된 회차가 없습니다. 필수 날짜가 없는 회원의 일정은 생성하지 않습니다.</div></td></tr>}</tbody></table><div className="table-footer">{data.schedules.length > visibleSchedules.length ? `전체 ${data.schedules.length}개 중 시간순 ${visibleSchedules.length}개 표시 · ` : ''}과거 기록과 Calendar 수동 변경 예외를 보존합니다. Google Calendar는 사용하지 않습니다.</div></div></section>

          <section className="section" id="activity"><SectionTitle number="03" title="합성 작업 기록" detail="합성 작업만 처리하는 worker의 저장된 실행 기록입니다." /><div className="card table-wrap"><table><caption className="sr-only">현재 트레이너의 최근 동기화 작업 결과</caption><thead><tr><th scope="col">작업</th><th scope="col">상태</th><th scope="col">요청 시각</th><th scope="col">완료 시각</th><th scope="col">시도</th><th scope="col">오류</th></tr></thead><tbody>{data.jobs.slice(0, 15).map((job) => <tr key={job.id}><td><strong>{kindLabels[job.kind] || job.kind}</strong><small className="mono">{job.id.slice(0, 8)}</small></td><td><Badge tone={badgeTone(job.status)}>{jobLabels[job.status] || job.status}</Badge></td><td>{formatDate(job.createdAt, timezone)}</td><td>{formatDate(job.finishedAt, timezone)}</td><td>{job.attempts}회</td><td className="error-cell">{job.error || <span className="muted">—</span>}</td></tr>)}{!data.jobs.length && <tr><td colSpan={6}><div className="empty-state">실행 기록이 없습니다. 수동 실행으로 합성 데이터 흐름을 확인할 수 있습니다.</div></td></tr>}</tbody></table></div></section>

          <section className="section" id="settings"><SectionTitle number="04" title="합성 실행 설정" detail="실제 운영 시간은 미정입니다. 아래 설정은 합성 어댑터에만 적용됩니다." /><form onSubmit={save} className="card settings-card"><div className="setting-fields"><label>회사 회원 확인 시각 <span>하루 한 번 · 미정이면 비워두세요</span><input type="time" value={settings.dailyTime || ''} onChange={(event) => setSettings((current) => ({ ...current, dailyTime: event.target.value || null }))} /></label><label>기준 시간대 <span>회원 일정과 실행 시각의 기준</span><select value={settings.timezone} onChange={(event) => setSettings((current) => ({ ...current, timezone: event.target.value }))}><option value="Asia/Seoul">Asia/Seoul</option><option value="Etc/UTC">Etc/UTC</option><option value="America/New_York">America/New_York</option><option value="Europe/London">Europe/London</option></select></label><label>Notion 변경 확인 간격 <span>기본 5분 · 합성 데이터만 확인</span><select value={settings.notionPollMinutes} onChange={(event) => setSettings((current) => ({ ...current, notionPollMinutes: Number(event.target.value) }))}>{[5, 10, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes}분</option>)}</select></label><label>미래 회차 유지 범위 <span>지나간 기록은 계속 보존</span><select value={settings.horizonMonths} onChange={(event) => setSettings((current) => ({ ...current, horizonMonths: Number(event.target.value) }))}>{[1, 3, 6, 12].map((months) => <option key={months} value={months}>{months}개월</option>)}</select></label></div><div className="settings-bottom"><label className="checkbox-label"><input type="checkbox" checked={settings.mockScheduleEnabled} onChange={(event) => setSettings((current) => ({ ...current, mockScheduleEnabled: event.target.checked }))} /><span><strong>합성 회사 회원 확인 예약 실행</strong><small>기본 꺼짐 · 실제 외부 호출은 활성화되지 않습니다.</small></span></label><button className="button primary" type="submit" disabled={busy !== null}>{busy === 'settings' ? '저장 중…' : '테스트 설정 저장'}</button></div></form></section>

          <footer className="page-footer"><span>Trainer Sync · 개발용 로컬 환경</span><span>실제 로그인 · API 키 · 외부 배포 미설정</span></footer>
        </div>
      </main>
    </div>
  );
}
