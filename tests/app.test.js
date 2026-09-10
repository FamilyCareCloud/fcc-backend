import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { createHttpServer } from '../src/handlers/http.js';
import { createLambdaHandler } from '../src/handlers/lambda.js';
const now = '2026-09-10T05:00:00.000Z';
const password = 'FamilyCare!12345';
async function fixture(options = {}) {
  const store = options.store ?? new Store();
  const app = createApp(store, { clock: () => now, ...options });
  const request = (method, path, body = {}, token) => app({ method, path, body, token });
  async function signup(address, name) {
    const registered = await request('POST', '/auth/register', { email: address, name, password });
    assert.equal(registered.status, 201, JSON.stringify(registered));
    const login = await request('POST', '/auth/login', { email: address, password });
    assert.equal(login.status, 200);
    return { ...registered.body, token: login.body.accessToken };
  }
  const owner = await signup('owner@example.com', '현재 보호자');
  const next = await signup('next@example.com', '다음 보호자');
  const call = (method, path, body = {}, user = owner) => request(method, path, body, user?.token);
  const group = (await call('POST', '/groups', { name: '우리 가족', elderName: '어르신' })).body;
  const p = `/groups/${group.id}`;
  const invite = await call('POST', `${p}/invitations`, { email: next.email });
  assert.equal((await call('POST', '/invitations/accept', { token: invite.body.token }, next)).status, 200);
  return { store, app, call, signup, owner, next, p, group };
}
const makeEvent = (f, body = {}) => f.call('POST', `${f.p}/events`, { type: 'meal', content: '아침 식사 절반 섭취', timestamp: '2026-09-10T08:00:00+09:00', ...body });
const makeSchedule = (f, body = {}) => f.call('POST', `${f.p}/schedules`, { title: '내과 진료', type: 'hospital', scheduledAt: '2026-09-12T10:00:00+09:00', ...body });

