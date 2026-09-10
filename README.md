# Family Care Cloud 백엔드

설계 문서의 가족 공동 돌봄 기능을 실행 가능한 로컬 백엔드 MVP로 구현했습니다. Node.js 22 이상, 외부 패키지 없이 실행합니다.

## 실행

PowerShell:

```powershell
$env:DEV_TOKEN = 'local-development-token-change-me'
$env:DEV_USER_ID = 'dev-caregiver'
npm start
```

`.env.example`은 참고 파일이며 자동 로드하지 않습니다. API는 `http://127.0.0.1:3000`에서 실행됩니다. 개발 토큰은 서버에서 지정한 사용자 한 명에 매핑됩니다. 요청 본문이나 임의의 사용자 헤더로 다른 사용자를 가장할 수 없습니다. 다중 사용자 흐름은 도메인 테스트로 검증합니다.

```powershell
$headers = @{ Authorization = "Bearer $env:DEV_TOKEN" }
$group = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/groups -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes('{"elderName":"김어르신","name":"보호자"}'))
Invoke-RestMethod -Uri "http://127.0.0.1:3000/groups/$($group.id)/handoff" -Headers $headers
npm test
```

## 구현 내용

- 가족 그룹 생성·조회, 소유자의 보호자/고령자 등록, 가족 단위 접근 제한
- 돌봄 기록 등록, 시간순 조회·기간/유형 필터, 작성자와 시스템 이벤트 기록
- 일정 등록·조회·완료, 변경/취소 승인·거절·연락 필요 표시
- 다음 담당자 지정·교대 이력, 교대 시 미처리 승인 담당자 이관
- 최근 1~30일 기록을 건강/생활/확인사항으로 분류하는 출처 기반 인수인계
- 저장된 병원/복약/방문 일정에 대한 한국어 키워드 질문 응답

## 구현 범위와 다음 단계

현재 JSON 파일 저장은 **로컬 단일 프로세스 개발용**입니다. 실제 개인정보 대신 테스트 데이터를 사용하세요. 운영 환경 실행은 차단됩니다. Cognito 로그인, DynamoDB, API Gateway/Lambda, Bedrock 생성형 요약, 음성 인식·합성, 실제 알림 전송, 프론트엔드는 아직 연결되지 않았습니다. 인수인계 `mode: extractive`는 원문 분류이며 AI 분석 결과가 아닙니다. 질문 응답은 제한된 키워드와 ‘오늘’ 조건만 지원합니다. 연락하기는 필요 표시만 저장하며 전화·메시지를 전송하지 않습니다.

상세 계약은 [API 명세](docs/API.md), 개발 순서와 완료 기준은 [구현 계획](docs/IMPLEMENTATION_PLAN.md)을 참고하세요.

프론트 저장소: [fcc-frontend](https://github.com/FamilyCareCloud/fcc-frontend)
AI 저장소: [fcc-ai](https://github.com/FamilyCareCloud/fcc-ai)
