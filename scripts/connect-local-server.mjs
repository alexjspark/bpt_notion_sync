import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 2048;
const TOKEN_MIN_LENGTH = 20;
const TOKEN_MAX_LENGTH = 512;

export function validNotionToken(value) {
  return typeof value === 'string' && value.length >= TOKEN_MIN_LENGTH && value.length <= TOKEN_MAX_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

function equalSecret(left, right) {
  const a = Buffer.from(typeof left === 'string' ? left : '');
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function page(csrf) {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TrainerSync 연결 키 입력</title><main><h1>Notion 연결 키 입력</h1><p>이 PC의 전용 연결 설정입니다. 키를 채팅이나 소스에 붙여넣지 마세요.</p><p>전용 Notion Integration에 Read / Insert / Update content만 허용하고, 회원 마스터와 템플릿만 공유해 주세요. 사용자 정보와 댓글 권한은 필요하지 않습니다. 현재 앱의 실제 쓰기는 꺼져 있습니다.</p><form method="post" autocomplete="off"><input type="hidden" name="csrf" value="${csrf}"><label for="notion-token">Notion Integration 연결 키</label><p><input id="notion-token" name="notionToken" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required minlength="${TOKEN_MIN_LENGTH}" maxlength="${TOKEN_MAX_LENGTH}" size="48"></p><button type="submit">이 PC에 비공개로 저장</button></form><p>입력값은 작업 프로그램용 비공개 파일에만 저장됩니다. 저장 후 입력 서버가 종료됩니다.</p></main></html>`;
}

function safeHeaders(response, status, contentType = 'text/html; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    // Native Chromium form POSTs otherwise serialize Origin as "null".
    // Keep same-origin provenance while still withholding referrers from other origins.
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    Connection: 'close',
  });
}

async function readBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new Error('INVALID_INPUT');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('INVALID_INPUT');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The injected writer is the only consumer of the entered key. No request data is logged. */
export function createConnectionInputServer({ persist, port = 4311, onStorageStarted = () => {}, onSaved = () => {}, onStorageFailure = () => {} }) {
  if (typeof persist !== 'function') throw new Error('PERSIST_REQUIRED');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
  const route = `/connect/${randomBytes(24).toString('hex')}`;
  const csrf = randomBytes(32).toString('hex');
  let claimed = false;
  let state = 'waiting';
  let origin;
  const server = createServer(async (request, response) => {
    if (!origin || request.headers.host !== origin.slice('http://'.length) || request.url !== route) {
      safeHeaders(response, 404, 'text/plain; charset=utf-8'); response.end('NOT_FOUND'); return;
    }
    if (request.method === 'GET') {
      if (claimed) { safeHeaders(response, 410); response.end('입력이 이미 처리되었습니다.'); return; }
      safeHeaders(response, 200); response.end(page(csrf)); return;
    }
    if (request.method !== 'POST') {
      safeHeaders(response, 405, 'text/plain; charset=utf-8'); response.end('METHOD_NOT_ALLOWED'); return;
    }
    if (request.headers.origin !== origin || request.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
      safeHeaders(response, 403, 'text/plain; charset=utf-8'); response.end('INVALID_REQUEST'); return;
    }
    if (claimed) { safeHeaders(response, 409); response.end('입력이 이미 처리되었습니다.'); return; }
    let token;
    try {
      const params = new URLSearchParams(await readBody(request));
      if (params.size !== 2 || params.getAll('csrf').length !== 1 || params.getAll('notionToken').length !== 1 || !equalSecret(params.get('csrf'), csrf) || !validNotionToken(params.get('notionToken'))) throw new Error('INVALID_INPUT');
      token = params.get('notionToken');
    } catch {
      safeHeaders(response, 400, 'text/plain; charset=utf-8'); response.end('INVALID_INPUT'); return;
    }
    // Body reads yield; re-check after parsing so concurrent submissions cannot both persist.
    if (claimed) { safeHeaders(response, 409); response.end('입력이 이미 처리되었습니다.'); return; }
    claimed = true;
    state = 'saving';
    try { onStorageStarted(); } catch { /* Status callbacks never receive request data. */ }
    try {
      await persist(token);
      token = undefined;
      state = 'saved';
      try { onSaved(); } catch { /* Persistence is complete even if status reporting fails. */ }
    } catch {
      token = undefined;
      state = 'uncertain';
      // Capture the result before delivering the page, even if transport fails.
      try { onStorageFailure(); } catch { /* Never expose the entered key. */ }
      safeHeaders(response, 503); response.end('저장 결과를 확인해야 합니다. 입력 서버를 종료했습니다. 다시 입력하기 전에 상태를 확인해 주세요.');
      server.close();
      server.closeIdleConnections();
      return;
    }
    safeHeaders(response, 200); response.end('<!doctype html><html lang="ko"><meta charset="utf-8"><title>연결 키 저장 완료</title><p>비공개 저장을 완료했습니다. 이 창을 닫아도 됩니다. 실제 동기화 쓰기는 아직 실행하지 않았습니다.</p></html>');
    server.close();
    server.closeIdleConnections();
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxRequestsPerSocket = 1;
  return {
    server,
    get state() { return state; },
    // Stop admission, but let an active write and response finish.
    stop() {
      claimed = true;
      if (state === 'waiting') state = 'stopped';
      return new Promise(resolve => {
        if (!server.listening) { resolve(); return; }
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      const address = server.address();
      origin = `http://127.0.0.1:${address.port}`;
      return { url: `${origin}${route}`, origin };
    },
  };
}
