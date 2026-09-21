import test from 'node:test';
import assert from 'node:assert/strict';
import * as commands from '@aws-sdk/client-cognito-identity-provider';
import { CognitoAuthService } from '../src/adapters/cognito.js';
import { AuthService } from '../src/services/auth.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { readFileSync } from 'node:fs';
function fixture() {
  let now = Date.parse('2026-09-20T00:00:00Z'), status = null, failure = null;
  const calls = [], logs = [], store = new Store(), clock = () => new Date(now).toISOString();
  const client = { send: async command => {
    calls.push(command);
    if (command instanceof commands.AdminGetUserCommand) {
      if (!status) throw Object.assign(new Error(), { name: 'UserNotFoundException' });
      return { UserStatus: status, Enabled: true };
    }
    if (failure) throw Object.assign(new Error('private AWS message'), { name: failure, $metadata: { requestId: 'test-request' } });
    if (command instanceof commands.SignUpCommand) status = 'UNCONFIRMED';
    if (command instanceof commands.InitiateAuthCommand) throw Object.assign(new Error(), { name: 'UserNotConfirmedException' });
    if (command instanceof commands.ConfirmSignUpCommand) { status = 'CONFIRMED'; return {}; }
    return { UserSub: 'test-user', UserConfirmed: false, CodeDeliveryDetails: { DeliveryMedium: 'EMAIL', Destination: 'u***@e***.com' } };
  } };
  const auth = new CognitoAuthService({ store, clock, client, commands, clientId: 'client', userPoolId: 'pool', logger: entry => logs.push(entry) });
  const app = createApp(store, { clock, auth });
  const call = (route, body) => app({ method: 'POST', path: `/auth/${route}`, body });
  return { auth, app, call, calls, logs, store, clock, advance: seconds => { now += seconds * 1000; }, state: value => { status = value; }, fail: value => { failure = value; } };
}
const account = { email: 'user@example.com', password: 'abcdefgh!', name: '사용자' };
test('인증 개선: 로컬·Cognito는 8자/특수문자 정책, 대소문자·숫자 조합 불필요', async () => {
  for (const password of ['abcdefg!', '1234567!', '!!!!!!!a', 'ABCDEFG!']) {
    const f = fixture(); assert.equal((await f.call('register', { ...account, password })).status, 201);
    const local = new AuthService(new Store(), f.clock); assert.ok((await local.register({ ...account, password })).userId);
  }
  for (const password of ['abcdefg', 'abcdefgh', '12345678', 'ABCDEFGH', 'aaaa aa!', 'a'.repeat(128) + '!']) {
    const f = fixture(), result = await f.call('register', { ...account, password });
    assert.equal(result.status, 400); assert.equal(result.body.code, 'PASSWORD_POLICY_VIOLATION'); assert.equal(f.calls.length, 0);
    await assert.rejects(new AuthService(new Store(), f.clock).register({ ...account, password }), e => e.code === 'PASSWORD_POLICY_VIOLATION');
  }
});
test('인증 개선: 가입 성공은 수신 완료가 아닌 발송 접수·유효시간·제한 정보', async () => {
  const f = fixture(), result = await f.call('register', account);
  assert.equal(result.status, 201); assert.equal(result.body.deliveryStatus, 'accepted');
  assert.equal(result.body.status, 'UNCONFIRMED'); assert.equal(result.body.codeValiditySeconds, 86400);
  assert.equal(result.body.retryAfterSeconds, 60); assert.equal(result.body.remainingAttempts, 4);
  assert.equal(result.body.codeExpiresAt, '2026-09-21T00:00:00.000Z');
});
test('인증 개선: 재가입·로그인은 미인증 상태를 반환하고 메일을 자동 재전송하지 않음', async () => {
  const f = fixture(); await f.call('register', account);
  const duplicate = await f.call('register', account);
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'EMAIL_NOT_VERIFIED');
  assert.equal(duplicate.body.details.nextAction, 'CONFIRM_EMAIL');
  const login = await f.call('login', { email: account.email, password: account.password });
  assert.equal(login.status, 403); assert.equal(login.body.code, 'EMAIL_NOT_VERIFIED');
  assert.equal(f.calls.filter(c => c instanceof commands.SignUpCommand).length, 1);
  assert.equal(f.calls.filter(c => c instanceof commands.ResendConfirmationCodeCommand).length, 0);
});
test('인증 개선: 60초 대기 경계, 1시간 5회, 재시도 시각', async () => {
  const f = fixture(); f.state('UNCONFIRMED');
  assert.equal((await f.call('resend-confirmation', { email: account.email })).status, 200);
  f.advance(59);
  const wait = await f.call('resend-confirmation', { email: account.email });
  assert.equal(wait.status, 429); assert.equal(wait.body.code, 'CONFIRMATION_COOLDOWN'); assert.equal(wait.body.details.retryAfterSeconds, 1);
  f.advance(1);
  for (let i = 0; i < 4; i++) { assert.equal((await f.call('resend-confirmation', { email: account.email })).status, 200); f.advance(60); }
  const limited = await f.call('resend-confirmation', { email: account.email });
  assert.equal(limited.status, 429); assert.equal(limited.body.code, 'CONFIRMATION_SEND_LIMIT');
  assert.equal(limited.body.details.resendAvailableAt, '2026-09-20T01:00:00.000Z');
  f.advance(3300);
  assert.equal((await f.call('resend-confirmation', { email: account.email })).status, 200);
});
test('인증 개선: 병렬 재전송은 한 번만 발송, 재시작해도 제한 유지', async () => {
  const f = fixture(); f.state('UNCONFIRMED');
  const results = await Promise.all(Array.from({ length: 8 }, () => f.call('resend-confirmation', { email: account.email })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(f.calls.filter(c => c instanceof commands.ResendConfirmationCodeCommand).length, 1);
  const restarted = new CognitoAuthService({ store: f.store, clock: f.clock, commands, clientId: 'client', userPoolId: 'pool', logger: () => {}, client: { send: async () => ({ UserStatus: 'UNCONFIRMED' }) } });
  await assert.rejects(restarted.resend({ email: account.email }), e => e.code === 'CONFIRMATION_COOLDOWN');
});
test('인증 개선: 없는 계정·인증 완료 계정은 메일 미발송', async () => {
  const f = fixture();
  assert.equal((await f.call('resend-confirmation', { email: account.email })).body.code, 'ACCOUNT_NOT_FOUND');
  f.state('CONFIRMED');
  assert.equal((await f.call('resend-confirmation', { email: account.email })).body.code, 'ACCOUNT_ALREADY_CONFIRMED');
  assert.equal((await f.call('register', account)).body.code, 'ACCOUNT_ALREADY_EXISTS');
  assert.equal(f.calls.filter(c => c instanceof commands.ResendConfirmationCodeCommand).length, 0);
});
test('인증 개선: 코드 형식·불일치·만료·정상 확인 응답 구분', async () => {
  const f = fixture(); f.state('UNCONFIRMED');
  assert.equal((await f.call('confirm', { email: account.email, code: 'abc' })).body.code, 'CONFIRMATION_CODE_INVALID');
  for (const [name, code] of [['CodeMismatchException', 'CONFIRMATION_CODE_MISMATCH'], ['ExpiredCodeException', 'CONFIRMATION_CODE_EXPIRED']]) {
    f.fail(name); assert.equal((await f.call('confirm', { email: account.email, code: '123456' })).body.code, code);
  }
  f.fail(null); assert.equal((await f.call('confirm', { email: account.email, code: '123456' })).body.nextAction, 'LOGIN');
});
test('인증 개선: 발송 실패·설정 오류·제한은 성공 아님, 민감정보 로그 미포함', async () => {
  for (const [name, code, status] of [['CodeDeliveryFailureException', 'CONFIRMATION_DELIVERY_FAILED', 502], ['InvalidEmailRoleAccessPolicyException', 'EMAIL_CONFIGURATION_ERROR', 503], ['LimitExceededException', 'AUTH_PROVIDER_LIMIT', 429], ['TooManyRequestsException', 'AUTH_PROVIDER_THROTTLED', 429]]) {
    const f = fixture(); f.state('UNCONFIRMED'); f.fail(name);
    const response = await f.call('resend-confirmation', { email: account.email });
    assert.equal(response.status, status); assert.equal(response.body.code, code);
    assert.equal(response.body.details.deliveryStatus, 'failed'); assert.equal(response.body.details.retryAfterSeconds, 60);
    assert.ok(!JSON.stringify(f.logs).includes(account.email)); assert.ok(!JSON.stringify(f.logs).includes(account.password));
    assert.ok(!JSON.stringify(response).includes('private AWS message'));
  }
});
test('인증 개선: CodeDeliveryDetails 없는 공급자 응답은 성공 안내 금지', async () => {
  const f = fixture(); f.auth.client = { send: async c => c instanceof commands.AdminGetUserCommand ? { UserStatus: 'UNCONFIRMED' } : {} };
  const result = await f.call('resend-confirmation', { email: account.email });
  assert.equal(result.status, 502); assert.equal(result.body.code, 'CONFIRMATION_DELIVERY_UNCONFIRMED');
});
test('인증 개선: 로컬 재전송 API는 가짜 발송 성공을 반환하지 않음', async () => {
  const result = await createApp(new Store())({ method: 'POST', path: '/auth/resend-confirmation', body: { email: account.email } });
  assert.equal(result.status, 400); assert.equal(result.body.code, 'EMAIL_VERIFICATION_NOT_SUPPORTED');
});
test('인증 개선: Cognito 정책과 풀 조회 최소 권한 템플릿', () => {
  const template = readFileSync('infra/template.yaml', 'utf8');
  for (const expected of ['MinimumLength: 8', 'RequireLowercase: false', 'RequireUppercase: false', 'RequireNumbers: false', 'RequireSymbols: true', 'COGNITO_USER_POOL_ID: !Ref UserPool', 'cognito-idp:AdminGetUser']) assert.ok(template.includes(expected));
});
