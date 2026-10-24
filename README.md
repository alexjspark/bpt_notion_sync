# TrainerSync — 비즈니스PT admin ↔ Notion

[비즈니스PT admin 사이트와 노션 동기화 1차 완성](docs/MILESTONE-1.md) 마일스톤의 코드와 비식별 문서입니다.

현재 검증 범위는 기존 단일 담당자의 실제 계정 읽기·수동 미리보기, 그리고 별도 승인된 일회 저장입니다. **일반 전체 자동 저장은 미완성이며 예약 실행은 OFF입니다.** 실제 계정의 원문·설정·키·화면·검증 기록은 이 저장소에 포함하지 않습니다.

## 구조

| 경로 | 역할 |
| --- | --- |
| apps/web | Next.js 로컬 UI와 서버 API |
| apps/worker | 지속 작업 큐 처리 |
| packages/core | 날짜·요일시간·상태·템플릿·일정의 순수 로직 |
| packages/db | PostgreSQL 저장·migration·합성 fixture |
| packages/engine | 회사·Notion 어댑터, 미리보기, 승인된 일회 저장, 안전한 로그 |
| scripts | 로컬 운영·검사 도구 |
| tests | 합성 계약·DB 통합·브라우저 검사 |

서비스별 모듈을 분리합니다. 일반 버튼은 UI → 큐 → worker → 실제 회사/Notion 읽기 → 미리보기 결과까지 실증했습니다. 연락처·생년월일·성별 저장은 편집 중단 조건의 별도 일회 버튼 경로였으며, 과거 connector 개별 보완을 일반 worker 저장 완료로 간주하지 않습니다.

## 로컬 개발

Node 의존성을 설치한 뒤 다음 명령을 사용합니다.

    npm ci
    npm run typecheck
    npm run test:unit

격리 PostgreSQL 통합 검사는 TEST_DATABASE_URL이 별도 test DB를 가리켜야 합니다. Docker 기반 검사는 npm run check:docker에 있습니다. 기존 운영 DB·볼륨·프로필을 삭제하거나 초기화하지 마세요. 합성 테스트 통과와 실제 계정 E2E는 다른 검증입니다.

기본 compose는 localhost 웹과 합성 모드만 구성합니다. 실계정 연결은 opt-in이고, 개인 Chrome 쿠키·비밀번호 복사 경로를 제공하지 않습니다. 실계정 연결을 추가하는 작업은 해당 소유자의 별도 승인이 필요합니다.

## 비공개 설정

Notion 목적지와 일회 작업 대상은 서버 전용 런타임 설정으로 전달합니다. 샘플 ID는 가상 값이며 연결된 개인 목적지를 뜻하지 않습니다. 승인 설정이 없으면 관련 쓰기 준비/실행은 거부됩니다. 이미 소모된 일회 실행은 다시 허용하지 않습니다.

[설정 분리 인계](docs/PORTABLE-CONFIG.md), [마일스톤 및 남은 한계](docs/MILESTONE-1.md), [동료별 tenant 구조 제안](docs/COLLEAGUE-TENANT-PLAN.md)을 확인하세요. 현재 실행 중인 기존 PC 서비스는 이번 소스 정리로 재배포하지 않았습니다.

## 데이터 보존과 동시 편집

기존 수동 값·본문·상태·일정은 보존합니다. UID 없는 행은 이름만으로 연결하지 않습니다. 검증된 Notion 원자적 조건부 쓰기가 없어 일반 기존 페이지 PATCH는 보류합니다. 편집 중단을 전제로 수행했던 일회 저장은 이 한계를 해결한 것이 아닙니다.

Git staging은 명시적 파일 목록으로 수행합니다. 원본 회원 감사기록·화면·설정·키·프로필·산출물은 제외하며, scripts/check-commit-safety.mjs로 index 내용도 검사합니다.
