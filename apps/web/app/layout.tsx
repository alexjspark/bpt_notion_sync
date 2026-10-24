import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trainer Sync · 로컬 테스트',
  description: '트레이너 회원 동기화와 수업 일정 관리 · 합성 데이터 전용',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
