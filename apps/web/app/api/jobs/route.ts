import { enqueueJob } from '@trainer/db';
import { activeTrainerId, allowedOrigin, safeJson } from '../../../lib/server';
import { assertSameOrigin, parseJob } from '../../../lib/validation';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request.headers, request.url, allowedOrigin(request));
  } catch {
    return safeJson({ error: '이 관리 화면에서 요청을 실행해 주세요.' }, 403);
  }
  let input: ReturnType<typeof parseJob>;
  try {
    input = parseJob(await request.json());
  } catch (error) {
    return safeJson({ error: error instanceof SyntaxError ? '요청 형식이 올바르지 않습니다.' : error instanceof Error ? error.message : '요청을 확인해 주세요.' }, 400);
  }
  try {
    const id = await enqueueJob(activeTrainerId(), input.kind, 'manual');
    return safeJson({ id, mode: 'mock', message: '합성 데이터 작업을 대기열에 추가했습니다.' }, 202);
  } catch {
    return safeJson({ error: '작업을 저장하지 못했습니다. 데이터베이스 상태를 확인해 주세요.' }, 503);
  }
}