test('회원 가입·로그인·프로필 수정·로그아웃 및 비밀번호 비노출', async () => {
  const f = await fixture();
  assert.equal(f.owner.passwordHash, undefined);
  assert.equal((await f.call('PATCH', '/me', { name: '새 이름' })).body.name, '새 이름');
  assert.equal((await f.call('GET', '/me')).body.name, '새 이름');
  assert.equal((await f.call('POST', '/auth/register', { name: '중복', email: f.owner.email.toUpperCase(), password })).status, 409);
  assert.equal((await f.call('POST', '/auth/logout')).status, 200);
  assert.equal((await f.call('GET', '/me')).status, 401);
});
test('로그인 실패 잠금과 만료된 세션 차단', async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) assert.equal((await f.call('POST', '/auth/login', { email: f.next.email, password: 'wrong' })).status, 401);
  assert.equal((await f.call('POST', '/auth/login', { email: f.next.email, password })).status, 429);
  const later = createApp(f.store, { clock: () => '2026-09-11T05:00:00.000Z' });
  assert.equal((await later({ method: 'GET', path: '/me', token: f.owner.token })).status, 401);
});
test('다른 가족 접근 차단 및 본문 작성자 위조 방지', async () => {
  const f = await fixture(), outsider = await f.signup('outsider@example.com', '다른 가족');
  assert.equal((await f.call('GET', f.p, {}, outsider)).status, 404);
  assert.equal((await f.call('GET', f.p, {}, null)).status, 401);
  assert.equal((await makeEvent(f, { createdBy: 'fake' })).status, 400);
  assert.equal((await f.call('GET', '/groups', {}, outsider)).body.length, 0);
});
test('이메일 지정·일회용 초대, 구성원 실시간 프로필 조회', async () => {
  const f = await fixture(), third = await f.signup('third@example.com', '세번째');
  const invite = (await f.call('POST', `${f.p}/invitations`, { email: third.email })).body;
  assert.equal((await f.call('POST', '/invitations/accept', { token: invite.token }, f.next)).status, 403);
  assert.equal((await f.call('POST', '/invitations/accept', { token: invite.token }, third)).status, 200);
  assert.equal((await f.call('POST', '/invitations/accept', { token: invite.token }, third)).status, 404);
  await f.call('PATCH', '/me', { name: '변경 이름' }, third);
  assert.equal((await f.call('GET', `${f.p}/members`)).body.find(m => m.userId === third.userId).name, '변경 이름');
  assert.equal((await f.call('POST', `${f.p}/invitations`, { email: 'other@example.com' }, f.next)).status, 403);
});
test('그룹 생성 후 고령자 별도 등록·수정·조회', async () => {
  const f = await fixture();
  const group = (await f.call('POST', '/groups', { name: '두번째 그룹' })).body;
  const p = `/groups/${group.id}`;
  assert.equal((await f.call('POST', `${p}/events`, { type: 'meal', content: '식사' })).status, 409);
  assert.equal((await f.call('POST', `${p}/elder`, { name: '어르신', birthDate: '1940-01-01', note: '기본 특이사항' })).status, 201);
  assert.equal((await f.call('PATCH', `${p}/elder`, { note: '변경' })).body.note, '변경');
  assert.equal((await f.call('PATCH', `${p}/elder`, { birthDate: '2026-02-30' })).status, 400);
  assert.equal((await f.call('GET', `${p}/elder`)).body.birthDate, '1940-01-01');
});
test('탈퇴는 배정 해제 후 가능하며 탈퇴 후 접근 차단', async () => {
  const f = await fixture();
  await f.call('PATCH', `${f.p}/assignment`, { nextCaregiverId: f.next.userId });
  assert.equal((await f.call('POST', `${f.p}/leave`, {}, f.next)).status, 409);
  await f.call('PATCH', `${f.p}/assignment`, { nextCaregiverId: null });
  assert.equal((await f.call('POST', `${f.p}/leave`, {}, f.next)).status, 200);
  assert.equal((await f.call('GET', f.p, {}, f.next)).status, 404);
  assert.equal((await f.call('GET', '/groups', {}, f.next)).body.length, 0);
  assert.equal((await f.call('POST', `${f.p}/leave`)).status, 409);
});
test('돌봄 기록 CRUD·작성자 권한·시간순 및 유형 조회', async () => {
  const f = await fixture();
  const first = (await makeEvent(f)).body;
  await makeEvent(f, { type: 'medication', content: '복약 확인', timestamp: '2026-09-10T07:00:00+09:00' });
  assert.equal((await f.call('GET', `${f.p}/events`)).body[0].type, 'medication');
  assert.equal((await f.call('GET', `${f.p}/events?type=meal`)).body.length, 1);
  assert.equal((await f.call('PATCH', `${f.p}/events/${first.id}`, { content: '수정' }, f.next)).status, 403);
  assert.equal((await f.call('PATCH', `${f.p}/events/${first.id}`, { content: '식사 전부 섭취', version: 1 })).body.version, 2);
  assert.equal((await f.call('PATCH', `${f.p}/events/${first.id}`, { content: '과거 수정', version: 1 })).status, 409);
  assert.equal((await f.call('DELETE', `${f.p}/events/${first.id}`)).status, 200);
  assert.equal((await f.call('GET', `${f.p}/events/${first.id}`)).status, 404);
});
test('빈 내용·미래·존재하지 않는 날짜를 저장하지 않음', async () => {
  const f = await fixture();
  assert.equal((await makeEvent(f, { content: ' ' })).status, 400);
  assert.equal((await makeEvent(f, { timestamp: '2027-01-01T00:00:00Z' })).status, 400);
  assert.equal((await makeEvent(f, { timestamp: '2026-02-30T00:00:00Z' })).status, 400);
  assert.equal((await f.call('GET', `${f.p}/events`)).body.length, 0);
});
test('분석 결과 저장 및 수정 시 이전 분석 무효화', async () => {
  const f = await fixture();
  const event = (await makeEvent(f, { type: undefined, content: '오늘 내과 다녀왔고 다음에는 피검사 한대.' })).body;
  assert.equal(event.type, 'hospital'); assert.equal(event.analysis.mode, 'local-rules');
  assert.ok(event.analysis.followUp.length);
  const edited = await f.call('PATCH', `${f.p}/events/${event.id}`, { content: '점심 식사 완료' });
  assert.equal(edited.body.analysis, null);
  const reanalyzed = await f.call('POST', `${f.p}/events/${event.id}/analyze`);
  assert.equal(reanalyzed.body.type, 'meal');
});
test('분석 장애 시 수동 유형으로 저장 가능, 유형 없으면 오류와 무저장', async () => {
  const ai = { classifyCareEvent: async () => { throw new Error('offline'); } };
  const f = await fixture({ ai });
  assert.equal((await makeEvent(f, { type: undefined })).status, 502);
  const manual = await makeEvent(f, { analyze: true });
  assert.equal(manual.status, 201); assert.ok(manual.body.warning);
  assert.equal((await f.call('GET', `${f.p}/events`)).body.length, 1);
});
test('일정 수정·직접 취소·검사 유형·삭제 및 한국 시간 오늘/다음 조회', async () => {
  const f = await fixture();
  const s = (await makeSchedule(f, { type: 'examination', scheduledAt: '2026-09-10T15:00:00+09:00' })).body;
  assert.equal((await f.call('GET', `${f.p}/schedules?view=today`)).body.length, 1);
  assert.equal((await f.call('GET', `${f.p}/schedules?view=next`)).body[0].id, s.id);
  assert.equal((await f.call('PATCH', `${f.p}/schedules/${s.id}`, { title: '검사 변경', caregiverId: f.next.userId }, f.next)).status, 200);
  assert.equal((await f.call('PATCH', `${f.p}/schedules/${s.id}`, { status: 'cancelled' }, f.next)).body.status, 'cancelled');
  assert.equal((await f.call('GET', `${f.p}/schedules`)).body.length, 1);
  assert.equal((await f.call('GET', `${f.p}/schedules?view=next`)).body.length, 0);
  await f.call('DELETE', `${f.p}/schedules/${s.id}`);
  assert.equal((await f.call('GET', `${f.p}/schedules`)).body.length, 0);
});
test('기록 없는 인수인계는 오류, 생성 결과·근거·기간·재생성 이력 보존', async () => {
  const f = await fixture();
  assert.equal((await f.call('POST', `${f.p}/handoffs`)).body.code, 'NO_CARE_EVENTS');
  const e = (await makeEvent(f)).body;
  const h = (await f.call('POST', `${f.p}/handoffs`, { fromDate: '2026-09-09T00:00:00Z', toDate: now, toCaregiverId: f.next.userId })).body;
  assert.equal(h.lifeSummary, e.content); assert.equal(h.sourceEvents[0].id, e.id);
  assert.equal(h.fromDate, '2026-09-09T00:00:00.000Z');
  await f.call('PATCH', `${f.p}/events/${e.id}`, { content: '식사 전부 섭취' });
  const regenerated = (await f.call('POST', `${f.p}/handoffs/${h.id}/regenerate`)).body;
  assert.equal(regenerated.regeneratesId, h.id); assert.notEqual(regenerated.id, h.id);
  assert.equal((await f.call('GET', `${f.p}/handoffs/${h.id}`)).body.lifeSummary, e.content);
  assert.equal((await f.call('GET', `${f.p}/handoffs/latest`)).body.id, regenerated.id);
  assert.equal((await f.call('GET', `${f.p}/handoffs`)).body.length, 2);
});
test('인수인계 확인은 지정 보호자만 가능하며 중복 확인은 한 번 기록', async () => {
  const f = await fixture(); await makeEvent(f);
  const h = (await f.call('POST', `${f.p}/handoffs`, { toCaregiverId: f.next.userId })).body;
  assert.equal((await f.call('POST', `${f.p}/handoffs/${h.id}/acknowledge`)).status, 403);
  await f.call('POST', `${f.p}/handoffs/${h.id}/acknowledge`, {}, f.next);
  assert.equal((await f.call('POST', `${f.p}/handoffs/${h.id}/acknowledge`, {}, f.next)).body.acknowledgements.length, 1);
});
test('교대 시 인수인계 생성, 기록 없을 때 교대만 진행', async () => {
  const f = await fixture();
  const first = await f.call('POST', `${f.p}/handover`, { nextCaregiverId: f.next.userId });
  assert.equal(first.status, 200); assert.equal(first.body.handoff, null);
  await makeEvent(f);
  const second = await f.call('POST', `${f.p}/handover`, { nextCaregiverId: f.owner.userId }, f.next);
  assert.equal(second.body.handoff.fromCaregiverId, f.next.userId);
  assert.equal(second.body.handoff.toCaregiverId, f.owner.userId);
  assert.equal(second.body.history.length, 3);
});
test('AI 장애 시 교대와 생성 결과 롤백, 원본 기록 유지', async () => {
  const f = await fixture({ ai: { summarizeCareEvents: async () => { throw new Error('timeout'); } } });
  await makeEvent(f);
  assert.equal((await f.call('POST', `${f.p}/handover`, { nextCaregiverId: f.next.userId })).status, 502);
  const g = (await f.call('GET', f.p)).body;
  assert.equal(g.primaryCaregiverId, f.owner.userId); assert.equal(g.assignments.length, 1);
  assert.equal(g.events.length, 1); assert.equal(g.handoffs.length, 0);
});
test('고령자 일정 직접 수정 차단, 승인 중복·이전 버전 방지', async () => {
  const f = await fixture(), elder = await f.signup('elder@example.com', '고령자');
  const invite = (await f.call('POST', `${f.p}/invitations`, { email: elder.email, role: 'elder' })).body;
  await f.call('POST', '/invitations/accept', { token: invite.token }, elder);
  const s = (await makeSchedule(f)).body;
  assert.equal((await f.call('PATCH', `${f.p}/schedules/${s.id}`, { status: 'cancelled' }, elder)).status, 403);
  const request = { scheduleId: s.id, action: 'cancel', reason: '취소 요청' };
  const approval = (await f.call('POST', `${f.p}/approvals`, request, elder)).body;
  assert.equal((await f.call('POST', `${f.p}/approvals`, request, elder)).status, 409);
  assert.equal((await f.call('PATCH', `${f.p}/approvals/${approval.id}`, { decision: 'approve' }, f.next)).status, 403);
  await f.call('PATCH', `${f.p}/schedules/${s.id}`, { status: 'completed' });
  assert.equal((await f.call('PATCH', `${f.p}/approvals/${approval.id}`, { decision: 'approve' })).status, 409);
  assert.equal((await f.call('PATCH', `${f.p}/approvals/${approval.id}`, { decision: 'reject' })).status, 200);
});
test('동시 요청에서도 모든 기록 유지', async () => {
  const f = await fixture();
  const responses = await Promise.all(Array.from({ length: 10 }, (_, n) => makeEvent(f, { content: `식사 ${n}` })));
  assert.ok(responses.every(r => r.status === 201));
  assert.equal((await f.call('GET', `${f.p}/events`)).body.length, 10);
});
test('파일 재시작 복원, 조회는 파일을 다시 쓰지 않음', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fcc-v2-test-'));
  try {
    const file = join(dir, 'db.json'), f = await fixture({ store: new Store(file) });
    await makeEvent(f);
    const before = readFileSync(file, 'utf8');
    const restarted = createApp(new Store(file), { clock: () => now });
    const result = await restarted({ method: 'GET', path: `${f.p}/events`, token: f.owner.token });
    assert.equal(result.body.length, 1); assert.equal(readFileSync(file, 'utf8'), before);
    assert.ok(!before.includes(password)); assert.ok(!before.includes(f.owner.token));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('실제 HTTP 로그인 흐름과 Lambda 요청 변환', async () => {
  const app = createApp(new Store());
  const server = createHttpServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/me`)).status, 401);
    const reg = await fetch(`${base}/auth/register`, { method: 'POST', body: JSON.stringify({ name: 'HTTP 사용자', email: 'http@example.com', password }) });
    assert.equal(reg.status, 201);
    const login = await (await fetch(`${base}/auth/login`, { method: 'POST', body: JSON.stringify({ email: 'http@example.com', password }) })).json();
    const me = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${login.accessToken}` } });
    assert.equal((await me.json()).name, 'HTTP 사용자');
    assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', body: '{bad' })).status, 400);
    const lambda = createLambdaHandler(app);
    const response = await lambda({ rawPath: '/me', requestContext: { http: { method: 'GET' } }, headers: { authorization: `Bearer ${login.accessToken}` } });
    assert.equal(response.statusCode, 200);
    assert.equal((await lambda({ rawPath: '/me', body: '{bad', requestContext: { http: { method: 'GET' } } })).statusCode, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('교대 후 대기 승인 이관·승인 반영·중복 승인 차단', async () => {
  const f = await fixture(), schedule = (await makeSchedule(f)).body;
  const approval = (await f.call('POST', `${f.p}/approvals`, { scheduleId: schedule.id, action: 'reschedule', proposedAt: '2026-09-13T10:00:00+09:00', reason: '일정 변경' })).body;
  await f.call('POST', `${f.p}/handover`, { nextCaregiverId: f.next.userId });
  assert.equal((await f.call('GET', `${f.p}/approvals`)).body[0].assignedCaregiver, f.next.userId);
  assert.equal((await f.call('PATCH', `${f.p}/approvals/${approval.id}`, { decision: 'approve' })).status, 403);
  assert.equal((await f.call('PATCH', `${f.p}/approvals/${approval.id}`, { decision: 'approve' }, f.next)).status, 200);
  assert.equal((await f.call('GET', `${f.p}/schedules/${schedule.id}`)).body.scheduledAt, '2026-09-13T01:00:00.000Z');
  assert.equal((await f.call('PATCH', `${f.p}/approvals/${approval.id}`, { decision: 'approve' }, f.next)).status, 409);
});
test('소유권 이전 이후 탈퇴와 새 소유자 초대 권한', async () => {
  const f = await fixture();
  await f.call('POST', `${f.p}/handover`, { nextCaregiverId: f.next.userId });
  assert.equal((await f.call('PATCH', `${f.p}/ownership`, { userId: f.next.userId })).status, 200);
  assert.equal((await f.call('POST', `${f.p}/leave`)).status, 200);
  assert.equal((await f.call('POST', `${f.p}/invitations`, { email: 'new@example.com' }, f.next)).status, 201);
  assert.equal((await f.call('GET', f.p)).status, 404);
});
test('저장 실패 시 그룹 생성과 사용자 멤버십을 함께 롤백', async () => {
  const f = await fixture();
  const original = f.store.transaction.bind(f.store);
  f.store.transaction = action => original(tx => action({ ...tx, set: async (key, value) => { if (key.startsWith('group#')) throw new Error('simulated disk failure'); return tx.set(key, value); } }));
  assert.equal((await f.call('POST', '/groups', { name: '실패 그룹' })).status, 500);
  f.store.transaction = original;
  assert.equal((await f.call('GET', '/groups')).body.length, 1);
});
