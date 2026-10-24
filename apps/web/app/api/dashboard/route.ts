import { getDashboard } from '@trainer/db';
import { activeTrainerId, safeJson } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return safeJson(await getDashboard(activeTrainerId()));
  } catch {
    return safeJson({ error: '관리 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 503);
  }
}
