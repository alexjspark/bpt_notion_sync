import{auditEvent}from'./audit-log.ts';
import { RetryableError } from './ports.ts';

/** Official REST contracts checked 2026-10-22 against developers.notion.com. */
export const NOTION_API_VERSION = '2026-03-11';
export const NOTION_API_ORIGIN = 'https://api.notion.com';

export interface NotionRequest {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}
export interface NotionResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}
/** The application supplies this transport. This module never opens a connection on import. */
export type NotionTransport = (request: NotionRequest) => Promise<NotionResponse>;
export interface NotionReadPermit { readonly approved: true }
export interface NotionWritePermit { readonly approved: true }
export class NotionAccessDeniedError extends Error {
  constructor(capability: 'read' | 'write') { super(`NOTION_${capability.toUpperCase()}_NOT_APPROVED`); this.name = 'NotionAccessDeniedError'; }
}
export class NotionReviewRequiredError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'NotionReviewRequiredError'; }
}
export class NotionWriteUncertainError extends Error {
  constructor() { super('NOTION_WRITE_OUTCOME_UNCERTAIN: reconcile the remote object before retrying'); this.name = 'NotionWriteUncertainError'; }
}
export class NotionHttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(`NOTION_HTTP_${status}:${code}`); this.name = 'NotionHttpError'; }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NotionReviewRequiredError('NOTION_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new NotionReviewRequiredError('NOTION_RESPONSE_INVALID');
  return value;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new NotionReviewRequiredError('NOTION_RESPONSE_INVALID');
  return value;
}
export function resourceId(value: string): string {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new NotionReviewRequiredError('NOTION_RESOURCE_ID_INVALID');
  return encodeURIComponent(value);
}
/** Returned property IDs are already URL encoded. Preserve them without double encoding. */
export function propertyPathId(value: string): string {
  if (!value || !/^(?:[A-Za-z0-9_.~!-]|%[a-fA-F0-9]{2})+$/.test(value)) throw new NotionReviewRequiredError('NOTION_PROPERTY_ID_INVALID');
  return value;
}

const READ_PATH = /^\/(?:data_sources\/[A-Za-z0-9_-]+(?:\/templates)?|databases\/[A-Za-z0-9_-]+|pages\/[A-Za-z0-9_-]+(?:\/properties\/(?:[A-Za-z0-9_.~!-]|%[a-fA-F0-9]{2})+)?|blocks\/[A-Za-z0-9_-]+(?:\/children)?)$/;
const WRITE_PATH = /^\/(?:pages(?:\/[A-Za-z0-9_-]+)?|blocks\/[A-Za-z0-9_-]+(?:\/children)?)$/;

/**
 * Credentials are constructor-only opaque values. Never reads env, logs requests, or follows redirects.
 * Query is a read despite its POST method. Every other POST/PATCH requires a separate write permit.
 * https://developers.notion.com/reference/request-limits
 */
