import { randomUUID } from 'node:crypto';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const string = (value, name, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${name}: 올바른 문자열이 필요합니다.`);
  return value.trim();
};
const date = (value, name) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, `${name}: 시간대가 포함된 ISO 날짜가 필요합니다.`);
  return new Date(value).toISOString();
};
const choice = (value, values, name) => values.includes(value) ? value : fail(400, `${name}: ${values.join(', ')} 중 선택하세요.`);
const types = ['hospital', 'meal', 'medication', 'homecoming', 'care_center', 'observation'];
const byTime = (key) => (a, b) => a[key].localeCompare(b[key]) || a.id.localeCompare(b.id);

// Identity must come from a trusted transport, never a request body.
export function createApp(store, { clock = () => new Date().toISOString() } = {}) {
  return function handle({ method, path, userId, body = {} }) {
    try {
      if (method === 'GET' && path === '/health') return { status: 200, body: { status: 'ok' } };
      if (!userId) fail(401, '인증이 필요합니다.');
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'JSON 객체가 필요합니다.');
      const url = new URL(path, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const now = clock();
      const result = store.transaction(({ groups }) => {
        if (parts.length === 1 && parts[0] === 'groups') {
          if (method === 'GET') return Object.values(groups).filter(g => g.members.some(m => m.userId === userId)).map(({ events, schedules, approvals, ...g }) => g);
          if (method === 'POST') {
            const id = randomUUID();
            return groups[id] = { id, elder: { id: randomUUID(), name: string(body.elderName, 'elderName', 100) }, members: [{ userId, name: string(body.name, 'name', 100), role: 'owner' }], primaryCaregiverId: userId, nextCaregiverId: null, assignments: [{ userId, startedAt: now }], events: [], schedules: [], approvals: [] };
          }
        }
        if (parts[0] !== 'groups' || parts.length < 2 || parts.length > 4) fail(404, '경로를 찾을 수 없습니다.');
        const g = groups[parts[1]];
        if (!g || !g.members.some(m => m.userId === userId)) fail(404, '그룹을 찾을 수 없습니다.');
        const member = g.members.find(m => m.userId === userId);
        const resource = parts[2], id = parts[3];
        const caregiver = value => g.members.some(m => m.userId === value && m.role !== 'elder') ? value : fail(400, '그룹 보호자를 지정하세요.');
        const protect = () => { if (member.role === 'elder') fail(403, '보호자 권한이 필요합니다.'); };
        const responsible = () => { if (g.primaryCaregiverId !== userId) fail(403, '현재 담당 보호자만 처리할 수 있습니다.'); };
        const event = (type, content) => g.events.push({ id: randomUUID(), type, content, timestamp: now, createdAt: now, createdBy: userId, source: 'system' });
        if (!resource && method === 'GET') return g;
        if (resource === 'members' && !id && method === 'POST') {
          if (member.role !== 'owner') fail(403, '그룹 소유자 권한이 필요합니다.');
          const newId = string(body.userId, 'userId', 200);
          if (g.members.some(m => m.userId === newId)) fail(409, '이미 등록된 구성원입니다.');
          const added = { userId: newId, name: string(body.name, 'name', 100), role: choice(body.role ?? 'caregiver', ['caregiver', 'elder'], 'role') };
          g.members.push(added); return added;
        }
        if (resource === 'assignment' && !id && method === 'PATCH') {
          responsible();
          g.nextCaregiverId = body.nextCaregiverId === null ? null : caregiver(body.nextCaregiverId);
          return { primaryCaregiverId: g.primaryCaregiverId, nextCaregiverId: g.nextCaregiverId };
        }
        if (resource === 'handover' && !id && method === 'POST') {
          responsible();
          if (!g.nextCaregiverId || g.nextCaregiverId === userId) fail(409, '다음 보호자를 먼저 지정하세요.');
          g.assignments.at(-1).endedAt = now;
          g.primaryCaregiverId = g.nextCaregiverId; g.nextCaregiverId = null;
          g.assignments.push({ userId: g.primaryCaregiverId, startedAt: now });
          for (const approval of g.approvals.filter(a => a.status === 'pending')) approval.assignedCaregiver = g.primaryCaregiverId;
          event('handover', `담당 보호자 교대: ${g.primaryCaregiverId}`);
          return { primaryCaregiverId: g.primaryCaregiverId, assignments: g.assignments };
        }
        if (resource === 'events' && !id) {
          if (method === 'GET') {
            const from = url.searchParams.has('from') ? date(url.searchParams.get('from'), 'from') : '';
            const to = url.searchParams.has('to') ? date(url.searchParams.get('to'), 'to') : '9999';
            if (from > to) fail(400, '기간이 올바르지 않습니다.');
            const type = url.searchParams.get('type');
            return g.events.filter(e => e.timestamp >= from && e.timestamp <= to && (!type || e.type === type)).sort(byTime('timestamp'));
          }
          if (method === 'POST') {
            protect();
            const record = { id: randomUUID(), type: choice(body.type, types, 'type'), content: string(body.content, 'content'), timestamp: date(body.timestamp ?? now, 'timestamp'), createdAt: now, createdBy: userId, source: 'caregiver' };
            if (record.timestamp > now) fail(400, '돌봄 기록은 미래에 작성할 수 없습니다.');
            g.events.push(record); return record;
          }
        }
        if (resource === 'schedules') {
          if (!id && method === 'GET') return [...g.schedules].sort(byTime('scheduledAt'));
          if (!id && method === 'POST') {
            protect();
            const schedule = { id: randomUUID(), title: string(body.title, 'title', 200), type: choice(body.type, ['hospital', 'visit', 'care_center', 'medication', 'other'], 'type'), scheduledAt: date(body.scheduledAt, 'scheduledAt'), caregiverId: caregiver(body.caregiverId ?? g.primaryCaregiverId), status: 'scheduled', version: 1, createdBy: userId };
            g.schedules.push(schedule); event('schedule', `일정 등록: ${schedule.title}`); return schedule;
          }
          if (id && method === 'PATCH') {
            responsible();
            const schedule = g.schedules.find(s => s.id === id) ?? fail(404, '일정을 찾을 수 없습니다.');
            if (body.status !== 'completed' || Object.keys(body).some(k => k !== 'status')) fail(400, '완료 처리만 가능합니다. 변경·취소는 승인 요청을 사용하세요.');
            if (schedule.status !== 'scheduled') fail(409, '종료된 일정입니다.');
            schedule.status = 'completed'; schedule.version++; event('schedule', `일정 완료: ${schedule.title}`); return schedule;
          }
        }
        if (resource === 'approvals') {
          if (!id && method === 'GET') return g.approvals;
          if (!id && method === 'POST') {
            const schedule = g.schedules.find(s => s.id === body.scheduleId) ?? fail(404, '일정을 찾을 수 없습니다.');
            if (schedule.status !== 'scheduled') fail(409, '종료된 일정입니다.');
            if (g.approvals.some(a => a.scheduleId === schedule.id && a.status === 'pending')) fail(409, '처리 대기 중인 요청이 있습니다.');
            const action = choice(body.action, ['cancel', 'reschedule'], 'action');
            const approval = { id: randomUUID(), scheduleId: schedule.id, scheduleVersion: schedule.version, requestedAction: action, proposedAt: action === 'reschedule' ? date(body.proposedAt, 'proposedAt') : null, reason: string(body.reason, 'reason'), requestedBy: userId, assignedCaregiver: g.primaryCaregiverId, status: 'pending', createdAt: now };
            g.approvals.push(approval); event('approval', `일정 승인 요청: ${schedule.title}`); return approval;
          }
          if (id && method === 'PATCH') {
            responsible();
            const approval = g.approvals.find(a => a.id === id) ?? fail(404, '요청을 찾을 수 없습니다.');
            if (approval.status !== 'pending') fail(409, '이미 처리된 요청입니다.');
            const decision = choice(body.decision, ['approve', 'reject', 'call'], 'decision');
            if (decision === 'call') { approval.contactRequestedAt = now; return approval; }
            const schedule = g.schedules.find(s => s.id === approval.scheduleId);
            if (decision === 'approve') {
              if (schedule.status !== 'scheduled' || schedule.version !== approval.scheduleVersion) fail(409, '일정이 변경되어 승인할 수 없습니다. 요청을 거절하고 다시 생성하세요.');
              if (approval.requestedAction === 'cancel') schedule.status = 'cancelled';
              else schedule.scheduledAt = approval.proposedAt;
              schedule.version++;
            }
            approval.status = decision === 'approve' ? 'approved' : 'rejected'; approval.decidedBy = userId; approval.decidedAt = now;
            event('approval', `일정 요청 ${approval.status}: ${schedule.title}`); return approval;
          }
        }
        if (resource === 'handoff' && !id && method === 'GET') {
          const days = Number(url.searchParams.get('days') ?? 7);
          if (!Number.isInteger(days) || days < 1 || days > 30) fail(400, 'days는 1~30 정수입니다.');
          const since = new Date(Date.parse(now) - days * 86400000).toISOString();
          const recent = g.events.filter(e => e.timestamp >= since && e.timestamp <= now).sort(byTime('timestamp'));
          const select = list => recent.filter(e => list.includes(e.type)).map(e => ({ eventId: e.id, content: e.content, timestamp: e.timestamp }));
          return { mode: 'extractive', generatedAt: now, since, health: select(['hospital', 'medication']), life: select(['meal', 'homecoming', 'care_center']), needsAttention: select(['observation']), upcomingSchedules: g.schedules.filter(s => s.status === 'scheduled' && s.scheduledAt >= now).sort(byTime('scheduledAt')), pendingApprovals: g.approvals.filter(a => a.status === 'pending'), primaryCaregiverId: g.primaryCaregiverId, nextCaregiverId: g.nextCaregiverId };
        }
        if (resource === 'assistant' && !id && method === 'POST') {
          const question = string(body.question, 'question', 500);
          if (/취소|변경|안\s*갈/.test(question)) return { mode: 'database', answer: '일정을 선택하여 승인 요청을 등록해주세요. 담당 보호자가 최종 결정합니다.', sources: [], requiresApproval: true };
          const type = /병원|진료/.test(question) ? 'hospital' : /약|복약/.test(question) ? 'medication' : /누가|방문/.test(question) ? 'visit' : null;
          if (!type) return { mode: 'database', answer: '병원, 복약, 방문 일정에 대해 질문해주세요.', sources: [] };
          const today = new Date(Date.parse(now) + 9 * 3600000).toISOString().slice(0, 10);
          const schedule = g.schedules.filter(s => s.type === type && s.status === 'scheduled' && s.scheduledAt >= now && (!/오늘/.test(question) || new Date(Date.parse(s.scheduledAt) + 9 * 3600000).toISOString().slice(0, 10) === today)).sort(byTime('scheduledAt'))[0];
          return { mode: 'database', answer: schedule ? `${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'full', timeStyle: 'short' }).format(new Date(schedule.scheduledAt))}, ${schedule.title}. 담당 보호자: ${g.members.find(m => m.userId === schedule.caregiverId).name}` : '조건에 맞는 등록된 예정 일정이 없습니다.', sources: schedule ? [{ scheduleId: schedule.id }] : [] };
        }
        fail(404, '경로를 찾을 수 없습니다.');
      });
      return { status: method === 'POST' && !path.includes('/assistant') ? 201 : 200, body: result };
    } catch (error) {
      return { status: error.status ?? 500, body: { error: error.status ? error.message : '서버 오류가 발생했습니다.' } };
    }
  };
}
