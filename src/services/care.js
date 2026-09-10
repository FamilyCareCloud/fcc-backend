import { randomUUID } from 'node:crypto';
import { text, fields, date, choice, eventTypes, scheduleTypes, sortBy, dayInSeoul, fail } from '../domain.js';
import { CareGroupRepository, CareEventRepository, ScheduleRepository } from '../repositories/index.js';
import { requireElder, guardian, systemEvent } from './groups.js';
export class CareEventService {
  constructor(store, clock, ai) { this.store = store; this.clock = clock; this.ai = ai; }
  async execute(userId, groupId, method, id, body, query) {
    return this.store.transaction(async tx => {
      const groups = new CareGroupRepository(tx), { group } = await groups.forMember(groupId, userId, method !== 'GET');
      requireElder(group);
      const events = new CareEventRepository(group), now = this.clock();
      if (method === 'GET') {
        if (id) return events.findById(id);
        const from = query.has('from') ? date(query.get('from'), 'from') : '';
        const to = query.has('to') ? date(query.get('to'), 'to') : '9999';
        if (from > to) fail(400, '조회 기간이 올바르지 않습니다.');
        const type = query.get('type');
        if (type) choice(type, [...eventTypes, 'handover', 'approval'], 'type');
        return events.findByDateRange(from, to).filter(e => !type || e.type === type).sort(sortBy('timestamp'));
      }
      if (method === 'POST' && !id) {
        fields(body, ['content', 'type', 'timestamp', 'analyze']);
        const content = text(body.content, 'content');
        if (body.analyze !== undefined && typeof body.analyze !== 'boolean') fail(400, 'analyze: boolean이 필요합니다.');
        let analysis = null, warning = null;
        if (body.analyze === true || body.type === undefined) {
          try { analysis = await this.ai.classifyCareEvent(content); }
          catch { if (body.type === undefined) fail(502, '자동 분류에 실패했습니다. 기록 유형을 직접 선택해주세요.', 'AI_CLASSIFICATION_FAILED'); warning = 'AI 분석에 실패하여 선택한 유형으로 저장했습니다.'; }
        }
        const type = choice(body.type ?? analysis?.type, eventTypes, 'type');
        const timestamp = date(body.timestamp ?? now);
        if (timestamp > now) fail(400, '돌봄 기록은 미래일 수 없습니다.');
        const event = events.save({ id: randomUUID(), elderId: group.elder.id, type, content, timestamp, createdAt: now, createdBy: userId, source: 'caregiver', version: 1, analysis });
        await groups.save(group); return { ...event, ...(warning ? { warning } : {}) };
      }
      if (!id) fail(404, '경로를 찾을 수 없습니다.');
      const event = events.findById(id);
      if (event.source === 'system') fail(403, '시스템 이력은 수정하거나 삭제할 수 없습니다.');
      if (event.createdBy !== userId) fail(403, '작성자만 기록을 수정하거나 삭제할 수 있습니다.');
      if (method === 'DELETE') { events.delete(id); await groups.save(group); return { deleted: true }; }
      if (method !== 'PATCH') fail(404, '경로를 찾을 수 없습니다.');
      fields(body, ['content', 'type', 'timestamp', 'version']);
      if (!['content', 'type', 'timestamp'].some(k => body[k] !== undefined)) fail(400, '수정할 필드가 필요합니다.');
      if (body.version !== undefined && body.version !== event.version) fail(409, '기록이 변경되었습니다. 다시 조회하세요.');
      if (body.content !== undefined) event.content = text(body.content, 'content');
      if (body.type !== undefined) event.type = choice(body.type, eventTypes, 'type');
      if (body.timestamp !== undefined) event.timestamp = date(body.timestamp);
      if (event.timestamp > now) fail(400, '돌봄 기록은 미래일 수 없습니다.');
      event.analysis = null; event.version++; event.updatedAt = now;
      await groups.save(group); return event;
    });
  }
  async analyze(userId, groupId, id, body) {
    return this.store.transaction(async tx => {
      const groups = new CareGroupRepository(tx), { group } = await groups.forMember(groupId, userId, true);
      requireElder(group);
      fields(body, id ? [] : ['content']);
      const event = id ? new CareEventRepository(group).findById(id) : null;
      if (event && (event.createdBy !== userId || event.source === 'system')) fail(403, '작성한 돌봄 기록만 분석할 수 있습니다.');
      let analysis;
      const content = event?.content ?? text(body.content, 'content');
      try { analysis = await this.ai.classifyCareEvent(content); }
      catch { fail(502, '자동 분류에 실패했습니다. 기록 유형을 직접 선택해주세요.', 'AI_CLASSIFICATION_FAILED'); }
      if (event) { event.analysis = analysis; event.version++; await groups.save(group); }
      return analysis;
    });
  }
}
export class ScheduleService {
  constructor(store, clock) { this.store = store; this.clock = clock; }
  async execute(userId, groupId, method, id, body, query) {
    return this.store.transaction(async tx => {
      const groups = new CareGroupRepository(tx), { group } = await groups.forMember(groupId, userId, method !== 'GET');
      requireElder(group);
      const schedules = new ScheduleRepository(group), now = this.clock();
      if (method === 'GET') {
        if (id) return schedules.findById(id);
        const status = query.get('status'); if (status) choice(status, ['scheduled', 'completed', 'cancelled'], 'status');
        const view = query.get('view'); if (view) choice(view, ['today', 'next'], 'view');
        const from = query.has('from') ? date(query.get('from'), 'from') : '';
        const to = query.has('to') ? date(query.get('to'), 'to') : '9999';
        if (from > to) fail(400, '조회 기간이 올바르지 않습니다.');
        const list = group.schedules.filter(s => !s.deletedAt && (!status || s.status === status) && s.scheduledAt >= from && s.scheduledAt <= to && (view !== 'today' || dayInSeoul(s.scheduledAt) === dayInSeoul(now)) && (view !== 'next' || s.status === 'scheduled' && s.scheduledAt >= now)).sort(sortBy('scheduledAt'));
        return view === 'next' ? list.slice(0, 1) : list;
      }
      if (!id && method === 'POST') {
        fields(body, ['title', 'type', 'scheduledAt', 'caregiverId']);
        const schedule = schedules.save({ id: randomUUID(), elderId: group.elder.id, title: text(body.title, 'title', 200), type: choice(body.type ?? 'other', scheduleTypes, 'type'), scheduledAt: date(body.scheduledAt, 'scheduledAt'), caregiverId: guardian(group, body.caregiverId ?? group.primaryCaregiverId), status: 'scheduled', version: 1, createdBy: userId, createdAt: now });
        systemEvent(group, userId, now, 'schedule', `일정 등록: ${schedule.title}`);
        await groups.save(group); return schedule;
      }
      if (!id) fail(404, '경로를 찾을 수 없습니다.');
      const schedule = schedules.findById(id);
      if (method === 'DELETE') {
        schedule.deletedAt = now; schedule.version++;
        for (const a of group.approvals.filter(a => a.scheduleId === id && a.status === 'pending')) { a.status = 'rejected'; a.decidedBy = userId; a.decidedAt = now; a.decisionReason = '일정 삭제'; }
        systemEvent(group, userId, now, 'schedule', `일정 삭제: ${schedule.title}`);
        await groups.save(group); return { deleted: true };
      }
      if (method !== 'PATCH') fail(404, '경로를 찾을 수 없습니다.');
      fields(body, ['title', 'type', 'scheduledAt', 'caregiverId', 'status', 'version']);
      if (!['title', 'type', 'scheduledAt', 'caregiverId', 'status'].some(k => body[k] !== undefined)) fail(400, '수정할 필드가 필요합니다.');
      if (body.version !== undefined && body.version !== schedule.version) fail(409, '일정이 변경되었습니다. 다시 조회하세요.');
      if (body.title !== undefined) schedule.title = text(body.title, 'title', 200);
      if (body.type !== undefined) schedule.type = choice(body.type, scheduleTypes, 'type');
      if (body.scheduledAt !== undefined) schedule.scheduledAt = date(body.scheduledAt, 'scheduledAt');
      if (body.caregiverId !== undefined) schedule.caregiverId = guardian(group, body.caregiverId);
      if (body.status !== undefined) schedule.status = choice(body.status, ['scheduled', 'completed', 'cancelled'], 'status');
      schedule.version++; schedule.updatedAt = now;
      systemEvent(group, userId, now, 'schedule', `일정 변경: ${schedule.title} (${schedule.status})`);
      await groups.save(group); return schedule;
    });
  }
}
