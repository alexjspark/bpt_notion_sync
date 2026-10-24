import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTION_API_VERSION, OfficialNotionClient, NotionAccessDeniedError, NotionHttpError,
  NotionReviewRequiredError, NotionWriteUncertainError, collectNotionPages,
  propertyPathId, resourceId,
  type NotionRequest, type NotionResponse, type NotionTransport,
} from '../src/live-notion-client.ts';
import { RetryableError } from '../src/ports.ts';

const ok: NotionResponse = {status:200,body:{object:'page',id:'synthetic-page'}};
const readPermit = {approved:true} as const;
const writePermit = {approved:true} as const;

function scripted(responses: Array<NotionResponse | Error>) {
  const requests: NotionRequest[] = [];
  const transport: NotionTransport = async request => {
    requests.push(request);
    const response = responses[requests.length - 1];
    if (response instanceof Error) throw response;
    assert.ok(response, 'The adapter made an unexpected additional request');
    return response;
  };
  return {requests,transport};
}

test('official client grants no reads or writes by default and never invokes transport',async()=>{
  const {requests,transport}=scripted([]);
  const client=new OfficialNotionClient({token:'synthetic-token',transport});
  await assert.rejects(client.read('/pages/synthetic-page'),NotionAccessDeniedError);
  await assert.rejects(client.write('POST','/pages',{}),NotionAccessDeniedError);
  assert.equal(requests.length,0);
  const writeOnly=new OfficialNotionClient({token:'synthetic-token',transport,writePermit});
  await assert.rejects(writeOnly.write('POST','/pages',{}),/NOTION_READ_NOT_APPROVED/);
  assert.equal(requests.length,0);
});

test('explicit read permit allows POST data-source queries while denying mutation',async()=>{
  const {requests,transport}=scripted([ok]);
  const client=new OfficialNotionClient({token:'synthetic-token',transport,readPermit});
  const body={filter:{property:'trainer-key',rich_text:{equals:'synthetic-trainer'}}};
  await client.read('/data_sources/synthetic-source/query',{page_size:'100'},body);
  assert.equal(NOTION_API_VERSION,'2026-03-11');
  assert.equal(requests[0]!.method,'POST');
  assert.equal(requests[0]!.url,'https://api.notion.com/v1/data_sources/synthetic-source/query?page_size=100');
  assert.equal(requests[0]!.headers['Notion-Version'],'2026-03-11');
  assert.equal(requests[0]!.headers.Authorization,'Bearer synthetic-token');
  assert.deepEqual(requests[0]!.body,body);
  await assert.rejects(client.write('PATCH','/pages/synthetic-page',{}),/NOTION_WRITE_NOT_APPROVED/);
  assert.equal(requests.length,1);
});

test('endpoint allowlists reject origin escapes, traversal, query injection and invalid mutations before transport',async()=>{
  const {requests,transport}=scripted([]);
  const client=new OfficialNotionClient({token:'synthetic-token',transport,readPermit,writePermit});
  for(const path of ['https://example.invalid/pages/x','//example.invalid/x','/pages/../users','/pages/x?secret=y','/search','/pages/x#fragment']){
    await assert.rejects(client.read(path),/NOTION_READ_ENDPOINT_INVALID/);
  }
  await assert.rejects(client.read('/pages/x',undefined,{properties:{}}),/NOTION_READ_ENDPOINT_INVALID/);
  await assert.rejects(client.write('POST','/pages/x',{}),/NOTION_WRITE_ENDPOINT_INVALID/);
  await assert.rejects(client.write('PATCH','/pages',{}),/NOTION_WRITE_ENDPOINT_INVALID/);
  await assert.rejects(client.write('PATCH','/data_sources/x',{}),/NOTION_WRITE_ENDPOINT_INVALID/);
  for(const body of [{erase_content:true},{archived:true},{in_trash:true}]){
    await assert.rejects(client.write('PATCH','/pages/x',body),/NOTION_DESTRUCTIVE_WRITE_FORBIDDEN/);
  }
  assert.equal(requests.length,0);
});

test('resource IDs reject path syntax and encoded property IDs retain exactly one encoding',async()=>{
  assert.equal(resourceId('synthetic_page-1'),'synthetic_page-1');
  for(const id of ['', '../x','x/y','x?y','x%2Fy']) assert.throws(()=>resourceId(id),NotionReviewRequiredError);
  const id='f%5C%5C%3Ap';
  assert.equal(propertyPathId(id),id);
  for(const invalid of ['', 'x/y','x?y','x%ZZ','x%']) assert.throws(()=>propertyPathId(invalid),NotionReviewRequiredError);
  const {requests,transport}=scripted([ok]);
  await new OfficialNotionClient({token:'synthetic-token',transport,readPermit}).read(`/pages/synthetic-page/properties/${propertyPathId(id)}`);
  assert.equal(requests[0]!.url,`https://api.notion.com/v1/pages/synthetic-page/properties/${id}`);
  assert.ok(!requests[0]!.url.includes('%255C'));
});

