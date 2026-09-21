import { randomUUID, randomInt } from 'node:crypto';
import { text, fields, choice, birthDate, fail } from '../domain.js';
import { authError } from './verification.js';
import { digest } from './auth.js';
import { CareGroupRepository, UserRepository } from '../repositories/index.js';
export const requireElder = group => { if (!group.elder) fail(409, '고령자를 먼저 등록하세요.'); };
export const guardian = (group, id) => group.members.some(m => m.userId === id && m.role !== 'elder') ? id : fail(400, '그룹 보호자를 지정하세요.');
export const systemEvent = (group, userId, now, type, content) => group.events.push({ id: randomUUID(), elderId: group.elder?.id ?? null, type, content, timestamp: now, createdAt: now, createdBy: userId, source: 'system', version: 1 });
export class CareGroupService {
  constructor(store, clock) { this.store = store; this.clock = clock; }
  async execute(userId, method, groupId, resource, id, body) {
    return this.store.transaction(async tx => {
      const repo = new CareGroupRepository(tx), users = new UserRepository(tx), now = this.clock();
      const user = await users.findById(userId);
      if (!user) fail(401, '사용자를 찾을 수 없습니다.');
      if (!groupId) {
        if (method === 'GET') {
          const result = [];
          for (const key of user.groupIds) {
            const group = await repo.findById(key);
            if (group?.members.some(m => m.userId === userId)) result.push({ id: group.id, name: group.name, elder: group.elder, primaryCaregiverId: group.primaryCaregiverId, nextCaregiverId: group.nextCaregiverId, createdAt: group.createdAt });
          }
          return result;
        }
        if (method !== 'POST') fail(404, '경로를 찾을 수 없습니다.');
        fields(body, ['name', 'elderName']);
        const group = { id: randomUUID(), name: text(body.name, 'name', 100), elder: body.elderName ? { id: randomUUID(), name: text(body.elderName, 'elderName', 100), birthDate: null, note: '' } : null, createdAt: now, members: [{ memberId: randomUUID(), userId, role: 'owner', joinedAt: now }], primaryCaregiverId: userId, nextCaregiverId: null, assignments: [{ id: randomUUID(), userId, startedAt: now }], events: [], schedules: [], handoffs: [], approvals: [] };
        user.groupIds.push(group.id); await users.save(user); return repo.save(group);
      }
      const { group, member } = await repo.forMember(groupId, userId);
      if (!resource && method === 'GET') return group;
      if (resource === 'members' && !id && method === 'GET') {
        const result = [];
        for (const membership of group.members) {
          const profile = await users.findById(membership.userId);
          result.push({ ...membership, name: profile?.name ?? '(탈퇴 사용자)' });
        }
        return result;
      }
      if (resource === 'leave' && method === 'POST' && !id) {
        fields(body, []);
        if (member.role === 'owner') fail(409, '소유권을 다른 보호자에게 이전한 뒤 탈퇴하세요.');
        if ([group.primaryCaregiverId, group.nextCaregiverId].includes(userId) || group.schedules.some(s => !s.deletedAt && s.status === 'scheduled' && s.caregiverId === userId)) fail(409, '담당 보호자와 예정 일정 담당자를 먼저 변경하세요.');
        group.members = group.members.filter(m => m.userId !== userId);
        user.groupIds = user.groupIds.filter(key => key !== groupId);
        await users.save(user); await repo.save(group); return { left: true };
      }
      if (member.role === 'elder') fail(403, '보호자 권한이 필요합니다.');
      if (resource === 'ownership' && method === 'PATCH' && !id) {
        fields(body, ['userId']);
        if (member.role !== 'owner') fail(403, '소유자 권한이 필요합니다.');
        guardian(group, body.userId);
        if (body.userId === userId) fail(400, '다른 보호자를 선택하세요.');
        member.role = 'caregiver'; group.members.find(m => m.userId === body.userId).role = 'owner';
      } else if (resource === 'invitations' && method === 'POST' && !id) {
        fields(body, ['email', 'role']);
        if (member.role !== 'owner') fail(403, '소유자 권한이 필요합니다.');
        const { email } = await import('../domain.js');
        const address = email(body.email);
        let token;
        for (let attempt = 0; attempt < 20; attempt++) {
          const candidate = String(randomInt(1000000)).padStart(6, '0');
          const existing = await tx.get(`invite#${digest(candidate)}`);
          if (!existing || existing.expiresAt <= now) { token = candidate; break; }
        }
        if (!token) fail(503, '초대 코드를 생성하지 못했습니다. 다시 시도해주세요.', 'INVITATION_CODE_UNAVAILABLE');
        const invitation = { groupId, email: address, role: choice(body.role ?? 'caregiver', ['caregiver', 'elder'], 'role'), createdBy: userId, createdAt: now, expiresAt: new Date(Date.parse(now) + 48 * 3600000).toISOString() };
        await tx.set(`invite#${digest(token)}`, invitation);
        return { code: token, token, expiresAt: invitation.expiresAt, groupId }; // User shares this token; no unsolicited email is sent.
      } else if (resource === 'elder' && !id && ['GET', 'POST', 'PATCH'].includes(method)) {
        if (method === 'GET') { requireElder(group); return group.elder; }
        fields(body, ['name', 'birthDate', 'note']);
        if (method === 'POST' && group.elder) fail(409, '이미 고령자가 등록되어 있습니다.');
        if (method === 'PATCH') requireElder(group);
        const elder = group.elder ?? { id: randomUUID(), birthDate: null, note: '' };
        if (body.name !== undefined || method === 'POST') elder.name = text(body.name, 'name', 100);
        if (body.birthDate !== undefined) elder.birthDate = birthDate(body.birthDate, now);
        if (body.note !== undefined) {
          if (typeof body.note !== 'string' || body.note.length > 2000) fail(400, 'note: 2000자 이하 문자열이 필요합니다.');
          elder.note = body.note;
        }
        group.elder = elder; await repo.save(group); return elder;
      } else if (resource === 'assignment' && !id && method === 'GET') {
        return { primaryCaregiverId: group.primaryCaregiverId, nextCaregiverId: group.nextCaregiverId, history: group.assignments };
      } else if (resource === 'assignment' && !id && method === 'PATCH') {
        fields(body, ['nextCaregiverId']);
        if (group.primaryCaregiverId !== userId) fail(403, '현재 담당 보호자만 지정할 수 있습니다.');
        group.nextCaregiverId = body.nextCaregiverId === null ? null : guardian(group, body.nextCaregiverId);
        if (group.nextCaregiverId === group.primaryCaregiverId) fail(400, '다른 보호자를 선택하세요.');
      } else fail(404, '경로를 찾을 수 없습니다.');
      await repo.save(group);
      return { primaryCaregiverId: group.primaryCaregiverId, nextCaregiverId: group.nextCaregiverId, members: group.members };
    });
  }
  async accept(userId, body) {
    fields(body, ['code', 'token']);
    if (body.code !== undefined && body.token !== undefined && body.code !== body.token) fail(400, 'code와 token이 일치하지 않습니다.');
    const token = text(body.code ?? body.token, 'code', 200);
    if (body.code !== undefined && !/^\d{6}$/.test(token)) fail(400, '초대 코드는 6자리 숫자로 입력해주세요.', 'INVITATION_CODE_INVALID');
    // Reserve attempts separately so failed acceptance also consumes an attempt.
    await this.store.transaction(async tx => {
      const key = `invite-attempt#${userId}`, now = Date.parse(this.clock());
      const state = await tx.get(key);
      const attempts = (state?.attempts ?? []).filter(at => at > now - 15 * 60000);
      if (attempts.length >= 5) {
        const retryAfterSeconds = Math.ceil((attempts[0] + 15 * 60000 - now) / 1000);
        throw authError(429, 'INVITATION_ATTEMPT_LIMIT', '잠시 후 초대 코드를 다시 입력해주세요.', { retryAfterSeconds, retryAvailableAt: new Date(now + retryAfterSeconds * 1000).toISOString() });
      }
      await tx.set(key, { attempts: [...attempts, now], expiresAtEpoch: Math.ceil((now + 15 * 60000) / 1000) });
    });
    return this.store.transaction(async tx => {
      const key = `invite#${digest(token)}`, invitation = await tx.get(key);
      if (!invitation || invitation.expiresAt <= this.clock()) fail(404, '초대가 없거나 만료되었습니다.');
      const users = new UserRepository(tx), user = await users.findById(userId);
      if (!user || user.email !== invitation.email) fail(403, '초대받은 이메일 계정으로 로그인하세요.');
      const repo = new CareGroupRepository(tx), group = await repo.findById(invitation.groupId);
      if (!group?.members.some(m => m.userId === invitation.createdBy && m.role === 'owner')) fail(409, '유효하지 않은 초대입니다.');
      if (group.members.some(m => m.userId === userId)) fail(409, '이미 참여한 그룹입니다.');
      group.members.push({ memberId: randomUUID(), userId, role: invitation.role, joinedAt: this.clock() });
      user.groupIds.push(group.id);
      await users.save(user); await repo.save(group); await tx.delete(key);
      return { groupId: group.id, joined: true };
    });
  }
}