export class OfficialNotionClient {
  private readonly token: string;
  private readonly transport: NotionTransport;
  private readonly readApproved: boolean;
  private readonly writeApproved: boolean;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly isolatedTestScope?:()=>{dataSourceId:string;pageId:string|null;testId:string};
  constructor(options: {
    token: string;
    transport: NotionTransport;
    readPermit?: NotionReadPermit;
    writePermit?: NotionWritePermit;
    sleep?: (milliseconds: number) => Promise<void>;
    maxRateLimitRetries?: number;
    isolatedTestScope?:()=>{dataSourceId:string;pageId:string|null;testId:string};
  }) {
    if (!options.token || /[\r\n]/.test(options.token)) throw new NotionReviewRequiredError('NOTION_TOKEN_REQUIRED');
    this.token = options.token;
    this.transport = options.transport;
    this.readApproved = options.readPermit?.approved === true;
    this.writeApproved = options.writePermit?.approved === true;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.maxRetries = options.maxRateLimitRetries ?? 2;
    this.isolatedTestScope=options.isolatedTestScope;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 5) throw new NotionReviewRequiredError('NOTION_RETRY_LIMIT_INVALID');
  }
  assertWriteApproved(): void {
    if (!this.readApproved) throw new NotionAccessDeniedError('read');
    if (!this.writeApproved) throw new NotionAccessDeniedError('write');
  }
  async read(path: string, query?: Readonly<Record<string, string>>, queryBody?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.readApproved) throw new NotionAccessDeniedError('read');
    const isQuery = /^\/data_sources\/[A-Za-z0-9_-]+\/query$/.test(path);
    if (!(isQuery || READ_PATH.test(path)) || (queryBody && !isQuery)) throw new NotionReviewRequiredError('NOTION_READ_ENDPOINT_INVALID');
    return this.request(isQuery ? 'POST' : 'GET', path, query, queryBody, false);
  }
  async write(method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertWriteApproved();
    if (!WRITE_PATH.test(path) || (method === 'POST' && path !== '/pages') || (method === 'PATCH' && path === '/pages')) throw new NotionReviewRequiredError('NOTION_WRITE_ENDPOINT_INVALID');
    // Whole-page replacement and trash/delete are deliberately absent from this adapter.
    if ('erase_content' in body || 'archived' in body || 'in_trash' in body) throw new NotionReviewRequiredError('NOTION_DESTRUCTIVE_WRITE_FORBIDDEN');
    return this.request(method, path, undefined, body, true);
  }
  /** Recoverable cleanup only for the one journal-owned synthetic TEST page. The general destructive-write guard stays intact. */
  async trashIsolatedTestPage(input:{pageId:string;dataSourceId:string;titlePropertyId:string;adminPropertyId:string;testId:string;title:string}):Promise<Record<string,unknown>>{return this.setIsolatedTestPageTrash(input,true);}
  async restoreIsolatedTestPage(input:{pageId:string;dataSourceId:string;titlePropertyId:string;adminPropertyId:string;testId:string;title:string}):Promise<Record<string,unknown>>{return this.setIsolatedTestPageTrash(input,false);}
  private async setIsolatedTestPageTrash(input:{pageId:string;dataSourceId:string;titlePropertyId:string;adminPropertyId:string;testId:string;title:string},inTrash:boolean):Promise<Record<string,unknown>>{
    this.assertWriteApproved();
    const owned=this.isolatedTestScope?.();
    if(!owned||owned.dataSourceId!==input.dataSourceId||owned.pageId!==input.pageId||owned.testId!==input.testId
      ||!/^trainersync-test-[a-f0-9-]{36}$/.test(input.testId)||input.title!=='TEST TrainerSync | '+input.testId)throw new NotionReviewRequiredError('ISOLATED_TRASH_SCOPE_INVALID');
    const page=await this.read('/pages/'+resourceId(input.pageId)),parent=object(page.parent);
    const props=Object.values(object(page.properties)).map(object),title=props.filter(p=>p.id===input.titlePropertyId),admin=props.filter(p=>p.id===input.adminPropertyId);
    const label=title.length===1?array(title[0]!.title).map(v=>{const p=object(v);return typeof p.plain_text==='string'?p.plain_text:string(object(p.text).content);}).join(''):'';
    if(String(parent.data_source_id??'').replaceAll('-','')!==input.dataSourceId.replaceAll('-','')||label!==input.title||admin.length!==1||admin[0]!.url!=='https://admin.biz-pt.com/manage/members/'+input.testId)
      throw new NotionReviewRequiredError('ISOLATED_TRASH_IDENTITY_MISMATCH');
    if(page.in_trash===inTrash)return page;
    return this.request('PATCH','/pages/'+resourceId(input.pageId),undefined,{in_trash:inTrash},true);
  }
  private async request(method: NotionRequest['method'], path: string, query: Readonly<Record<string, string>> | undefined, body: unknown, write: boolean): Promise<Record<string, unknown>> {
    const url = new URL(`/v1${path}`, NOTION_API_ORIGIN);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    for (let attempt = 0; ; attempt++) {
      const auditStart=Date.now();if(write)await auditEvent({stage:'write',outcome:'started',provider:'notion',operation:method==='POST'?'create':'update',retryCount:attempt});
      let response: NotionResponse;
      try {
        response = await this.transport({ method, url: url.href, headers: {
          Authorization: `Bearer ${this.token}`, 'Notion-Version': NOTION_API_VERSION, 'Content-Type': 'application/json',
        }, ...(body === undefined ? {} : {body: structuredClone(body)}) });
      } catch {
        await auditEvent({stage:write?'write':'error',outcome:write?'uncertain':'failed',provider:'notion',errorCode:write?'NOTION_WRITE_OUTCOME_UNCERTAIN':'NOTION_TRANSPORT_UNAVAILABLE',durationMs:Date.now()-auditStart,retryCount:attempt});
        if (write) throw new NotionWriteUncertainError();
        throw new RetryableError('NOTION_TRANSPORT_UNAVAILABLE');
      }
      if (write && response.status >= 500 && response.status !== 529){await auditEvent({stage:'write',outcome:'uncertain',provider:'notion',httpStatus:response.status,errorCode:'NOTION_WRITE_OUTCOME_UNCERTAIN',retryCount:attempt,durationMs:Date.now()-auditStart});throw new NotionWriteUncertainError();}
      let result:Record<string,unknown>;
      try { result = object(response.body); } catch (error) { if(write)throw new NotionWriteUncertainError();throw error; }
      if (response.status >= 200 && response.status < 300){if(write)await auditEvent({stage:'write',outcome:'succeeded',provider:'notion',operation:method==='POST'?'create':'update',httpStatus:response.status,retryCount:attempt,durationMs:Date.now()-auditStart});return structuredClone(result);}
      const code = typeof result.code === 'string' && /^[a-z_]{1,80}$/.test(result.code) ? result.code : 'unknown_error';
      const additional = result.additional_data && typeof result.additional_data === 'object' ? object(result.additional_data) : {};
      const rateLimited = (response.status === 429 || response.status === 529) && additional.rate_limit_reason !== 'public_api_request_blocked';
      if (rateLimited) {
        const header = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
        const raw = header ?? additional.retry_after;
        const seconds = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : undefined;
        const wait = Math.max(seconds === undefined ? 1000 : seconds * 1000, 1000 * 2 ** attempt);
        if (attempt >= this.maxRetries) {await auditEvent({stage:'error',outcome:'failed',provider:'notion',httpStatus:response.status,errorCode:'READ_RATE_LIMITED',retryCount:attempt,durationMs:Date.now()-auditStart});throw new RetryableError(`NOTION_HTTP_${response.status}:${code}`, wait);}
        await auditEvent({stage:'retry',outcome:'held',provider:'notion',reasonCode:'RATE_LIMITED',httpStatus:response.status,retryCount:attempt+1,durationMs:Date.now()-auditStart});await this.sleep(wait);
        continue;
      }
      await auditEvent({stage:'error',outcome:'failed',provider:'notion',errorCode:'NOTION_HTTP_ERROR',httpStatus:response.status,retryCount:attempt,durationMs:Date.now()-auditStart});
      // A timed-out/failed write may have committed. Never blindly replay it.
      if (write && response.status >= 500) throw new NotionWriteUncertainError();
      if (!write && [500, 502, 503, 504].includes(response.status)) throw new RetryableError(`NOTION_HTTP_${response.status}:${code}`);
      throw new NotionHttpError(response.status, code);
    }
  }
}

