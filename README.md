# Family Care Cloud backend v0.2

2026-09-10 설계서 v1.00의 보호자 중심 MVP 백엔드입니다. 가입 → 그룹 생성 → 고령자 등록 → 가족 초대/참여 → 기록 작성 → 일정 관리 → 교대/인수인계 → 인수 확인 흐름을 제공합니다.

## 실행

Node.js 22 이상, pnpm을 사용합니다.

```powershell
pnpm install --frozen-lockfile
pnpm start
```

주소: `http://127.0.0.1:3000`. `.env.example`은 참고용이며 자동으로 읽지 않습니다. 기본 DB는 `data/fcc-v2.json`, AI는 **로컬 규칙/원문 추출 모드**입니다. 로컬은 실제 이메일 인증 없이 개발 계정을 생성합니다. 운영 Lambda는 Cognito 인증과 DynamoDB를 사용합니다.

```powershell
$env:PORT = '3000'
$env:DATA_FILE = './data/fcc-v2.json'
$env:AI_PROVIDER = 'local'
$env:STT_SERVICE_URL = 'http://127.0.0.1:8000'  # fcc-ai(feature/stt-service)를 별도로 실행 중일 때만 필요
pnpm start
```

다른 터미널에서:

```powershell
$base = 'http://127.0.0.1:3000'
$account = @{ email = 'caregiver@example.com'; password = 'LocalCare!12345'; name = '보호자' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/auth/register" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($account))
$session = Invoke-RestMethod -Method Post -Uri "$base/auth/login" -ContentType 'application/json' -Body '{"email":"caregiver@example.com","password":"LocalCare!12345"}'
$headers = @{ Authorization = "Bearer $($session.accessToken)" }
Invoke-RestMethod -Uri "$base/me" -Headers $headers
```

## 구현 기능

- 로컬 가입·로그인·로그아웃, 이름 수정, 비밀번호 scrypt 해시, 세션 만료·폐기
- AWS Cognito 가입·이메일 확인·로그인·토큰 검증·로그아웃 어댑터
- 그룹 생성, 고령자 별도 등록/수정, 이메일 대상 일회용 초대, 참여/탈퇴, 소유권 이전
- 기록 작성/상세/기간·유형 조회/수정/삭제, 자동 분석과 수동 유형 선택
- 일정 등록/수정/삭제, 보호자의 직접 완료·취소, 오늘/다음 일정 조회
- 담당자 지정·교대 이력, 교대 시 인수인계 생성, 기록 없으면 교대만 처리
- 기간별 인수인계 생성/상세/최신/이력/재생성/인수 확인, 생성 당시 원문 근거 보존
- Bedrock Converse 연동, 응답 JSON·근거 ID·원문 인용 검증, AI 실패 시 롤백/오류 안내
- DynamoDB 저장 어댑터와 동시 변경 조건 검사, AWS SAM 인프라 템플릿
- [fcc-ai](https://github.com/FamilyCareCloud/fcc-ai)(GPU STT, `feature/stt-service`) 연동: `/groups/{g}/assistant/voice`가 오디오를 fcc-ai `/transcribe`로 전사한 뒤 기존 텍스트 질문과 동일한 DB 근거 답변으로 응답

확장 기능인 승인 요청과 제한된 텍스트 일정 질문, GPU STT 연동 음성 질문은 유지했습니다. 실제 알림 발송, 음성 합성(TTS), 위치 감지는 이번 MVP 범위 밖입니다. 별도 `fcc-frontend` 저장소의 화면은 이 작업에서 수정하지 않았습니다.

### 음성 질문(fcc-ai 연동)

`fcc-ai`의 `feature/stt-service` 브랜치를 별도 GPU 환경에서 실행한 뒤(`uvicorn app.main:app --host 0.0.0.0 --port 8000`), 백엔드에 `STT_SERVICE_URL`만 지정하면 연결됩니다. 미설정 시 음성 질문 API는 항상 **503**을 반환하고, 텍스트 질문(`/groups/{g}/assistant`)에는 영향이 없습니다.

```powershell
$body = @{ audioBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('sample.wav')); mimeType = 'audio/wav' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/groups/$($group.id)/assistant/voice" -Headers $headers -ContentType 'application/json' -Body $body
```

## 검증

```powershell
pnpm test
```

로컬 도메인/HTTP/Lambda 변환 및 실제 SDK 명령을 사용하는 모의 AWS 어댑터 테스트가 포함됩니다. 실제 AWS 계정 배포와 실제 Bedrock 모델 호출은 별도 통합 검증이 필요합니다. 계정이나 모델이 없을 때 `mode: extractive` / `local-rules`로 표시하며 AI 결과로 가장하지 않습니다.

## 문서

- `develop`에 푸시하거나 PR을 병합하면 GitHub Actions가 테스트 후 AWS 백엔드를 자동 배포합니다. PR 자체는 검증만 수행합니다.
- [첫 배포 주소·설정·재배포 방법](docs/DEPLOYMENT.md)
- [최신 설계 원문](docs/FCC.md)
- [API 계약](docs/API.md)
- [설계 대비 구현 현황](docs/IMPLEMENTATION_PLAN.md)
- [DB 구성 및 AWS 배포](docs/DATABASE.md)
- [v0.1 변경/데이터 이전](docs/MIGRATION.md)

로컬 파일 DB는 단일 프로세스용입니다. 현재 DB 구조는 그룹 단위 원자적 저장을 우선한 소규모 MVP로, 한 그룹 레코드는 350 KB까지입니다. 한도 초과는 413으로 거절하며 기존 데이터는 유지합니다. 장기 운영 전 기록/인수인계의 개별 항목 분리와 페이지네이션이 필요합니다.

회원가입 개선: [비밀번호·인증 재전송·프론트 응답 계약](docs/AUTH_API.md). Cognito 정책과 Lambda를 함께 업데이트해야 합니다.
