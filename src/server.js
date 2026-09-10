import { createApp } from './app.js';
import { Store } from './store.js';
import { createAnalysisService } from './services/bedrock.js';
import { createHttpServer } from './handlers/http.js';
if (process.env.NODE_ENV === 'production') throw new Error('운영은 infra/template.yaml의 Cognito/DynamoDB Lambda 구성을 사용하세요.');
const app = createApp(new Store(process.env.DATA_FILE ?? './data/fcc-v2.json'), { ai: await createAnalysisService() });
const port = Number(process.env.PORT ?? 3000);
createHttpServer(app).listen(port, '127.0.0.1', () => console.log(`FCC API: http://127.0.0.1:${port}`));
