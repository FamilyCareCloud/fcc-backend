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

## GitHub 자동 배포

`.github/workflows/deploy-backend.yml`이 `develop` 푸시 및 PR 병합 시 실행됩니다. 테스트와 SAM 템플릿 검증을 통과해야 기존 `fcc-backend-dev` 스택을 배포합니다. PR에서는 테스트·템플릿 검증만 실행하고 AWS 배포는 하지 않습니다. 실행 중인 배포는 새 커밋이 와도 강제로 중단하지 않습니다.

GitHub Actions의 `Backend CI and deploy`에서 실행 결과를 확인합니다. 배포 후 `/health` 200, 인증 없는 `/me` 401, 프론트 Origin OPTIONS 204와 CORS 헤더까지 검사합니다. 검증 실패 시 실행은 실패로 표시됩니다. 배포 후 검사 실패가 자동으로 이전 버전을 복원하지는 않으므로 원인을 확인하고 이전 정상 커밋으로 되돌리는 커밋을 `develop`에 반영합니다.

AWS 인증은 OIDC를 사용합니다. 장기 액세스 키를 GitHub Secret에 저장하지 않습니다. AWS 역할은 `FamilyCareCloud/fcc-backend`의 `develop` 브랜치만 신뢰합니다.

이 저장소는 GitHub의 immutable subject 형식을 사용합니다. 신뢰 조건은 `repo:FamilyCareCloud@327336139/fcc-backend@1363526646:ref:refs/heads/develop`입니다. 저장소의 실제 형식은 `gh api repos/FamilyCareCloud/fcc-backend/actions/oidc/customization/sub`의 `sub_claim_prefix`로 확인합니다. [GitHub OIDC 공식 설명](https://docs.github.com/en/actions/reference/security/oidc)

저장소 Actions Variables:

| 이름 | 값 |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::055047416353:role/fcc-backend-github-deploy` |
| `SAM_ARTIFACT_BUCKET` | `aws-sam-cli-managed-default-samclisourcebucket-oxjavtgeapap` |

관리자 최초 구성은 `python3 infra/setup-github-oidc.py`로 수행합니다. 계정 확인 후 OIDC 제공자와 배포 역할을 만들며 정책 원문은 `infra/github-deploy-trust.json`, `infra/github-deploy-policy.json`에 있습니다. 이 스크립트는 매 배포에서 실행하지 않습니다.

배포 역할은 기존 Lambda 코드·설정 갱신, 해당 스택의 변경 세트 처리, S3의 `fcc-backend-dev/` 배포 파일에 접근합니다. DB 데이터 조회·삭제, 다른 저장소의 배포, 새 IAM 역할 생성·권한 변경은 허용하지 않습니다. DB·로그인·API Gateway 등의 인프라 변경이 필요하면 필요한 범위를 검토한 뒤 별도 관리 권한으로 배포하거나 정책을 조정해야 합니다. 배포 시 AWS 리소스 사용 비용이 발생합니다.

## 배포 버전과 후속 변경

2026-09-10 첫 배포는 `7255fc023cf050a1c587bb2303225072089616f9`에 OPTIONS 사전 요청 204 응답 수정과 AI 제외 템플릿을 적용한 버전입니다. 이 수정은 브라우저 연결 확인 요청을 허용하며 실제 데이터 요청의 인증은 유지합니다. CORS 헤더는 API Gateway가 지정된 프론트 Origin에만 적용합니다.

이후 GitHub에 추가된 음성 인식 연동 코드는 첫 배포에 포함되지 않았습니다. 자동 배포는 최신 `develop` 소스를 반영하지만, 별도 AI 서버 주소나 모델 호출 권한은 이번 설정에 추가하지 않습니다. 음성·AI 서버 연동은 후속 작업입니다.

## 확인한 범위

- SAM 템플릿 lint·빌드 및 CloudFormation 생성·수정 성공.
- `/health` 200 및 `{"status":"ok"}` 응답.
- 프론트 Origin의 OPTIONS `/groups` 204와 CORS 헤더.
- 인증 없는 `/me` 401.
- 첫 배포 수정본의 로컬 테스트 30개 통과.

실제 이메일 확인을 포함한 회원가입·로그인과 인증 후 DB 저장/조회는 아직 통합 검증하지 않았습니다. 프론트는 별도 배포된 데모 화면이며 실제 API 연결은 후속 작업입니다. API 계약은 [API.md](API.md)를 참고합니다.
