# 인증메일 및 초대 코드 변경

- 비밀번호 화면 안내: **공백 없이 8자 이상, 특수문자 1개 이상**. 기존 최소 8자 정책을 유지합니다. 최대 길이는 화면에 표시하지 않습니다. 서버의 내부 128자 제한은 유지됩니다. 프론트의 안내 문구도 이 문구로 변경해주세요.
- 가족 초대 생성 응답: `{ "code": "012345", "token": "012345", "expiresAt": "...", "groupId": "..." }`. 수락 요청은 `POST /invitations/accept`, `{ "code": "012345" }`. 코드 유효시간은 48시간이며 기존 이메일·역할·일회용 검증을 유지합니다. 초대 코드는 직접 공유하며 자동 초대메일은 발송하지 않습니다.
- 가입·재전송 인증메일: 브랜드 제목, 테두리 카드, 크게 표시한 코드, 24시간 유효 안내 및 보안 안내를 제공합니다. [미리보기](auth-email-preview.html)는 예시 코드입니다. 실제 코드는 Cognito의 `{####}` 치환을 사용합니다.

## AWS 설정

1. Cognito 사용자 풀과 같은 리전에서 SES 발신 이메일 또는 도메인을 인증합니다.
2. SES 샌드박스에서는 수신자도 인증해야 합니다. 일반 사용자에게 보내려면 해당 리전에서 SES 프로덕션 액세스를 준비합니다. 발송 한도와 SES의 Cognito 발송 권한도 확인합니다.
3. 기존 SAM 배포 파라미터에 `SesIdentityArn`(인증한 SES identity ARN), `AuthFromEmail`(그 identity에 포함된 발신 주소)을 **함께** 추가하고 배포합니다. 기존 FrontendOrigin과 Bedrock 설정 등은 보존합니다.
4. 발신자 표시명은 템플릿에서 `Family Care Cloud <발신주소>`로 설정됩니다. 가입 및 재전송으로 실제 메일을 수신해 표시명·레이아웃·코드 인증을 확인합니다.

두 파라미터를 생략하면 기존 Cognito 기본 발송이 유지되므로 새 디자인과 표시명은 적용되지 않습니다. 코드 수정만으로 운영 사용자 풀 설정이나 SES 인증이 변경되지는 않습니다. 이 저장소에서는 실제 배포·메일 수신을 확인하지 않았습니다. 수신 여부는 기존 API의 `deliveryStatus: accepted`만으로 보장되지 않습니다.

공식 문서: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-message-customizations.html
