# 개인 바인딩 분리와 로컬 실행 인계

이번 정리는 코드와 합성 테스트를 공유할 수 있도록 개인 목적지·실회원 상수를 비공개 런타임 설정으로 분리한 작업이다. 실제 서비스 재배포, 동료 연결, 권한 확대나 외부 데이터 변경은 수행하지 않았다.

## 설정 입력

- 기존 version 1 설정의 notion.members.databaseId/dataSourceId를 서버 소유의 명시적 목적지로 사용한다. UUID 형식, 고정 단일 tenant, 허용 회사 origin, 읽기 전용/템플릿 쓰기 제한을 유지한다.
- 필요할 때만 contactSaveApproval에 consentKey와 정확한 두 대상의 uid/pageId/name을 둔다. 웹 요청에서 목적지나 대상을 받지 않는다. 준비/실행/transport에서 설정과 durable 대상 기록을 대조한다.
- 기존 격리 TEST 재검사 도구의 특정 fixture는 isolatedTestFixture의 suiteKey/pageId/testId로 전달한다. 일반 클라이언트는 격리 휴지통 허용 scope가 없으면 거부하며, 전달된 scope도 journal 소유 세 식별자가 모두 일치해야 한다.
- profile/isolated/contact transport는 명시된 database/data-source 경로와 실제 schema를 대조한다. 다른 목적지/필드/생성/삭제 범위로 확장하지 않는다.
- 스키마 discovery CLI도 LIVE_READONLY_CONFIG_FILE에서 목적지를 받아 두 metadata GET만 허용한다. 목적지 설정이 없으면 인증 파일 읽기 전에 종료한다.
- 토큰·쿠키·비밀번호는 이 비밀이 아닌 바인딩 설정에 넣지 않는다. 기존 정상 서비스 인증 경로를 유지하며, 별도 키 조회나 키 재입력을 요구하지 않는다.

config/live-readonly.example.json의 ID는 합성 예제다. 실제 계정에 연결하지 않으며 ownership은 기본 미확인 상태다. 샘플을 개인 값으로 편집한 복사본은 local-config 아래에 두고 Git에 추가하지 않는다.

## 기존 PC 보존

원래 설정 파일은 수정하지 않았다. 기존 소스의 개인 바인딩과 원본 소스 백업은 ignored local-config에 보존했고, 새 코드용 별도 설정 복사본을 만들었다. 개인 설정과 검증 기록은 commit/Docker build context에서 제외된다.

실행 중인 이미지·설정·DB의 완료된 작업 및 per-target dispatch 기록을 유지했다. CONTACT_SAVE_CONSENT, PROFILE_SAVE_CONSENT와 격리 suite key는 바뀌지 않아 완료 결과 표시와 소모 승인 차단이 보존된다. 새 설정 복사본 자체는 새로운 실행 승인이 아니며 소모된 작업을 다시 허용하지 않는다.

이 코드로 배포할 때는 검토한 비공개 설정 복사본을 기존 read-only config mount에 명시적으로 연결해야 한다. 이번 작업은 해당 mount를 바꾸거나 컨테이너를 교체하지 않았다. 일반 읽기 설정은 기존 파일 형식과 호환되지만, 과거 한정 쓰기의 새 준비/실행은 해당 비공개 승인 scope가 없으면 거부된다.

## 검사 범위

목적지 형식, scope 누락·변경, exact 대상 대조, 격리 TEST 소유권, 기존 consent key, 읽기 CLI 경계를 합성값으로 회귀 검사했다. 기존 서비스에 실제 쓰기를 해 이 정리를 시험하지 않았다. 빌드·타입·코드 검사 결과를 실계정 새 배포 완료로 표현하지 않는다.

동료별 일반 인증/연결 관리와 tenant별 저장 모델은 다음 단계다. 현재 단일 사용자 바인딩을 완성된 다중 사용자 지원이라고 간주하지 않는다.

## Destination snapshots

New one-time/isolated jobs pin the approved database/data-source in their private report. Execution compares that snapshot before service authentication. Legacy pending rows without a snapshot are held rather than assigned to a new destination. Completed rows and consumed dispatch markers are not modified. A fresh isolated test cannot be queued through the generic UI without a separately prepared destination approval.
