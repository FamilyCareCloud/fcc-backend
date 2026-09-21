// Read-only diagnostic. No emails or configuration changes are issued.
import { CognitoIdentityProviderClient, DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
const userPoolId = process.env.COGNITO_USER_POOL_ID;
if (!userPoolId) { console.error('COGNITO_USER_POOL_ID를 설정하세요. 실제 계정 설정은 아직 확인되지 않았습니다.'); process.exitCode = 1; }
else {
  try {
    const result = await new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? 'ap-northeast-2', maxAttempts: 1 }).send(new DescribeUserPoolCommand({ UserPoolId: userPoolId }), { abortSignal: AbortSignal.timeout(15000) });
    const pool = result.UserPool;
    console.log(JSON.stringify({ passwordPolicy: pool.Policies?.PasswordPolicy, autoVerifiedAttributes: pool.AutoVerifiedAttributes, emailSendingAccount: pool.EmailConfiguration?.EmailSendingAccount ?? 'COGNITO_DEFAULT', sesIdentityConfigured: Boolean(pool.EmailConfiguration?.SourceArn), configurationSetConfigured: Boolean(pool.EmailConfiguration?.ConfigurationSet), verificationMethod: pool.VerificationMessageTemplate?.DefaultEmailOption ?? 'CONFIRM_WITH_CODE', customMessageEnabled: Boolean(pool.LambdaConfig?.CustomMessage), note: '구성 조회만 수행했습니다. SES 반송·수신함 도착·발송 할당량은 별도 확인이 필요합니다.' }, null, 2));
  } catch (error) { console.error(JSON.stringify({ error: 'AWS 설정을 확인하지 못했습니다.', providerCode: error.name, requestId: error.$metadata?.requestId ?? null })); process.exitCode = 1; }
}
