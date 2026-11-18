import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), 'glm-health-'));
process.env.GLM_ZCODE_DIR = root;
process.env.GLM_USAGE_DATA_DIR = join(root, 'config');
const dbDir = join(root, 'cli', 'db');
mkdirSync(dbDir, { recursive: true });
const db = new DatabaseSync(join(dbDir, 'db.sqlite'));
db.exec(`CREATE TABLE model_usage (
  started_at INTEGER, query_source TEXT, duration_ms INTEGER,
  time_to_first_token_ms INTEGER, output_tokens INTEGER
)`);
const today = new Date();
today.setHours(0, 0, 0, 0);
const yesterday = new Date(today);
yesterday.setDate(yesterday.getDate() - 1);
db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?)').run(+today, 'agent', 2100, 100, 120);
db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?)').run(+yesterday, 'agent', 2100, 100, 100);
db.close();
const { fetchHealth } = (await import('../plugin/mcp/server.mjs')).__internals;
process.stdin.destroy();
after(() => rmSync(root, { recursive: true, force: true }));

function mockMonitor(t, sampleKey, response) {
  process.env.GLM_CODING_PLAN_API_KEY = sampleKey;
  const requests = [];
  t.mock.method(https, 'request', (url, { headers }, callback) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://open.bigmodel.cn');
    assert.equal(parsed.pathname, '/api/monitor/usage/model-performance-day');
    assert.equal(headers.Authorization, sampleKey);
    requests.push(parsed.searchParams);
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const result = response(parsed.searchParams);
      if (result instanceof Error) {
        req.emit('error', result);
        return;
      }
      const res = new EventEmitter();
      res.statusCode = result.status ?? 200;
      callback(res);
      res.emit('data', result.raw ?? JSON.stringify(result.body));
      res.emit('end');
    });
    return req;
  });
  return requests;
}

test('Today and 7 days reuse the official request with calendar boundaries and preserve the dated latest sample', async t => {
  const requests = mockMonitor(t, 'fixture-health-numeric', params => {
    const last = params.get('endTime').slice(0, 10);
    return { body: { success: true, data: {
      xTime: [last, yesterday.toLocaleDateString('en-CA')], // 旧字段以外的宿主兼容格式，且日期倒序
      proMaxDecodeSpeed: [0, '128.4'],
      liteDecodeSpeed: [null, 102.6],
      liteSuccessRate: [null, 0],
    } } };
  });
  const [day, week] = await Promise.all([fetchHealth(1), fetchHealth(7)]);
  assert.equal(requests.length, 1);
  assert.equal(week.xTime.length, 7);
  assert.equal(requests[0].get('startTime'), week.xTime[0] + ' 00:00:00');
  assert.equal(requests[0].get('endTime'), day.xTime[0] + ' 23:59:59');
  assert.deepEqual(day.actual, [60]);
  assert.deepEqual(day.actualN, [1]);
  assert.deepEqual(day.proMax, [null]);
  assert.deepEqual(day.lite, [null]);
  assert.equal(day.official_status, 'empty');
  assert.equal(day.official, false);
  assert.deepEqual(day.official_latest.proMax, { date: week.xTime.at(-2), value: 128.4 });
  assert.equal(week.official_status, 'ok');
  assert.deepEqual(week.proMax.slice(-2), [128.4, null]);
  assert.deepEqual(week.lite.slice(-2), [102.6, null]);
  assert.deepEqual(week.actual.slice(-2), [50, 60]);
  assert.equal(week.liteOk.at(-2), 0);
});

test('official authentication failure and network failure keep local data and use distinct states', async t => {
  const requests = mockMonitor(t, 'fixture-health-auth', () => ({ status: 403, raw:'<html>Forbidden</html>' }));
  const auth = await fetchHealth(30);
  assert.equal(auth.xTime.length, 30);
  assert.equal(requests[0].get('startTime'), auth.xTime[0] + ' 00:00:00');
  assert.equal(auth.official_status, 'key');
  assert.equal(auth.official, false);
  assert.deepEqual(auth.actual.slice(-2), [50, 60]);

  t.mock.restoreAll();
  mockMonitor(t, 'fixture-health-network', () => new Error('simulated DNS failure'));
  const network = await fetchHealth(30);
  assert.equal(network.official_status, 'network');
  assert.deepEqual(network.actual.slice(-2), [50, 60]);
  assert.deepEqual(network.official_latest, {proMax:null,lite:null});
});

test('an empty official series keeps the local axis and rejects malformed numbers', async t => {
  mockMonitor(t, 'fixture-health-empty', params => ({ body: { success: true, data: {
    x_time: [params.get('endTime')],
    proMaxDecodeSpeed: '100',
    liteDecodeSpeed: [' '],
  } } }));
  const result = await fetchHealth(7);
  assert.equal(result.official_status, 'empty');
  assert.equal(result.official, false);
  assert(result.proMax.every(v => v === null));
  assert.equal(result.actual.at(-1), 60);
});
