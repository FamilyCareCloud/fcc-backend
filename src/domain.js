export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') { super(message); this.status = status; this.code = code; }
}
export const fail = (status, message, code) => { throw new HttpError(status, message, code); };
export function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${name}: 올바른 문자열이 필요합니다.`);
  return value.trim();
}
export function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'JSON 객체가 필요합니다.');
  if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, '허용되지 않은 필드가 있습니다.');
}
export function date(value, name = 'timestamp') {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, `${name}: 시간대 포함 ISO 날짜가 필요합니다.`);
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) fail(400, `${name}: 존재하지 않는 날짜입니다.`);
  return new Date(value).toISOString();
}
export function birthDate(value, now) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) fail(400, 'birthDate: YYYY-MM-DD 형식이 필요합니다.');
  date(`${value}T00:00:00Z`, 'birthDate');
  if (value > now.slice(0, 10)) fail(400, '생년월일은 미래일 수 없습니다.');
  return value;
}
export const choice = (value, choices, name) => choices.includes(value) ? value : fail(400, `${name}: ${choices.join(', ')} 중 선택하세요.`);
export const eventTypes = ['hospital', 'medication', 'meal', 'life', 'schedule', 'observation', 'homecoming', 'care_center'];
export const scheduleTypes = ['hospital', 'examination', 'visit', 'care_center', 'medication', 'other'];
export const sortBy = key => (a, b) => a[key].localeCompare(b[key]) || a.id.localeCompare(b.id);
export const email = value => {
  const normalized = text(value, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) fail(400, '올바른 이메일이 필요합니다.');
  return normalized;
};
export const dayInSeoul = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);
const shiftDay = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
// 질문에 든 날짜 표현(오늘·내일·모레·이번 주·다음 주)을 한국 시간 기준 [from, to] 날짜(YYYY-MM-DD, 양끝 포함)로 바꾼다.
// 주는 월요일~일요일. 날짜 표현이 없으면 null.
export function dateScope(question, now) {
  const today = dayInSeoul(now);
  const mondayOffset = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = shiftDay(today, -mondayOffset);
  if (/오늘/.test(question)) return { from: today, to: today, label: '오늘' };
  if (/내일/.test(question)) return { from: shiftDay(today, 1), to: shiftDay(today, 1), label: '내일' };
  if (/모레/.test(question)) return { from: shiftDay(today, 2), to: shiftDay(today, 2), label: '모레' };
  if (/이번\s*주/.test(question)) return { from: today, to: shiftDay(monday, 6), label: '이번 주' };
  if (/다음\s*주/.test(question)) return { from: shiftDay(monday, 7), to: shiftDay(monday, 13), label: '다음 주' };
  return null;
}
export const audioMimeTypes = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/ogg', 'audio/webm'];
export function base64Audio(value, maxBytes) {
  if (typeof value !== 'string' || !value.trim()) fail(400, 'audioBase64: 올바른 문자열이 필요합니다.');
  let buffer;
  try { buffer = Buffer.from(value, 'base64'); } catch { fail(400, 'audioBase64: 올바른 base64 인코딩이 필요합니다.'); }
  if (!buffer.length || buffer.length > maxBytes) fail(413, `audioBase64: 오디오 용량은 ${Math.floor(maxBytes / 1024)}KB 이하여야 합니다.`);
  return buffer;
}
export function range(input, now) {
  const fromDate = date(input.fromDate ?? new Date(Date.parse(now) - 7 * 86400000).toISOString(), 'fromDate');
  const toDate = date(input.toDate ?? now, 'toDate');
  if (fromDate > toDate || toDate > now || Date.parse(toDate) - Date.parse(fromDate) > 90 * 86400000) fail(400, '인수인계 기간은 과거 90일 이내 길이로 지정하세요.');
  return { fromDate, toDate };
}
