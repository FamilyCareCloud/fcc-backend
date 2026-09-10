# v0.1 → v0.2 변경 안내

## API

- DEV_TOKEN·DEV_USER_ID 제거. `/auth/register`, `/auth/login`으로 실제 로컬 계정과 세션을 만듭니다.
- `/members` 직접 추가 대신 `/invitations` → `/invitations/accept`로 변경했습니다.
- `/handoff` 즉시 원문 조회 대신 `/handoffs` 생성·저장·조회 API를 사용합니다.
- 일정 PATCH에서 보호자가 title/time/type/caregiver/status를 변경할 수 있습니다. 취소를 위해 승인을 먼저 만들 필요가 없습니다.
- 교대 응답은 history와 handoff를 포함합니다. 인수인계 오류가 발생하면 담당자 변경도 롤백합니다.
- ID는 서버 생성이며 기존 임의 사용자 ID는 새 인증 사용자 ID와 자동 연결하지 않습니다.

## 로컬 데이터

기본 파일은 `data/fcc.json`에서 `data/fcc-v2.json`으로 변경했습니다. 기존 파일은 건드리지 않습니다. v0.1 형식의 비어 있지 않은 파일을 v0.2 DATA_FILE로 지정하면 명시적인 오류로 시작을 중단합니다.

v0.1에 실제 필요한 기록이 있다면 원본을 보관하고, 새 계정을 생성한 후 기존 createdBy/담당자와 새 userId를 명시적으로 매핑하는 별도 이전 작업이 필요합니다. 자동으로 과거 ID의 계정 소유권을 새 가입자에게 부여하지 않습니다. 이 변경에서는 기존 데이터를 삭제하거나 자동 이전하지 않았습니다.

## AI·AWS

로컬 기본은 `AI_PROVIDER=local`. 실제 AI는 `AI_PROVIDER=bedrock`, BEDROCK_MODEL_ID, AWS 계정 권한이 필요합니다. Lambda에서는 SAM이 DB 테이블/인증 클라이언트 환경 변수를 넣습니다. 기존 AWS 테이블은 필요 없습니다.
