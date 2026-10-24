import { saveSettings } from '@trainer/db';
import { activeTrainerId, allowedOrigin, safeJson } from '../../../lib/server';
import { assertSameOrigin, parseSettings } from '../../../lib/validation';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request.headers, request.url, allowedOrigin(request));
  } catch {
    return safeJson({ error: '이 관리 화면에서 설정을 변경해 주세요.' }, 403);
  }
  let input: ReturnType<typeof parseSettings>;
  try {
    input = parseSettings(await request.json());
  } catch (error) {
    return safeJson({ error: error instanceof SyntaxError ? '요청 형식이 올바르지 않습니다.' : error instanceof Error ? error.message : '설정 값을 확인해 주세요.' }, 400);
  }
  try {
    await saveSettings(activeTrainerId(), input);
    return safeJson({ mode: 'mock', message: '테스트 실행 설정을 저장했습니다. 실제 외부 연결은 계속 비활성화됩니다.' });
  } catch {
    return safeJson({ error: '설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 503);
  }
}
