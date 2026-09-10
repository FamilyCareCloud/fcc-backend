import { fail } from '../domain.js';
export class UserRepository {
  constructor(tx) { this.tx = tx; }
  async findById(id) { return this.tx.get(`user#${id}`); }
  async save(user) { await this.tx.set(`user#${user.userId}`, user); return user; }
}
export class CareGroupRepository {
  constructor(tx) { this.tx = tx; }
  async findById(id) { return this.tx.get(`group#${id}`); }
  async save(group) { await this.tx.set(`group#${group.id}`, group); return group; }
  async forMember(id, userId, caregiverOnly = false) {
    const group = await this.findById(id);
    const member = group?.members.find(m => m.userId === userId);
    if (!member) fail(404, '그룹을 찾을 수 없습니다.');
    if (caregiverOnly && member.role === 'elder') fail(403, '보호자 권한이 필요합니다.');
    return { group, member };
  }
}
export class CareEventRepository {
  constructor(group) { this.group = group; }
  findById(id) { return this.group.events.find(e => e.id === id) ?? fail(404, '기록을 찾을 수 없습니다.'); }
  findByDateRange(from, to) { return this.group.events.filter(e => e.timestamp >= from && e.timestamp <= to); }
  save(event) { this.group.events.push(event); return event; }
  delete(id) { this.group.events = this.group.events.filter(e => e.id !== id); }
}
export class ScheduleRepository {
  constructor(group) { this.group = group; }
  findById(id) { return this.group.schedules.find(s => s.id === id && !s.deletedAt) ?? fail(404, '일정을 찾을 수 없습니다.'); }
  save(schedule) { this.group.schedules.push(schedule); return schedule; }
}
export class CareHandoffRepository {
  constructor(group) { this.group = group; }
  findById(id) { return this.group.handoffs.find(h => h.id === id) ?? fail(404, '인수인계를 찾을 수 없습니다.'); }
  findLatest() { return this.group.handoffs.at(-1) ?? fail(404, '생성된 인수인계가 없습니다.'); }
  save(handoff) { this.group.handoffs.push(handoff); return handoff; }
}
export class CaregiverHistoryRepository {
  constructor(group) { this.group = group; }
  save(history) { this.group.assignments.push(history); return history; }
}