test('429 and 529 honor case-insensitive Retry-After and increase backoff between retries',async()=>{
  const {requests,transport}=scripted([
    {status:429,headers:{'rEtRy-AfTeR':'7'},body:{code:'rate_limited'}},
    {status:529,headers:{'RETRY-AFTER':'1'},body:{code:'service_overload'}},
    ok,
  ]);
  const waits:number[]=[];
  const client=new OfficialNotionClient({token:'synthetic-token',transport,readPermit,sleep:async ms=>{waits.push(ms);}});
  await client.read('/pages/synthetic-page');
  assert.deepEqual(waits,[7000,2000]);
  assert.equal(requests.length,3);
  assert.deepEqual(requests.map(request=>request.url),Array(3).fill('https://api.notion.com/v1/pages/synthetic-page'));
});

test('rate limit body fallback and malformed Retry-After use bounded retry accounting',async()=>{
  const {requests,transport}=scripted([
    {status:429,body:{code:'rate_limited',additional_data:{retry_after:'3'}}},
    {status:429,headers:{'Retry-After':'0.5'},body:{code:'rate_limited'}},
    {status:529,headers:{'Retry-After':'9'},body:{code:'service_overload'}},
  ]);
  const waits:number[]=[];
  const client=new OfficialNotionClient({token:'synthetic-token',transport,readPermit,sleep:async ms=>{waits.push(ms);},maxRateLimitRetries:2});
  await assert.rejects(client.read('/pages/synthetic-page'),error=>{
    assert.ok(error instanceof RetryableError);
    assert.equal(error.retryAfterMs,9000);
    return true;
  });
  assert.deepEqual(waits,[3000,2000]);
  assert.equal(requests.length,3);
});

test('public_api_request_blocked is never retried even with Retry-After',async()=>{
  const {requests,transport}=scripted([{status:429,headers:{'Retry-After':'60'},body:{code:'rate_limited',additional_data:{rate_limit_reason:'public_api_request_blocked'}}}]);
  let sleeps=0;
  const client=new OfficialNotionClient({token:'synthetic-token',transport,readPermit,sleep:async()=>{sleeps++;}});
  await assert.rejects(client.read('/pages/synthetic-page'),error=>error instanceof NotionHttpError && error.status===429);
  assert.equal(requests.length,1);
  assert.equal(sleeps,0);
});

test('ambiguous write server errors and transport failures require reconciliation without replay',async()=>{
  for(const response of [{status:500,body:{code:'internal_server_error'}},{status:504,body:{code:'gateway_timeout'}},new Error('synthetic connection loss')]){
    const {requests,transport}=scripted([response]);
    let sleeps=0;
    const client=new OfficialNotionClient({token:'synthetic-token',transport,readPermit,writePermit,sleep:async()=>{sleeps++;}});
    await assert.rejects(client.write('POST','/pages',{parent:{type:'data_source_id',data_source_id:'synthetic-source'}}),NotionWriteUncertainError);
    assert.equal(requests.length,1);
    assert.equal(sleeps,0);
  }
});

test('read transport failure is retryable and does not leak transport error details',async()=>{
  const {requests,transport}=scripted([new Error('synthetic-private-upstream-detail')]);
  const client=new OfficialNotionClient({token:'synthetic-token',transport,readPermit});
  await assert.rejects(client.read('/pages/synthetic-page'),error=>{
    assert.ok(error instanceof RetryableError);
    assert.equal(error.message,'NOTION_TRANSPORT_UNAVAILABLE');
    return true;
  });
  assert.equal(requests.length,1);
});

test('collector follows all cursors and accepts complete uncapped query results',async()=>{
  const cursors:Array<string|null>=[];
  const rows=await collectNotionPages(async cursor=>{
    cursors.push(cursor);
    return cursor===null
      ? {results:[{id:'synthetic-a'}],has_more:true,next_cursor:'synthetic-next',request_status:{type:'complete'}}
      : {results:[{id:'synthetic-b'}],has_more:false,next_cursor:null};
  });
  assert.deepEqual(cursors,[null,'synthetic-next']);
  assert.deepEqual(rows.map(row=>row.id),['synthetic-a','synthetic-b']);
});

test('collector rejects incomplete queries even when has_more is false',async()=>{
  await assert.rejects(collectNotionPages(async()=>({results:[],has_more:false,next_cursor:null,request_status:{type:'incomplete',incomplete_reason:'query_result_limit_reached'}})),/NOTION_QUERY_INCOMPLETE/);
});

test('collector rejects repeated cursors, contradictory cursors and duplicate row IDs',async()=>{
  await assert.rejects(collectNotionPages(async()=>({results:[],has_more:true,next_cursor:'repeat'})),/NOTION_PAGINATION_LOOP/);
  await assert.rejects(collectNotionPages(async()=>({results:[],has_more:false,next_cursor:'unexpected'})),/NOTION_PAGINATION_INVALID/);
  await assert.rejects(collectNotionPages(async cursor=>({results:[{id:'synthetic-duplicate'}],has_more:cursor===null,next_cursor:cursor===null?'next':null})),/NOTION_PAGINATION_DUPLICATE/);
});

test('collector rejects malformed response envelopes instead of claiming coverage',async()=>{
  await assert.rejects(collectNotionPages(async()=>({results:null,has_more:false,next_cursor:null})),NotionReviewRequiredError);
  await assert.rejects(collectNotionPages(async()=>({results:[],next_cursor:null})),/NOTION_PAGINATION_LOOP/);
  await assert.rejects(collectNotionPages(async()=>({results:[],has_more:true,next_cursor:''})),/NOTION_PAGINATION_LOOP/);
});
