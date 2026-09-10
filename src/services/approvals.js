import { randomUUID } from 'node:crypto';
import { fields, text, choice, date, fail } from '../domain.js';
import { CareGroupRepository, ScheduleRepository } from '../repositories/index.js';
import { systemEvent } from './groups.js';
export class ApprovalService {
  constructor(store, clock) { this.store = store; this.clock = clock; }
  async execute(userId, groupId, method, id, body) {
    return this.store.transaction(async tx => {
      const groups = new CareGroupRepository(tx), { group } = await groups.forMember(groupId, userId), now = this.clock();
      if (method === 'GET' && !id) return group.approvals;
      if (method === 'POST' && !id) {
        fields(body, ['scheduleId', 'action', 'reason', 'proposedAt']);
        const schedule = new ScheduleRepository(group).findById(body.scheduleId);
        if (schedule.status !== 'scheduled' || group.approvals.some(a => a.scheduleId === schedule.id && a.status === 'pending')) fail(409, '종료된 일정이거나 대기 중인 요청이 있습니다.');
        const action = choice(body.action, ['cancel', 'reschedule'], 'action');
        const approval = { id: randomUUID(), scheduleId: schedule.id, scheduleVersion: schedule.version, requestedAction: action, proposedAt: action === 'reschedule' ? date(body.proposedAt, 'proposedAt') : null, reason: text(body.reason, 'reason'), requestedBy: userId, assignedCaregiver: group.primaryCaregiverId, status: 'pending', createdAt: now };
        group.approvals.push(approval); systemEvent(group, userId, now, 'approval', `승인 요청: ${schedule.title}`);
        await groups.save(group); return approval;
      }
      if (method !== 'PATCH' || !id) fail(404, '경로를 찾을 수 없습니다.');
      if (group.primaryCaregiverId !== userId) fail(403, '현재 담당 보호자만 처리할 수 있습니다.');
      fields(body, ['decision']);
      const approval = group.approvals.find(a => a.id === id) ?? fail(404, '요청을 찾을 수 없습니다.');
      if (approval.status !== 'pending') fail(409, '이미 처리된 요청입니다.');
      const decision = choice(body.decision, ['approve', 'reject', 'call'], 'decision');
      if (decision === 'call') { approval.contactRequestedAt = now; await groups.save(group); return approval; }
      const schedule = new ScheduleRepository(group).findById(approval.scheduleId);
      if (decision === 'approve') {
        if (schedule.status !== 'scheduled' || schedule.version !== approval.scheduleVersion) fail(409, '일정이 변경되었습니다. 요청을 거절하고 다시 생성하세요.');
        if (approval.requestedAction === 'cancel') schedule.status = 'cancelled'; else schedule.scheduledAt = approval.proposedAt;
        schedule.version++;
      }
      approval.status = decision === 'approve' ? 'approved' : 'rejected'; approval.decidedAt = now; approval.decidedBy = userId;
      systemEvent(group, userId, now, 'approval', `요청 ${approval.status}: ${schedule.title}`);
      await groups.save(group); return approval;
    });
  }
}
