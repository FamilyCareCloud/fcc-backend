import test from 'node:test';
import assert from 'node:assert/strict';
import { BedrockService } from '../src/services/bedrock.js';
import { DynamoStore } from '../src/adapters/dynamodb.js';
import { CognitoAuthService } from '../src/adapters/cognito.js';
import { SttService, LocalSttService, createSttService } from '../src/adapters/stt.js';
import { Store } from '../src/store.js';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import * as cognitoCommands from '@aws-sdk/client-cognito-identity-provider';
const clock = () => '2026-09-10T05:00:00.000Z';
function model(output, stopReason = 'end_turn') {
  const commands = [];
  const ai = new BedrockService({ client: { send: async command => { commands.push(command); return { stopReason, output: { message: { content: [{ text: JSON.stringify(output) }] } } }; } }, modelId: 'test-model', commandFactory: input => new ConverseCommand(input) });
  return { ai, commands };
}
test('Bedrock 실제 SDK 명령 스키마와 근거 기반 분석 결과', async () => {
  const { ai, commands } = model({ type: 'hospital', facts: [{ text: '내과 방문', quote: '내과 다녀왔고' }], followUp: [{ text: '다음 피검사', quote: '다음에는 피검사' }] });
  const result = await ai.classifyCareEvent('오늘 내과 다녀왔고 다음에는 피검사 한대.');
  assert.equal(result.mode, 'bedrock'); assert.equal(result.type, 'hospital');
  assert.equal(commands[0].input.modelId, 'test-model');
  assert.ok(commands[0].input.system[0].text.includes('untrusted data'));
});
test('Bedrock 존재하지 않는 근거·잘린 응답·잘못된 JSON 차단', async () => {
  const { ai } = model({ type: 'meal', facts: [{ text: '정상', quote: '원문에 없는 인용' }], followUp: [] });
  await assert.rejects(ai.classifyCareEvent('식사량 감소'));
  const truncated = model({}, 'max_tokens').ai;
  await assert.rejects(truncated.classifyCareEvent('식사'));
  const invalid = new BedrockService({ client: { send: async () => ({ stopReason: 'end_turn', output: { message: { content: [{ text: 'not json' }] } } }) }, modelId: 'test', commandFactory: input => new ConverseCommand(input) });
  await assert.rejects(invalid.classifyCareEvent('식사'));
});
test('Bedrock 요약 출처 ID 및 정확한 인용 검증', async () => {
  const valid = { healthSummary: [], lifeSummary: [{ text: '식사량 감소', sources: [{ id: 'event-1', quote: '식사량 감소' }] }], scheduleSummary: [], followUp: [] };
  const events = [{ id: 'event-1', type: 'meal', content: '식사량 감소', timestamp: clock() }];
  assert.equal((await model(valid).ai.summarizeCareEvents(events, [])).mode, 'bedrock');
  valid.lifeSummary[0].sources[0].id = 'other-family-event';
  await assert.rejects(model(valid).ai.summarizeCareEvents(events, []));
});
function fakeDynamo() {
  const records = new Map(), commands = [];
  const client = { send: async command => {
    commands.push(command);
    if (command instanceof GetCommand) return { Item: structuredClone(records.get(command.input.Key.pk)) };
    assert.ok(command instanceof TransactWriteCommand);
    for (const item of command.input.TransactItems) {
      const operation = Object.values(item)[0], key = operation.Key?.pk ?? operation.Item.pk, existing = records.get(key);
      const valid = operation.ConditionExpression === 'attribute_not_exists(pk)' ? !existing : existing?.version === operation.ExpressionAttributeValues[':v'];
      if (!valid) { const error = new Error('conflict'); error.name = 'TransactionCanceledException'; throw error; }
    }
    for (const item of command.input.TransactItems) {
      if (item.Put) records.set(item.Put.Item.pk, structuredClone(item.Put.Item));
      if (item.Delete) records.delete(item.Delete.Key.pk);
    }
    return {};
  } };
  return { records, commands, store: new DynamoStore({ client, tableName: 'test', commands: { GetCommand, TransactWriteCommand } }) };
}
test('DynamoDB 그룹·사용자 동시 저장, TTL 및 읽기 전용 무쓰기', async () => {
  const f = fakeDynamo();
  await f.store.transaction(async tx => { await tx.set('group#g', { id: 'g' }); await tx.set('session#s', { userId: 'u', expiresAtEpoch: 100 }); });
  assert.equal(f.records.get('session#s').expiresAtEpoch, 100);
  assert.equal(f.commands.filter(c => c instanceof TransactWriteCommand).length, 1);
  assert.deepEqual(await f.store.transaction(tx => tx.get('group#g')), { id: 'g' });
  assert.equal(f.commands.filter(c => c instanceof TransactWriteCommand).length, 1);
});
test('DynamoDB 동시 업데이트는 덮어쓰지 않고 충돌 응답', async () => {
  const f = fakeDynamo(); await f.store.transaction(tx => tx.set('group#g', { count: 0 }));
  let release, read;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { read = resolve; });
  const first = f.store.transaction(async tx => { const g = await tx.get('group#g'); read(); await gate; g.count++; await tx.set('group#g', g); });
  await started;
  await f.store.transaction(async tx => { const g = await tx.get('group#g'); g.count += 5; await tx.set('group#g', g); });
  release();
  await assert.rejects(first, error => error.status === 409);
  assert.equal(f.records.get('group#g').data.count, 5);
});
test('DynamoDB 읽은 권한 레코드도 조건 검사, 실패 시 부분 저장 없음', async () => {
  const f = fakeDynamo(); await f.store.transaction(tx => tx.set('user#u', { role: 'owner' }));
  let release, read;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { read = resolve; });
  const first = f.store.transaction(async tx => { await tx.get('user#u'); read(); await gate; await tx.set('group#g', { id: 'g' }); });
  await started; await f.store.transaction(tx => tx.set('user#u', { role: 'caregiver' })); release();
  await assert.rejects(first, error => error.status === 409);
  assert.equal(f.records.has('group#g'), false);
});
test('Cognito는 GetUser로 토큰 확인·이메일 인증 강제·로그아웃 호출', async () => {
  const calls = [], store = new Store(); let verified = false;
  const auth = new CognitoAuthService({ store, clock, commands: cognitoCommands, clientId: 'client', client: { send: async command => {
    calls.push(command.constructor.name);
    if (command instanceof cognitoCommands.GetUserCommand) return { UserAttributes: [{ Name: 'sub', Value: 'user-id' }, { Name: 'email', Value: 'test@example.com' }, { Name: 'name', Value: '테스트' }, { Name: 'email_verified', Value: String(verified) }] };
    return {};
  } } });
  await assert.rejects(auth.authenticate('token'), e => e.status === 403);
  verified = true;
  assert.equal(await auth.authenticate('token'), 'user-id');
  assert.equal((await auth.profile('user-id', 'GET')).name, '테스트');
  assert.equal((await auth.logout('token')).loggedOut, true);
  assert.ok(calls.includes('GlobalSignOutCommand'));
});
test('STT(fcc-ai)는 multipart로 오디오를 전송, 실패·미인식·연결 불가를 구분해 오류 반환', async () => {
  const calls = [];
  const ok = new SttService({ baseUrl: 'http://stt.local/', fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ text: ' 병원 다녀왔어요 ' }) }; } });
  assert.equal(await ok.transcribe(Buffer.from('audio'), 'audio/wav'), '병원 다녀왔어요');
  assert.equal(calls[0].url, 'http://stt.local/transcribe');
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.headers, undefined);

  const keyed = new SttService({ baseUrl: 'http://stt.local', apiKey: 'shared-secret', fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ text: '병원' }) }; } });
  await keyed.transcribe(Buffer.from('audio'), 'audio/wav');
  assert.equal(calls.at(-1).init.headers['X-API-Key'], 'shared-secret');

  const unreachable = new SttService({ baseUrl: 'http://stt.local', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(unreachable.transcribe(Buffer.from('a'), 'audio/wav'), error => error.status === 502);

  const failed = new SttService({ baseUrl: 'http://stt.local', fetchImpl: async () => ({ ok: false }) });
  await assert.rejects(failed.transcribe(Buffer.from('a'), 'audio/wav'), error => error.status === 502);

  const empty = new SttService({ baseUrl: 'http://stt.local', fetchImpl: async () => ({ ok: true, json: async () => ({ text: '   ' }) }) });
  await assert.rejects(empty.transcribe(Buffer.from('a'), 'audio/wav'), error => error.status === 422);

  await assert.rejects(new LocalSttService().transcribe(), error => error.status === 503);
  assert.ok(createSttService({}) instanceof LocalSttService);
  const configured = createSttService({ STT_SERVICE_URL: 'http://stt.local', STT_SERVICE_API_KEY: 'shared-secret' });
  assert.ok(configured instanceof SttService);
  assert.equal(configured.apiKey, 'shared-secret');
});
