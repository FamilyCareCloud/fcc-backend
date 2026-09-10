import { randomUUID } from 'node:crypto';
import { fields, range, sortBy, fail } from '../domain.js';
import { CareGroupRepository, CareHandoffRepository, CaregiverHistoryRepository } from '../repositories/index.js';
import { requireElder, guardian, systemEvent } from './groups.js';
export class HandoffService {
  constructor(store, clock, ai) { this.store = store; this.clock = clock; this.ai = ai; }
  async generate(group, userId, body, fromCaregiverId, toCaregiverId) {
    const now = this.clock(), period = range(body, now);
    const events = group.events.filter(e => e.source !== 'system' && e.timestamp >= period.fromDate && e.timestamp <= period.toDate).sort(sortBy('timestamp'));
    if (!events.length) fail(422, '요약할 돌봄 기록이 없습니다.', 'NO_CARE_EVENTS');
    const schedules = group.schedules.filter(s => !s.deletedAt && s.status === 'scheduled' && s.scheduledAt >= now).sort(sortBy('scheduledAt'));
    let output;
    try { output = await this.ai.summarizeCareEvents(events, schedules); }
    catch (error) { if (error.status === 413) throw error; fail(502, '인수인계 생성에 실패했습니다. 다시 시도해 주세요.', 'HANDOFF_GENERATION_FAILED'); }
    const handoff = {
      id: randomUUID(), elderId: group.elder.id, fromCaregiverId, toCaregiverId,
      ...period, createdAt: now, createdBy: userId, mode: output.mode, modelId: output.modelId ?? null,
      ...Object.fromEntries(Object.entries(output.sections).map(([key, items]) => [key, items.map(item => item.text).join('\n')])),
      evidence: output.sections,
      sourceEvents: events.map(({ id, version, content, timestamp, type }) => ({ id, version, content, timestamp, type })),
      sourceSchedules: schedules.map(({ id, version, title, scheduledAt }) => ({ id, version, title, scheduledAt })),
      acknowledgements: [], regeneratesId: body.regeneratesId ?? null
    };
    return new CareHandoffRepository(group).save(handoff);
  }
  async execute(userId, groupId, method, id, action, body) {
    return this.store.transaction(async tx => {
      const groups = new CareGroupRepository(tx), { group } = await groups.forMember(groupId, userId, true);
      requireElder(group);
      const handoffs = new CareHandoffRepository(group);
      if (method === 'GET' && !action) {
        if (id === 'latest') return handoffs.findLatest();
        return id ? handoffs.findById(id) : [...group.handoffs].reverse();
      }
      if (method === 'POST' && action === 'acknowledge' && id) {
        fields(body, []);
        const handoff = handoffs.findById(id);
        if (handoff.toCaregiverId !== userId) fail(403, '지정된 인수 보호자만 확인할 수 있습니다.');
        if (!handoff.acknowledgements.some(a => a.userId === userId)) handoff.acknowledgements.push({ userId, acknowledgedAt: this.clock() });
        await groups.save(group); return handoff;
      }
      if (method !== 'POST' || action && action !== 'regenerate' || id && action !== 'regenerate') fail(404, '경로를 찾을 수 없습니다.');
      fields(body, ['fromDate', 'toDate', 'toCaregiverId']);
      let input = body, fromId = group.primaryCaregiverId, toId = body.toCaregiverId ?? group.nextCaregiverId ?? group.primaryCaregiverId;
      if (id) {
        const original = handoffs.findById(id);
        input = { fromDate: original.fromDate, toDate: original.toDate, ...body, regeneratesId: original.id };
        fromId = original.fromCaregiverId; toId = body.toCaregiverId ?? original.toCaregiverId;
      }
      guardian(group, toId);
      const handoff = await this.generate(group, userId, input, fromId, toId);
      await groups.save(group); return handoff;
    });
  }
  async handover(userId, groupId, body) {
    fields(body, ['nextCaregiverId', 'fromDate', 'toDate']);
    return this.store.transaction(async tx => {
      const groups = new CareGroupRepository(tx), { group } = await groups.forMember(groupId, userId, true);
      requireElder(group);
      if (group.primaryCaregiverId !== userId) fail(403, '현재 담당 보호자만 교대할 수 있습니다.');
      const next = guardian(group, body.nextCaregiverId ?? group.nextCaregiverId);
      if (next === userId) fail(400, '다른 보호자를 선택하세요.');
      const period = range(body, this.clock());
      const hasRecords = group.events.some(e => e.source !== 'system' && e.timestamp >= period.fromDate && e.timestamp <= period.toDate);
      // Generation failure rolls the entire handover back. No records: handover only.
      const handoff = hasRecords ? await this.generate(group, userId, period, userId, next) : null;
      const now = this.clock();
      if (group.assignments.length) group.assignments.at(-1).endedAt = now;
      new CaregiverHistoryRepository(group).save({ id: randomUUID(), elderId: group.elder.id, userId: next, startedAt: now, handoffId: handoff?.id ?? null });
      group.primaryCaregiverId = next; group.nextCaregiverId = null;
      for (const request of group.approvals.filter(a => a.status === 'pending')) request.assignedCaregiver = next;
      systemEvent(group, userId, now, 'handover', `담당 보호자 교대: ${next}`);
      await groups.save(group);
      return { primaryCaregiverId: next, history: group.assignments, handoff, message: handoff ? '교대와 인수인계 생성이 완료되었습니다.' : '요약할 돌봄 기록이 없어 담당 보호자만 변경했습니다.' };
    });
  }
}
