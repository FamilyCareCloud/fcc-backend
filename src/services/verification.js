import { HttpError } from '../domain.js';
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest('hex');
export const CODE_VALIDITY_SECONDS = 86400;
export const COOLDOWN_SECONDS = 60;
export const SEND_LIMIT = 5;
export const WINDOW_SECONDS = 3600;
// Cognito symbols: punctuation (ASCII), not whitespace or arbitrary Unicode letters.
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || /\s/.test(password) || !/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(password)) {
    throw authError(400, 'PASSWORD_POLICY_VIOLATION', '비밀번호는 공백 없이 8~128자이며 특수문자를 1개 이상 포함해야 합니다.');
  }
}
export function authError(status, code, message, details = {}) {
  return Object.assign(new HttpError(status, message, code), { details });
}
export class VerificationDelivery {
  constructor(store, clock) { this.store = store; this.clock = clock; }
  key(address) { return `verification#${digest(address)}`; }
  timing(state, now) {
    const attempts = (state?.attempts ?? []).filter(at => at > now - WINDOW_SECONDS * 1000);
    const next = Math.max(now, attempts.length ? attempts.at(-1) + COOLDOWN_SECONDS * 1000 : now, attempts.length >= SEND_LIMIT ? attempts[0] + WINDOW_SECONDS * 1000 : now);
    return { attempts, retryAfterSeconds: Math.ceil((next - now) / 1000), resendAvailableAt: new Date(next).toISOString(), remainingAttempts: Math.max(0, SEND_LIMIT - attempts.length), resendLimit: SEND_LIMIT, resendWindowSeconds: WINDOW_SECONDS, resendCooldownSeconds: COOLDOWN_SECONDS };
  }
  async info(address) {
    const state = await this.store.transaction(tx => tx.get(this.key(address)));
    const { attempts, ...limits } = this.timing(state, Date.parse(this.clock()));
    return { ...limits, codeValiditySeconds: CODE_VALIDITY_SECONDS, codeExpiresAt: state?.acceptedAt ? new Date(Date.parse(state.acceptedAt) + CODE_VALIDITY_SECONDS * 1000).toISOString() : null, deliveryStatus: state?.status ?? 'not_requested' };
  }
  async reserve(address) {
    return this.store.transaction(async tx => {
      const now = Date.parse(this.clock()), state = await tx.get(this.key(address));
      const { attempts, ...limits } = this.timing(state, now);
      if (limits.retryAfterSeconds) throw authError(429, attempts.length >= SEND_LIMIT ? 'CONFIRMATION_SEND_LIMIT' : 'CONFIRMATION_COOLDOWN', '인증코드 재전송 가능 시간 이후 다시 시도해주세요.', limits);
      await tx.set(this.key(address), { ...state, attempts: [...attempts, now], status: 'pending', acceptedAt: null, expiresAtEpoch: Math.ceil((now + 86400000) / 1000) });
    });
  }
  async finish(address, status) {
    await this.store.transaction(async tx => {
      const state = await tx.get(this.key(address));
      await tx.set(this.key(address), { ...state, status, acceptedAt: status === 'accepted' ? this.clock() : null });
    });
    return this.info(address);
  }
}
