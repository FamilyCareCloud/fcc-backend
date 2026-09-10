import { createServer } from 'node:http';
import { createApp } from './app.js';
import { Store } from './store.js';

if (process.env.NODE_ENV === 'production') throw new Error('로컬 개발 서버입니다. 운영 배포에는 검증된 인증 및 DynamoDB 저장소가 필요합니다.');
if (!process.env.DEV_TOKEN || process.env.DEV_TOKEN.length < 16) throw new Error('16자 이상의 DEV_TOKEN을 설정하세요.');
const app = createApp(new Store(process.env.DATA_FILE ?? './data/fcc.json'));
createServer(async (req, res) => {
  let result;
  try {
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      if (Buffer.byteLength(data) > 65536) { const error = new Error(); error.status = 413; throw error; }
    }
    const authenticated = req.headers.authorization === `Bearer ${process.env.DEV_TOKEN}`;
    result = app({ method: req.method, path: req.url, userId: authenticated ? process.env.DEV_USER_ID ?? 'dev-caregiver' : null, body: data ? JSON.parse(data) : {} });
  } catch (error) { result = { status: error.status ?? 400, body: { error: error.status === 413 ? '요청이 너무 큽니다.' : '올바른 JSON 요청이 필요합니다.' } }; }
  res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(result.body));
}).listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => console.log('FCC API: http://127.0.0.1:3000'));
