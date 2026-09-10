# 백엔드 첫 배포

- AWS 리전: 서울 (`ap-northeast-2`)
- CloudFormation 스택: `fcc-backend-dev`
- API: https://uwv0zhujxf.execute-api.ap-northeast-2.amazonaws.com
- 상태 확인: `/health`
- 프론트/CORS 허용 주소: https://develop.db2l4u9y804jp.amplifyapp.com
- 구성: API Gateway → Node.js 22 Lambda → DynamoDB / Cognito

## 배포 설정

이번 배포에는 `infra/frontend-backend-only.yaml`을 사용합니다. Bedrock 파라미터와 호출 권한을 제외하고 `AI_PROVIDER=local`로 설정합니다. 기존 규칙 기반 분류·원문 추출만 실행하며 별도 AI 서버는 배포하지 않습니다. 원본 `infra/template.yaml`은 Bedrock을 포함한 기존 구성으로 남겨둡니다.

AWS CLI 및 SAM CLI 인증과 Node.js 22가 준비된 환경에서 저장소 루트를 작업 위치로 사용합니다.

```bash
pnpm install --frozen-lockfile
pnpm test
sam validate --lint --template-file infra/frontend-backend-only.yaml
sam build --template-file infra/frontend-backend-only.yaml
sam deploy --template-file .aws-sam/build/template.yaml --stack-name fcc-backend-dev --region ap-northeast-2 --resolve-s3 --capabilities CAPABILITY_IAM --parameter-overrides FrontendOrigin=https://develop.db2l4u9y804jp.amplifyapp.com
```

백엔드 GitHub 자동 배포는 구성하지 않았습니다. Git에 푸시하는 것과 SAM으로 AWS에 재배포하는 것은 별도입니다. 배포 시 AWS 리소스 사용 비용이 발생합니다.

## 배포 버전과 후속 변경

2026-09-10 첫 배포는 `7255fc023cf050a1c587bb2303225072089616f9`에 OPTIONS 사전 요청 204 응답 수정과 AI 제외 템플릿을 적용한 버전입니다. 이 수정은 브라우저 연결 확인 요청을 허용하며 실제 데이터 요청의 인증은 유지합니다. CORS 헤더는 API Gateway가 지정된 프론트 Origin에만 적용합니다.

이후 GitHub에 추가된 음성 인식 연동 코드는 첫 배포에 포함되지 않았습니다. 이 문서가 포함된 최신 소스를 다시 배포할 때는 변경 기능도 함께 반영되므로 별도 검증이 필요합니다.

## 확인한 범위

- SAM 템플릿 lint·빌드 및 CloudFormation 생성·수정 성공.
- `/health` 200 및 `{"status":"ok"}` 응답.
- 프론트 Origin의 OPTIONS `/groups` 204와 CORS 헤더.
- 인증 없는 `/me` 401.
- 첫 배포 수정본의 로컬 테스트 30개 통과.

실제 이메일 확인을 포함한 회원가입·로그인과 인증 후 DB 저장/조회는 아직 통합 검증하지 않았습니다. 프론트는 별도 배포된 데모 화면이며 실제 API 연결은 후속 작업입니다. API 계약은 [API.md](API.md)를 참고합니다.
