# 초기 커밋 범위와 원격 인계

최초 확인 때 기존 작업 폴더와 상위 경로에는 .git이 없었다. 브랜치/이력/remote가 없었으므로 기존 Git 이력을 변경하지 않았다.

사용자가 지정한 원격은 https://github.com/alexjspark/bpt_notion_sync 이다. 조회 시 공개(PUBLIC)이며 브랜치 없는 빈 저장소였다. GitHub CLI 인증의 저장소 권한은 READ / push=false였다. 새 토큰·권한 부여는 임의로 진행하지 않는다. 로컬 커밋/실제 push 결과는 최종 작업 응답에서 확인한다.

## 선택한 범위

일반 소스·합성 테스트·패키지/빌드 정의·합성 예제 설정과 비식별 인계 문서만 후보에 넣는다. 실제 회원 scope와 개인 목적지 상수는 서버 비공개 설정으로 옮겼고, 테스트 식별자는 가상 값으로 교체했다.

docs는 네 인계 문서만 allowlist로 허용한다. 원본 감사기록, 회원 페이지 링크/화면, 개인 설정, source 백업, local-config, .runtime, 로그, DB dump, 브라우저 프로필, node_modules와 생성 빌드 산출물은 제외한다. 기존 기록은 삭제하지 않는다.

staging 이후 scripts/check-commit-safety.mjs가 index의 파일 경로·링크/바이너리·credential 형태·로컬 migration manifest에 기록한 개인 식별자의 재등장을 검사한다. 원문값은 결과에 출력하지 않는다. 알려진 패턴 검사가 모든 종류의 자유 텍스트 개인정보를 완전히 탐지한다고 주장하지 않는다.

원격 반영에는 정확한 목적지만 사용하며 force push, 이력 재작성, 다른 repository 생성이나 업로드를 하지 않는다. 원격에 새 내용이 생기면 fetch로 먼저 확인하고 기존 이력을 보존한다.
