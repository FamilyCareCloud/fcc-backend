import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
const now = '2026-09-10T05:00:00.000Z';
function setup(store = new Store()) {
  const app = createApp(store, { clock: () => now });
  const call = (method, path, body = {}, userId = 'owner') => app({ method, path, body, userId });
  const group = call('POST', '/groups', { elderName: '어르신', name: '보호자' }).body;
  const path = `/groups/${group.id}`;
  call('POST', `${path}/members`, { userId: 'next', name: '다음 보호자' });
  call('POST', `${path}/members`, { userId: 'elder', name: '어르신', role: 'elder' });
  const schedule = call('POST', `${path}/schedules`, { type: 'hospital', title: '내과 진료', scheduledAt: '2026-09-12T10:00:00+09:00' }).body;
  return { call, path, schedule };
}
test('인증과 가족 그룹 및 고령자 쓰기 권한', () => {
  const { call, path } = setup();
  assert.equal(call('GET', path, {}, null).status, 401);
  assert.equal(call('GET', path, {}, 'stranger').status, 404);
  assert.equal(call('POST', `${path}/events`, { type: 'meal', content: '식사' }, 'elder').status, 403);
  assert.equal(call('POST', `${path}/members`, { userId: 'bad', name: 'bad' }, 'next').status, 403);
});
test('기록 시간 정렬, 입력 검증 및 출처 기반 인수인계', () => {
  const { call, path } = setup();
  call('POST', `${path}/events`, { type: 'meal', content: '아침 식사', timestamp: '2026-09-10T08:00:00+09:00' });
  call('POST', `${path}/events`, { type: 'medication', content: '복약 확인', timestamp: '2026-09-10T07:00:00+09:00' });
  const events = call('GET', `${path}/events`).body;
  assert.equal(events[0].type, 'medication');
  assert.equal(call('POST', `${path}/events`, { type: 'meal', content: ' ', timestamp: now }).status, 400);
  assert.equal(call('POST', `${path}/events`, { type: 'meal', content: '미래', timestamp: '2027-01-01T00:00:00Z' }).status, 400);
  const handoff = call('GET', `${path}/handoff`).body;
  assert.equal(handoff.mode, 'extractive');
  assert.equal(handoff.health[0].eventId, events[0].id);
  assert.equal(handoff.life.length, 1);
  assert.equal(call('GET', `${path}/handoff?days=0`).status, 400);
});
test('고령자 요청은 일정을 바꾸지 않고 담당자 승인만 반영', () => {
  const { call, path, schedule } = setup();
  const approval = call('POST', `${path}/approvals`, { scheduleId: schedule.id, action: 'cancel', reason: '방문 취소 요청' }, 'elder').body;
  assert.equal(call('GET', `${path}/schedules`).body[0].status, 'scheduled');
  assert.equal(call('PATCH', `${path}/approvals/${approval.id}`, { decision: 'approve' }, 'next').status, 403);
  assert.equal(call('POST', `${path}/approvals`, { scheduleId: schedule.id, action: 'cancel', reason: '중복' }).status, 409);
  call('PATCH', `${path}/approvals/${approval.id}`, { decision: 'call' });
  assert.equal(call('GET', `${path}/approvals`).body[0].status, 'pending');
  assert.equal(call('PATCH', `${path}/approvals/${approval.id}`, { decision: 'approve' }).status, 200);
  assert.equal(call('GET', `${path}/schedules`).body[0].status, 'cancelled');
  assert.equal(call('PATCH', `${path}/approvals/${approval.id}`, { decision: 'approve' }).status, 409);
});
test('교대 시 미처리 요청 이관 및 이전 보호자 권한 제거', () => {
  const { call, path, schedule } = setup();
  const approval = call('POST', `${path}/approvals`, { scheduleId: schedule.id, action: 'reschedule', proposedAt: '2026-09-13T10:00:00+09:00', reason: '시간 변경' }).body;
  call('PATCH', `${path}/assignment`, { nextCaregiverId: 'next' });
  call('POST', `${path}/handover`);
  assert.equal(call('GET', `${path}/approvals`).body[0].assignedCaregiver, 'next');
  assert.equal(call('PATCH', `${path}/approvals/${approval.id}`, { decision: 'approve' }).status, 403);
  assert.equal(call('PATCH', `${path}/approvals/${approval.id}`, { decision: 'approve' }, 'next').status, 200);
  assert.equal(call('GET', `${path}/schedules`).body[0].scheduledAt, '2026-09-13T01:00:00.000Z');
});
test('일정 완료 이후 과거 변경 요청 승인 차단 및 거절 가능', () => {
  const { call, path, schedule } = setup();
  const approval = call('POST', `${path}/approvals`, { scheduleId: schedule.id, action: 'cancel', reason: '취소' }).body;
  call('PATCH', `${path}/schedules/${schedule.id}`, { status: 'completed' });
  assert.equal(call('PATCH', `${path}/approvals/${approval.id}`, { decision: 'approve' }).status, 409);
  assert.equal(call('PATCH', `${path}/approvals/${approval.id}`, { decision: 'reject' }).status, 200);
});
test('질문 응답은 DB 출처 제공, 취소 발화는 변경하지 않음', () => {
  const { call, path, schedule } = setup();
  assert.equal(call('POST', `${path}/assistant`, { question: '다음 병원 언제야?' }).body.sources[0].scheduleId, schedule.id);
  assert.equal(call('POST', `${path}/assistant`, { question: '약 언제 먹어?' }).body.sources.length, 0);
  assert.equal(call('POST', `${path}/assistant`, { question: '병원 안 갈래' }).body.requiresApproval, true);
  assert.equal(call('GET', `${path}/schedules`).body[0].status, 'scheduled');
});
test('파일 저장 및 재시작 복원', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fcc-test-'));
  try {
    const file = join(dir, 'db.json');
    const { path } = setup(new Store(file));
    const restored = createApp(new Store(file));
    assert.equal(restored({ method: 'GET', path, userId: 'owner' }).body.schedules.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
