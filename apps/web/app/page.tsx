import { getDashboard } from '@trainer/db';
import { Dashboard } from '../components/dashboard';
import { activeTrainerId } from '../lib/server';

export const dynamic = 'force-dynamic';

export default async function Page() {
  try {
    const data = await getDashboard(activeTrainerId());
    return <Dashboard initialData={data} />;
  } catch {
    return (
      <main className="unavailable">
        <span className="eyebrow">TRAINER SYNC · LOCAL MOCK</span>
        <h1>데이터베이스 연결을 확인하고 있습니다</h1>
        <p>PostgreSQL과 초기화 작업이 준비되면 관리 화면을 사용할 수 있습니다.</p>
        <p className="safe-note">합성 데이터 전용입니다. 실제 회사·Notion 연결은 비활성화되어 있습니다.</p>
        <a className="button primary" href="/">다시 확인</a>
      </main>
    );
  }
}
