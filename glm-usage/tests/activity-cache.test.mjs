import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpClient } from '../dev/mcp-client.mjs';

// 构造临时 ZCode 数据库（与 mcp-integration 相同的最小 schema）
function buildDb(root) {
  mkdirSync(join(root, 'cli/db'), { recursive: true }); mkdirSync(join(root, 'cli/rollout'));
  const db = new DatabaseSync(join(root, 'cli/db/db.sqlite'));
  db.exec(`
    CREATE TABLE session(id TEXT, title TEXT, directory TEXT, parent_id TEXT, task_type TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, time_compacting INTEGER, time_deleted INTEGER);
    CREATE TABLE model_usage(id TEXT, session_id TEXT, started_at INTEGER, completed_at INTEGER, turn_id TEXT, model_id TEXT, status TEXT, query_source TEXT, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, computed_total_tokens INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER, error_type TEXT, finish_reason TEXT, attempt_index INTEGER);
    CREATE TABLE tool_usage(id TEXT, session_id TEXT, tool_call_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, output_bytes INTEGER);
    CREATE TABLE turn_usage(session_id TEXT, started_at INTEGER, cancelled_by_user INTEGER, context_exceeded INTEGER, status TEXT, error_type TEXT);
    CREATE TABLE part(id TEXT, session_id TEXT, message_id TEXT, sequence INTEGER, time_created INTEGER, data TEXT);
    CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE todo(session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER, time_created INTEGER, time_updated INTEGER);
  `);
  return db;
}

const toolPart = (call, tool, input) => JSON.stringify({ type: 'tool', callID: call, tool, state: { input, status: 'completed' } });
const insertPart = (db, id, ts, data) => db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(id, 'sess_root', 'm1', 0, ts, data);

test('commands/skills bucket materialization: rebuild, incremental scan, corrupt/version/watermark fallbacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'glm-activity-'));
  const now = Date.now();
  const threeDaysAgo = now - 3 * 864e5;
  const dataDir = join(root, 'config');
  const cacheFile = join(dataDir, 'activity-cache.json');

  const db = buildDb(root);
  // 第一天（3 天前）：git ×3、node ×2、技能 demo-skill ×2；外加 3 行干扰（非命令 / 非技能工具 / text part）
  insertPart(db, 'p1', threeDaysAgo, toolPart('c1', 'bash', { command: 'git status' }));
  insertPart(db, 'p2', threeDaysAgo + 1, toolPart('c2', 'bash', { command: 'git push origin main' }));
  insertPart(db, 'p3', threeDaysAgo + 2, toolPart('c3', 'bash', { command: 'git diff' }));
  insertPart(db, 'p4', threeDaysAgo + 3, toolPart('c4', 'bash', { command: 'node --test' }));
  insertPart(db, 'p5', threeDaysAgo + 4, toolPart('c5', 'bash', { command: 'node index.js' }));
  insertPart(db, 'p6', threeDaysAgo + 5, toolPart('c6', 'Skill', { skill: 'demo-skill' }));
  insertPart(db, 'p7', threeDaysAgo + 6, toolPart('c7', 'Skill', { skill: 'demo-skill' }));
  insertPart(db, 'p8', threeDaysAgo + 7, toolPart('c8', 'read', { file_path: '/tmp/x' }));
  insertPart(db, 'p9', threeDaysAgo + 8, JSON.stringify({ type: 'text', text: 'hello' }));
  db.close();

  let client = mcpClient({ GLM_ZCODE_DIR: root, GLM_USAGE_DATA_DIR: dataDir });
  try {
    // 首次调用 = 全量重建；all 范围含全部行
    let ins = await client.call('get_insights', { range: 'all' });
    assert.deepEqual(ins.commands, [{ program: 'git', count: 3 }, { program: 'node', count: 2 }]);
    assert.equal(ins.skills.length, 1);
    assert.equal(ins.skills[0].name, 'demo-skill'); assert.equal(ins.skills[0].calls, 2);
    assert.equal(ins.skills[0].last_at, threeDaysAgo + 6);
    // 缓存文件已落盘：schema 版本 + 水位 = 已处理的最大 part rowid
    assert(existsSync(cacheFile));
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.equal(cache.version, 2);
    assert.equal(cache.watermark, 9); // 9 行 part
    const dayKeys = Object.keys(cache.days);
    assert.equal(dayKeys.length, 1);
    // today 范围不含 3 天前的行
    ins = await client.call('get_insights', { range: 'today' });
    assert.deepEqual(ins.commands, []); assert.deepEqual(ins.skills, []);

    // —— 增量：同进程追加新 part（今天的 git ×2、新技能 fresh-skill ×1），只扫 rowid > 水位 ——
    db.open ? null : null;
    const db2 = new DatabaseSync(join(root, 'cli/db/db.sqlite'));
    insertPart(db2, 'p10', now - 1000, toolPart('c9', 'bash', { command: 'git status' }));
    insertPart(db2, 'p11', now - 500, toolPart('c10', 'bash', { command: 'git status' }));
    insertPart(db2, 'p12', now - 100, toolPart('c11', 'Skill', { skill: 'fresh-skill' }));
    db2.close();
    ins = await client.call('get_insights', { range: 'today' });
    assert.deepEqual(ins.commands, [{ program: 'git', count: 2 }]);
    assert.equal(ins.skills.length, 1);
    assert.equal(ins.skills[0].name, 'fresh-skill'); assert.equal(ins.skills[0].calls, 1);
    const cache2 = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.equal(cache2.watermark, 12);
  } finally { client.close(); }

  // —— 缓存损坏：新进程读取失败 → 全量重建，结果一致 ——
  writeFileSync(cacheFile, '{corrupted!!');
  client = mcpClient({ GLM_ZCODE_DIR: root, GLM_USAGE_DATA_DIR: dataDir });
  try {
    const ins = await client.call('get_insights', { range: 'all' });
    assert.deepEqual(ins.commands, [{ program: 'git', count: 5 }, { program: 'node', count: 2 }]);
    assert.deepEqual(ins.skills.map(s => s.name).sort(), ['demo-skill', 'fresh-skill']);
    assert.deepEqual(ins.skills.map(s => s.calls).sort((a, b) => b - a), [2, 1]);
  } finally { client.close(); }

  // —— schema 版本不符 → 重建 ——
  const good = JSON.parse(readFileSync(cacheFile, 'utf8'));
  writeFileSync(cacheFile, JSON.stringify({ ...good, version: 999 }));
  client = mcpClient({ GLM_ZCODE_DIR: root, GLM_USAGE_DATA_DIR: dataDir });
  try {
    const ins = await client.call('get_insights', { range: '7d' });
    assert.equal(ins.commands[0].program, 'git'); assert.equal(ins.commands[0].count, 5);
  } finally { client.close(); }

  // —— 水位回退（库被 VACUUM 重建/更换）：缓存水位 > 当前 max(rowid) → 重建 ——
  writeFileSync(cacheFile, JSON.stringify({ ...good, watermark: 999999 }));
  client = mcpClient({ GLM_ZCODE_DIR: root, GLM_USAGE_DATA_DIR: dataDir });
  try {
    const ins = await client.call('get_insights', { range: 'all' });
    assert.deepEqual(ins.commands, [{ program: 'git', count: 5 }, { program: 'node', count: 2 }]);
    const cache3 = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.equal(cache3.watermark, 12); // 重建后水位回到真实 max rowid
  } finally { client.close(); }

  rmSync(root, { recursive: true, force: true });
});

