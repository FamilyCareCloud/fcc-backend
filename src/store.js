import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail } from './domain.js';

// Local, single-process store. Each transaction commits all changed records together.
export class Store {
  constructor(file) {
    this.file = file;
    const data = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { records: {} };
    if (data.groups && Object.keys(data.groups).length) throw new Error('v0.1 데이터입니다. docs/MIGRATION.md를 먼저 확인하세요.');
    this.records = data.records ?? {};
    this.tail = Promise.resolve();
  }
  transaction(action) {
    const pending = this.tail.then(async () => {
      const next = structuredClone(this.records);
      let changed = false;
      const result = await action({
        get: async key => structuredClone(next[key] ?? null),
        set: async (key, value) => {
          if (Buffer.byteLength(JSON.stringify(value)) > 350000) fail(413, '데이터 저장 한도를 초과했습니다. 그룹 기록 분할이 필요합니다.', 'RECORD_LIMIT');
          next[key] = structuredClone(value); changed = true;
        },
        delete: async key => { delete next[key]; changed = true; }
      });
      if (changed) {
        if (this.file) {
          mkdirSync(dirname(this.file), { recursive: true });
          writeFileSync(`${this.file}.tmp`, JSON.stringify({ schemaVersion: 2, records: next }, null, 2), { mode: 0o600 });
          renameSync(`${this.file}.tmp`, this.file);
        }
        this.records = next;
      }
      return structuredClone(result);
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
}