/** Optional real transport. Passing it to the client does not grant either capability. */
export const officialNotionFetchTransport: NotionTransport = async request => {
  const response = await fetch(request.url, {method:request.method, headers:request.headers, redirect:'error',
    ...(request.body === undefined ? {} : {body:JSON.stringify(request.body)})});
  return {status:response.status, headers:{'retry-after':response.headers.get('retry-after') ?? undefined}, body:await response.json()};
};

/** has_more=false alone is insufficient: capped queries report request_status=incomplete. */
export async function collectNotionPages(load: (cursor: string | null) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await load(cursor);
    if (page.request_status && object(page.request_status).type !== 'complete') throw new NotionReviewRequiredError('NOTION_QUERY_INCOMPLETE');
    for (const raw of array(page.results)) {
      const item = object(raw);
      if (typeof item.id === 'string' && item.object !== 'property_item') {
        if (ids.has(item.id)) throw new NotionReviewRequiredError('NOTION_PAGINATION_DUPLICATE');
        ids.add(item.id);
      }
      result.push(item);
    }
    if (page.has_more === false) {
      if (page.next_cursor !== null && page.next_cursor !== undefined) throw new NotionReviewRequiredError('NOTION_PAGINATION_INVALID');
      return result;
    }
    if (page.has_more !== true || typeof page.next_cursor !== 'string' || !page.next_cursor || cursors.has(page.next_cursor)) throw new NotionReviewRequiredError('NOTION_PAGINATION_LOOP');
    cursor = page.next_cursor;
    cursors.add(cursor);
    if (cursors.size > 1000) throw new NotionReviewRequiredError('NOTION_PAGINATION_LIMIT');
  }
}