test('pick commands/skills resolves session ids from materialized day buckets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'glm-pick-'));
  const now = Date.now();
  const dataDir = join(root, 'config');
  const db = buildDb(root);
  const insPart = (id, sid, ts, data) => db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(id, sid, 'm1', 0, ts, data);
  // 三个会话：s1 今天跑 git/ls，s2 今天跑 git + 技能 demo-skill，s3 三天前跑 git（检验范围过滤）
  insPart('q1', 's1', now - 900, toolPart('k1', 'bash', { command: 'git status' }));
  insPart('q2', 's1', now - 800, toolPart('k2', 'bash', { command: 'ls -la' }));
  insPart('q3', 's2', now - 700, toolPart('k3', 'bash', { command: '/usr/bin/git pull' }));
  insPart('q4', 's2', now - 600, toolPart('k4', 'Skill', { skill: 'demo-skill' }));
  insPart('q5', 's3', now - 3 * 864e5, toolPart('k5', 'bash', { command: 'git log' }));
  db.close();

  const client = mcpClient({ GLM_ZCODE_DIR: root, GLM_USAGE_DATA_DIR: dataDir });
  try {
    // commands pick：路径前缀归一（/usr/bin/git → git）；today 范围只含今天两个会话
    let r = await client.call('get_activity', { kind: 'commands', pick: 'git', range: 'today' });
    assert.equal(r.kind, 'commands');
    assert.deepEqual([...r.session_ids].sort(), ['s1', 's2']);
    assert.equal(r.truncated, false);
    // 7d 范围把三天前的 s3 也带上
    r = await client.call('get_activity', { kind: 'commands', pick: 'git', range: '7d' });
    assert.deepEqual([...r.session_ids].sort(), ['s1', 's2', 's3']);
    // 未命中键：空集合
    r = await client.call('get_activity', { kind: 'commands', pick: 'nope', range: '7d' });
    assert.deepEqual(r.session_ids, []);
    // skills pick：只有 s2
    r = await client.call('get_activity', { kind: 'skills', pick: 'demo-skill', range: 'today' });
    assert.deepEqual(r.session_ids, ['s2']);
    // tools pick 保持 tool_usage 直查（无该工具记录 → 空）
    r = await client.call('get_activity', { kind: 'tools', pick: 'bash', range: 'today' });
    assert.deepEqual(r.session_ids, []);
  } finally { client.close(); }

  // 损坏缓存 → pick 走全量重建，结果一致（而非失败）
  writeFileSync(join(dataDir, 'activity-cache.json'), '{bad');
  const c2 = mcpClient({ GLM_ZCODE_DIR: root, GLM_USAGE_DATA_DIR: dataDir });
  try {
    const r = await c2.call('get_activity', { kind: 'commands', pick: 'git', range: '7d' });
    assert.deepEqual([...r.session_ids].sort(), ['s1', 's2', 's3']);
  } finally { c2.close(); }

  rmSync(root, { recursive: true, force: true });
});
