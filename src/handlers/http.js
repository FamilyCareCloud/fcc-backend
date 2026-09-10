import { createServer } from 'node:http';
export function createHttpServer(app) {
  const attempts = new Map();
  return createServer(async (req, res) => {
    let result;
    try {
      if (req.url.startsWith('/auth/')) {
        const now = Date.now(), key = req.socket.remoteAddress;
        for (const [ip, value] of attempts) if (value.until <= now) attempts.delete(ip);
        const value = attempts.get(key) ?? { count: 0, until: now + 60000 };
        value.count++; attempts.set(key, value);
        if (value.count > 30) { const error = new Error('잠시 후 다시 시도하세요.'); error.status = 429; throw error; }
      }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) { const error = new Error('요청이 너무 큽니다.'); error.status = 413; throw error; }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks).toString('utf8');
      const authorization = req.headers.authorization ?? '';
      result = await app({ method: req.method, path: req.url, token: authorization.startsWith('Bearer ') ? authorization.slice(7) : null, body: data ? JSON.parse(data) : {} });
    } catch (error) { result = { status: error.status ?? 400, body: { error: error.status ? error.message : '올바른 JSON 요청이 필요합니다.' } }; }
    res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(result.body));
  });
}
