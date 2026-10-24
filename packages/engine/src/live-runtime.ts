import{parseNotionDestination,parseContactApproval,parseIsolatedTestFixture}from'./runtime-scopes.ts';
import type{ContactApprovalScope,IsolatedTestFixture}from'./runtime-scopes.ts';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { query } from '@trainer/db';
import { BrowserCompanyReadSession } from './live-company-browser.ts';
import { assertCompanyProfile, CompanyDomError, parseCompanyListSnapshot } from './live-company-dom.ts';
import { LiveCompanyAdapter } from './live-company.ts';
import {CountedCompanyPreviewAdapter} from './live-company-counted-preview.ts';
import type {CountedCompanyPreviewConfig} from './live-company-counted-preview.ts';
import type {CompanyAdapter} from './ports.ts';
import type {CompanyCurrentAccount} from './company-current-account.ts';
import type {CompanyWithdrawalRequestInventory} from './withdrawal-plan.ts';
import type { CompanyBrowserPage, CompanyTrainerBinding, VerifiedDomProfile } from './live-company-types.ts';
import { OfficialNotionAdapter } from './live-notion.ts';
import { OfficialNotionClient, NotionHttpError, NotionReviewRequiredError, officialNotionFetchTransport } from './live-notion-client.ts';
import type { NotionMemberBinding } from './live-notion-types.ts';
import { runManualSyncOnce } from './manual-sync.ts';
import type { ManualSyncCapability, ManualSyncReadiness, ManualSyncWorkerOptions } from './manual-sync.ts';
import { verifyWithdrawalStatusMapping } from './withdrawal-plan.ts';
import type { VerifiedWithdrawalStatusMapping } from './withdrawal-plan.ts';

export const NOTION_READ_REVIEW_CODES = [
  'NOTION_SCHEMA_BINDING_MISSING', 'NOTION_SCHEMA_BINDING_INVALID', 'NOTION_SELECT_OPTION_UNVERIFIED',
  'NOTION_PROPERTY_MISSING_OR_CHANGED', 'NOTION_ADMIN_URL_REQUIRED', 'NOTION_ADMIN_URL_INVALID', 'NOTION_ADMIN_URL_SCOPE_MISMATCH',
  'NOTION_COMPANY_MEMBER_ID_INVALID', 'NOTION_DUPLICATE_MEMBER_ID', 'NOTION_MEMBER_PARENT_MISMATCH',
  'NOTION_PAGE_ARCHIVED', 'NOTION_RESPONSE_INVALID', 'NOTION_INVENTORY_CHANGED_RETRY', 'NOTION_QUERY_INCOMPLETE',
] as const;
export type NotionReadReviewCode = typeof NOTION_READ_REVIEW_CODES[number] | 'NOTION_HTTP_READ_FAILED' | 'NOTION_READ_REVIEW_REQUIRED';
/** Exact class/code allowlist only. Provider messages and unknown codes never leave the worker. */
export function notionReadReviewCode(error: unknown): NotionReadReviewCode {
  if (error instanceof NotionReviewRequiredError && (NOTION_READ_REVIEW_CODES as readonly string[]).includes(error.code)) return error.code as NotionReadReviewCode;
  return error instanceof NotionHttpError ? 'NOTION_HTTP_READ_FAILED' : 'NOTION_READ_REVIEW_REQUIRED';
}

