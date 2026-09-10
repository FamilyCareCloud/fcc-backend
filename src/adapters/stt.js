import { fail } from '../domain.js';

// fcc-ai(GPU 로컬 서비스, feature/stt-service)의 POST /transcribe 를 호출하는 어댑터.
// 인수인계 요약(Bedrock)과 달리 STT는 GPU가 필요해 별도 프로세스로 분리되어 있다.
export class SttService {
  constructor({ baseUrl, timeoutMs = 15000, fetchImpl = fetch }) {
    if (!baseUrl) throw new Error('STT_SERVICE_URL is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }
  async transcribe(buffer, mimeType) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), 'audio');
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/transcribe`, { method: 'POST', body: form, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      fail(502, '음성 인식 서비스에 연결할 수 없습니다.');
    }
    if (!response.ok) fail(502, '음성 인식에 실패했습니다.');
    let data;
    try { data = await response.json(); } catch { fail(502, '음성 인식 응답을 해석할 수 없습니다.'); }
    if (typeof data?.text !== 'string' || !data.text.trim()) fail(422, '음성에서 텍스트를 인식하지 못했습니다.');
    return data.text.trim();
  }
}
// STT_SERVICE_URL이 없을 때의 기본값. fcc-ai는 로컬 GPU 환경에서만 단독 실행되므로
// 미설정 상태를 정상적인 배포 형태로 취급하고 명확한 오류로 안내한다.
export class LocalSttService {
  async transcribe() {
    fail(503, '음성 인식 서비스가 설정되지 않았습니다. STT_SERVICE_URL을 지정하고 fcc-ai를 실행하세요.');
  }
}
export function createSttService(env = process.env) {
  if (!env.STT_SERVICE_URL) return new LocalSttService();
  return new SttService({ baseUrl: env.STT_SERVICE_URL, timeoutMs: Number(env.STT_TIMEOUT_MS) || 15000 });
}
