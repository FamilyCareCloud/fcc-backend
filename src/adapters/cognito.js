import { fields, email, text, fail } from '../domain.js';
import { UserRepository } from '../repositories/index.js';
import { publicUser } from '../services/auth.js';
export class CognitoAuthService {
  constructor({ store, clock, client, commands, clientId }) { Object.assign(this, { store, clock, client, commands, clientId }); }
  async send(name, input) {
    try { return await this.client.send(new this.commands[name](input)); }
    catch (error) {
      if (['NotAuthorizedException', 'UserNotFoundException'].includes(error.name)) fail(401, '로그인 정보가 올바르지 않거나 만료되었습니다.');
      if (error.name === 'UsernameExistsException') fail(409, '이미 가입된 이메일입니다.');
      if (['InvalidPasswordException', 'InvalidParameterException', 'CodeMismatchException', 'ExpiredCodeException', 'UserNotConfirmedException'].includes(error.name)) fail(400, '입력 또는 이메일 인증 상태를 확인하세요.');
      if (['TooManyRequestsException', 'LimitExceededException'].includes(error.name)) fail(429, '잠시 후 다시 시도하세요.');
      fail(503, '인증 서비스에 연결할 수 없습니다.');
    }
  }
  async register(body) {
    fields(body, ['name', 'email', 'password']);
    if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) fail(400, '비밀번호는 12~128자여야 합니다.');
    const result = await this.send('SignUpCommand', { ClientId: this.clientId, Username: email(body.email), Password: body.password, UserAttributes: [{ Name: 'name', Value: text(body.name, 'name', 100) }, { Name: 'email', Value: email(body.email) }] });
    return { userId: result.UserSub, confirmationRequired: !result.UserConfirmed };
  }
  async confirm(body) {
    fields(body, ['email', 'code']);
    await this.send('ConfirmSignUpCommand', { ClientId: this.clientId, Username: email(body.email), ConfirmationCode: text(body.code, 'code', 20) });
    return { confirmed: true };
  }
  async login(body) {
    fields(body, ['email', 'password']);
    if (typeof body.password !== 'string' || body.password.length > 128 || !body.password.length) fail(400, '비밀번호가 필요합니다.');
    const response = await this.send('InitiateAuthCommand', { ClientId: this.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email(body.email), PASSWORD: body.password } });
    if (!response.AuthenticationResult?.AccessToken) fail(401, '추가 인증이 필요합니다.');
    const accessToken = response.AuthenticationResult.AccessToken;
    const userId = await this.authenticate(accessToken);
    return { accessToken, tokenType: 'Bearer', expiresAt: new Date(Date.parse(this.clock()) + response.AuthenticationResult.ExpiresIn * 1000).toISOString(), user: await this.profile(userId, 'GET') };
  }
  async authenticate(token) {
    if (!token || token.length > 8192) fail(401, '로그인이 필요합니다.');
    const result = await this.send('GetUserCommand', { AccessToken: token });
    const attributes = Object.fromEntries(result.UserAttributes.map(a => [a.Name, a.Value]));
    if (!attributes.sub || attributes.email_verified !== 'true') fail(403, '이메일 인증이 필요합니다.');
    await this.store.transaction(async tx => {
      const repo = new UserRepository(tx), existing = await repo.findById(attributes.sub);
      if (!existing) await repo.save({ userId: attributes.sub, email: attributes.email.toLowerCase(), name: attributes.name ?? attributes.email, role: 'caregiver', createdAt: this.clock(), groupIds: [] });
    });
    return attributes.sub;
  }
  async logout(token) { await this.send('GlobalSignOutCommand', { AccessToken: token }); return { loggedOut: true }; }
  async profile(userId, method, body, token) {
    if (method === 'PATCH') {
      fields(body, ['name']);
      await this.send('UpdateUserAttributesCommand', { AccessToken: token, UserAttributes: [{ Name: 'name', Value: text(body.name, 'name', 100) }] });
    }
    return this.store.transaction(async tx => {
      const repo = new UserRepository(tx), user = await repo.findById(userId);
      if (!user) fail(401, '사용자를 찾을 수 없습니다.');
      if (method === 'PATCH') { user.name = text(body.name, 'name', 100); await repo.save(user); }
      return publicUser(user);
    });
  }
}
export async function createCognitoAuth(store, clock, env = process.env) {
  if (!env.COGNITO_CLIENT_ID) throw new Error('COGNITO_CLIENT_ID is required');
  const commands = await import('@aws-sdk/client-cognito-identity-provider');
  return new CognitoAuthService({ store, clock, client: new commands.CognitoIdentityProviderClient({ region: env.AWS_REGION ?? 'ap-northeast-2' }), commands, clientId: env.COGNITO_CLIENT_ID });
}