export const LIVE_MANUAL_TRAINER_ID = 'trainer-live-one';
const companyOrigin = 'https://admin.biz-pt.com';
export type CompanyConnectionStatus = 'needs_login' | 'needs_verification' | 'ready' | 'error';
export type NotionConnectionStatus = 'needs_token' | 'needs_verification' | 'ready' | 'error';
export type CompanyReviewCode='COMPANY_ACCOUNT_BINDING_UNVERIFIED'|'COMPANY_ACCOUNT_MISMATCH'|'COMPANY_COVERAGE_UNVERIFIED'|'COMPANY_AUTH_REQUIRED'|'COMPANY_READ_FAILED';
const companyCodes=new Set<string>(['COMPANY_ACCOUNT_BINDING_UNVERIFIED','COMPANY_ACCOUNT_MISMATCH','COMPANY_COVERAGE_UNVERIFIED','COMPANY_AUTH_REQUIRED','COMPANY_READ_FAILED']);
export interface LiveReadOnlyState {
  companyReviewCode?:CompanyReviewCode;
  companyStatus: CompanyConnectionStatus;
  notionStatus: NotionConnectionStatus;
  previewKeyReady: boolean;
}
export interface LiveReadOnlyPublicState {
  mode: 'dry_run'; connected: boolean; requiredConnections: ManualSyncCapability[];
  companyReviewCode:CompanyReviewCode|null;
  automaticSyncEnabled: false; previewOnly: true; externalWritesEnabled: false;
  companyStatus: CompanyConnectionStatus | 'worker_offline';
  notionStatus: NotionConnectionStatus | 'worker_offline';
  readiness: ManualSyncReadiness;
}
/** No token/profile inspection in web. Only a live worker's short-lived metadata can permit queuing. */
export function publicLiveReadOnlyState(state?: LiveReadOnlyState, heartbeatAt?: Date, now = Date.now()): LiveReadOnlyPublicState {
  const fresh = heartbeatAt !== undefined && Number.isFinite(heartbeatAt.getTime()) && now - heartbeatAt.getTime() >= 0 && now - heartbeatAt.getTime() < 30000;
  const readiness = {
    companyRead: fresh && state?.companyStatus === 'ready' && state.previewKeyReady === true,
    notionInventoryRead: fresh && state?.notionStatus === 'ready' && state.previewKeyReady === true,
  };
  return { mode: 'dry_run', connected: readiness.companyRead && readiness.notionInventoryRead,
    requiredConnections: [...(!readiness.companyRead ? ['company_read_session' as const] : []), ...(!readiness.notionInventoryRead ? ['notion_read_integration' as const] : [])],
    automaticSyncEnabled: false, previewOnly: true, externalWritesEnabled: false,
    companyReviewCode:fresh&&state?.companyReviewCode&&companyCodes.has(state.companyReviewCode)?state.companyReviewCode:null,
    companyStatus: fresh && state ? state.companyStatus : 'worker_offline', notionStatus: fresh && state ? state.notionStatus : 'worker_offline', readiness };
}
export async function getLiveReadOnlyState(trainerId: string): Promise<LiveReadOnlyPublicState> {
  const row = (await query<{ company_status: CompanyConnectionStatus; notion_status: NotionConnectionStatus; preview_key_ready: boolean; heartbeat_at: Date; company_review_code:CompanyReviewCode|null }>(
    'SELECT company_status,notion_status,preview_key_ready,heartbeat_at,company_review_code FROM live_readonly_state WHERE trainer_id=$1', [trainerId])).rows[0];
  return row ? publicLiveReadOnlyState({ companyStatus: row.company_status, notionStatus: row.notion_status, previewKeyReady: row.preview_key_ready,companyReviewCode:row.company_review_code??undefined }, row.heartbeat_at) : publicLiveReadOnlyState();
}
export async function publishLiveReadOnlyState(trainerId: string, state: LiveReadOnlyState): Promise<void> {
  if (trainerId !== LIVE_MANUAL_TRAINER_ID) throw new Error('LIVE_TRAINER_BINDING_INVALID');
  await query('INSERT INTO trainers(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [trainerId, 'Connected local trainer']);
  await query(`INSERT INTO live_readonly_state(trainer_id,company_status,notion_status,preview_key_ready,company_review_code) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(trainer_id) DO UPDATE SET company_status=EXCLUDED.company_status,notion_status=EXCLUDED.notion_status,
    preview_key_ready=EXCLUDED.preview_key_ready,company_review_code=EXCLUDED.company_review_code,heartbeat_at=now()`, [trainerId, state.companyStatus, state.notionStatus, state.previewKeyReady, state.companyReviewCode&&companyCodes.has(state.companyReviewCode)?state.companyReviewCode:null]);
}
function exactId(value: unknown, expected: string): boolean { return typeof value === 'string' && value.replaceAll('-', '').toLowerCase() === expected.replaceAll('-', '').toLowerCase(); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LIVE_CONFIG_INVALID');
  return value as Record<string, unknown>;
}
export interface LiveReadOnlyConfig {
  version: 1;
  contactSaveApproval?:ContactApprovalScope;
  isolatedTestFixture?:IsolatedTestFixture;
  trainerId: typeof LIVE_MANUAL_TRAINER_ID;
  company?: { profile: VerifiedDomProfile; binding: CompanyTrainerBinding };
  companyPreview?: CountedCompanyPreviewConfig;
  notion?: { members: NotionMemberBinding };
}
/** Only the approved company origin and exact member master are accepted. No token is configuration. */
export function parseLiveReadOnlyConfig(input: unknown): LiveReadOnlyConfig {
  const raw = record(input);
  if (raw.version !== 1 || raw.trainerId !== LIVE_MANUAL_TRAINER_ID || Object.keys(raw).some(key => !['version', 'trainerId', 'company', 'companyPreview', 'notion', 'contactSaveApproval', 'isolatedTestFixture'].includes(key))) throw new Error('LIVE_CONFIG_INVALID');
  // All credentials enter through dedicated secret files; reject accidental pasted secrets anywhere.
  const forbidSecrets = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) forbidSecrets(item); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { if (/token|password|cookie|authorization|storageState/i.test(key)) throw new Error('LIVE_CONFIG_SECRET_FORBIDDEN'); forbidSecrets(child); }
  };
  forbidSecrets(raw);
  const result: LiveReadOnlyConfig = { version: 1, trainerId: LIVE_MANUAL_TRAINER_ID };
  if(raw.contactSaveApproval!==undefined)result.contactSaveApproval=parseContactApproval(raw.contactSaveApproval);
  if(raw.isolatedTestFixture!==undefined)result.isolatedTestFixture=parseIsolatedTestFixture(raw.isolatedTestFixture);
  if (raw.companyPreview !== undefined) {
    if (raw.company !== undefined) throw new Error('LIVE_COMPANY_TARGET_INVALID');
    const preview=structuredClone(record(raw.companyPreview)) as unknown as CountedCompanyPreviewConfig;
    if(preview.mode!=='counted-ui'||preview.scopeApproved!==true||!preview.evidence?.reference||!Number.isFinite(Date.parse(preview.evidence.verifiedAt)))throw new Error('LIVE_COMPANY_TARGET_INVALID');
    result.companyPreview=preview;
  }
  if (raw.company !== undefined) {
    const company = record(raw.company), profileRaw = record(company.profile);
    const profile = structuredClone(profileRaw) as unknown as VerifiedDomProfile;
    if (profile.origin !== companyOrigin || profile.listUrl !== `${companyOrigin}/manage/members`) throw new Error('LIVE_COMPANY_TARGET_INVALID');
    if (profile.coverage) {
      const parameter = company.paginationQueryParameter;
      if (typeof parameter !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(parameter)) throw new Error('LIVE_PAGINATION_BINDING_REQUIRED');
      (profile.coverage.pagination as { nextUrl: (cursor: string) => string }).nextUrl = cursor => {
        const url = new URL(profile.listUrl); url.searchParams.set(parameter, cursor); return url.href;
      };
    }
    if (profile.survey) (profile.survey as { url: (id: string) => string }).url = id => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('LIVE_MEMBER_ID_INVALID');
      return `${companyOrigin}/manage/members/${id}?tab=specialVideos`;
    };
    assertCompanyProfile(profile);
    const binding = structuredClone(record(company.binding)) as unknown as CompanyTrainerBinding;
    if (binding.trainerId !== LIVE_MANUAL_TRAINER_ID) throw new Error('LIVE_TRAINER_BINDING_INVALID');
    result.company = { profile, binding };
  }
  if (raw.notion !== undefined) {
    const members = structuredClone(record(record(raw.notion).members)) as unknown as NotionMemberBinding;
    parseNotionDestination(members);
    if (members.template !== undefined
      || members.allowedTrainerIds?.length !== 1 || members.allowedTrainerIds[0] !== LIVE_MANUAL_TRAINER_ID) throw new Error('LIVE_NOTION_TARGET_INVALID');
    if (members.identity?.mode === 'exclusive-data-source-admin-url' && (members.identity.adminOrigin !== companyOrigin || members.identity.trainerId !== LIVE_MANUAL_TRAINER_ID)) throw new Error('LIVE_NOTION_TARGET_INVALID');
    result.notion = { members };
  }
  return result;
}
export interface LiveReadOnlyRuntime {
  readonly trainerId: string;
  state: LiveReadOnlyState;
  preflight(): Promise<void>;
  tick(): Promise<boolean>;
}
export interface LiveRuntimeDependencies {
  onNotionReview?: (code: NotionReadReviewCode) => void;
  strictNotionInventory?:boolean;
  readCompanyAccount?:()=>Promise<CompanyCurrentAccount>;
  readText?: (path: string) => Promise<string>;
  openCompanyPage: (endpoint: string) => Promise<CompanyBrowserPage>;
  createNotionClient?: (token: string) => OfficialNotionClient;
  dispatch?: (options: ManualSyncWorkerOptions) => Promise<boolean>;
}
/** Optional worker-only bootstrap. Merely importing this module performs no file/network access. */
export async function createLiveReadOnlyRuntime(options: {
  enabled: boolean; configFile: string; notionTokenFile: string; previewKeyFile: string; companyEndpoint: string;
}, dependencies: LiveRuntimeDependencies): Promise<LiveReadOnlyRuntime | undefined> {
  if (options.enabled !== true) return undefined;
  if (options.companyEndpoint !== 'http://company-browser:9222') throw new Error('LIVE_CDP_ENDPOINT_INVALID');
  const readText = dependencies.readText ?? (path => readFile(path, 'utf8'));
  const config = parseLiveReadOnlyConfig(JSON.parse(await readText(options.configFile)));
  let company: CompanyAdapter | undefined, notion: OfficialNotionAdapter | undefined, previewHmacKey: string | undefined;
  let withdrawalStatusMapping: VerifiedWithdrawalStatusMapping | undefined;
  let withdrawalRequests:CompanyWithdrawalRequestInventory|undefined, verifyCompanyAccount:(()=>Promise<void>)|undefined;
  const runtime: LiveReadOnlyRuntime = {
    trainerId: config.trainerId,
    state: { companyStatus: config.company ? 'needs_login' : 'needs_verification', notionStatus: config.notion ? 'needs_token' : 'needs_verification', previewKeyReady: false },
    async preflight() {
      company = undefined; notion = undefined; previewHmacKey = undefined; runtime.state.companyReviewCode=undefined;
      withdrawalStatusMapping = undefined; withdrawalRequests=undefined;verifyCompanyAccount=undefined;
      try { const key = (await readText(options.previewKeyFile)).trim(); if (Buffer.byteLength(key) >= 32) previewHmacKey = key; } catch { /* public readiness only */ }
      runtime.state.previewKeyReady = previewHmacKey !== undefined;
      if(config.companyPreview){
        try{const page=await dependencies.openCompanyPage(options.companyEndpoint);const candidate=new CountedCompanyPreviewAdapter(page,config.companyPreview,config.trainerId,dependencies.readCompanyAccount);await candidate.preflight();const guarded=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work();}catch(error){runtime.state.companyStatus=error instanceof CompanyDomError&&error.code==='COMPANY_AUTH_REQUIRED'?'needs_login':'needs_verification';runtime.state.companyReviewCode=error instanceof CompanyDomError&&companyCodes.has(error.code)?error.code as CompanyReviewCode:'COMPANY_READ_FAILED';throw error;}};company={listMembers:input=>guarded(()=>candidate.listMembers(input))};withdrawalRequests={listWithdrawalRequests:input=>guarded(()=>candidate.listWithdrawalRequests(input))};verifyCompanyAccount=()=>guarded(()=>candidate.verifyAccount());runtime.state.companyStatus='ready';}
        catch(error){runtime.state.companyStatus=error instanceof CompanyDomError&&error.code==='COMPANY_AUTH_REQUIRED'?'needs_login':'needs_verification';runtime.state.companyReviewCode=error instanceof CompanyDomError&&companyCodes.has(error.code)?error.code as CompanyReviewCode:'COMPANY_READ_FAILED';}
      }
      if (config.company) {
        try {
          const page = await dependencies.openCompanyPage(options.companyEndpoint);
          const session = new BrowserCompanyReadSession(page, config.company.profile);
          const snapshotId = randomUUID();
          const snapshot = await session.readList({ cursor: null, snapshotId, trainer: config.company.binding });
          parseCompanyListSnapshot(config.company.profile, config.company.binding, snapshot, { cursor: null, snapshotId });
          company = new LiveCompanyAdapter({ session, ...config.company }); runtime.state.companyStatus = 'ready';
        } catch (error) { runtime.state.companyStatus = error instanceof CompanyDomError && error.code === 'COMPANY_AUTH_REQUIRED' ? 'needs_login' : 'needs_verification'; }
      }
      if (config.notion) {
        let token: string | undefined;
        try { token = (await readText(options.notionTokenFile)).trim(); } catch { /* not configured */ }
        if (!token) runtime.state.notionStatus = 'needs_token';
        else {
          try {
            const client = dependencies.createNotionClient?.(token) ?? new OfficialNotionClient({ token, transport: officialNotionFetchTransport, readPermit: { approved: true } });
            // No write permit or calendar/template binding exists in this runtime.
            const candidate = new OfficialNotionAdapter({ client, members: config.notion.members });
            if(dependencies.strictNotionInventory)await candidate.listIdentities({trainerId:config.trainerId,cursor:null,scope:'all_members'});
            else await candidate.listPreviewIdentitiesPartial({ trainerId: config.trainerId, scope: 'all_members' });
            const targetOption = config.notion.members.createStatus['탈퇴 요청'];
            if (targetOption !== undefined) {
              const schema = await client.read(`/data_sources/${config.notion.members.dataSourceId}`);
              const properties = record(schema.properties);
              const statusProperty = Object.values(properties).map(record).find(property => property.id === config.notion!.members.status.id && property.type === config.notion!.members.status.type);
              const choiceData = statusProperty ? record(statusProperty[config.notion.members.status.type]) : {};
              const actualOptions = Array.isArray(choiceData.options) ? choiceData.options.map(record).filter((option): option is Record<string, unknown> & {id: string; name: string} => typeof option.name === 'string' && typeof option.id === 'string').map(option => ({ id: option.id, name: option.name })) : [];
              withdrawalStatusMapping = verifyWithdrawalStatusMapping({ optionName: targetOption, dataSourceId: config.notion.members.dataSourceId,
                propertyId: config.notion.members.status.id, actualOptions });
            }
            notion = candidate; runtime.state.notionStatus = 'ready';
          } catch (error) { runtime.state.notionStatus = error instanceof NotionHttpError && [401, 403].includes(error.status) ? 'needs_token' : 'needs_verification'; dependencies.onNotionReview?.(notionReadReviewCode(error)); }
        }
      }
    },
    async tick() {
      const readiness = { companyRead: runtime.state.companyStatus === 'ready' && !!company && !!previewHmacKey,
        notionInventoryRead: runtime.state.notionStatus === 'ready' && !!notion && !!previewHmacKey };
      // No broad queue claim: this dedicated runtime can never read another trainer's job.
      return (dependencies.dispatch ?? runManualSyncOnce)({ trainerId: config.trainerId, readiness, company, notion, previewHmacKey, withdrawalStatusMapping, withdrawalRequests, verifyCompanyAccount });
    },
  };
  return runtime;
}
