import { getDashboard } from '@trainer/db';
import { activeTrainerId, safeJson } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await getDashboard(activeTrainerId());
    return safeJson({ status: 'ok', database: 'ready', mode: 'mock', externalConnectionsEnabled: false });
  } catch {
    return safeJson({ status: 'unavailable', database: 'unavailable', mode: 'mock', externalConnectionsEnabled: false }, 503);
  }
}
