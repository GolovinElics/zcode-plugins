import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

// 统计 fs 读取字节数：必须在导入 server.mjs 之前打补丁（readTailIoEntries 经 fs.readSync 读文件）
let readCalls = 0, readBytes = 0;
const origReadSync = fs.readSync;
fs.readSync = function (fd, buf, off, len, pos) { readCalls++; readBytes += len; return origReadSync.call(fs, fd, buf, off, len, pos); };

process.env.GLM_ZCODE_DIR = mkdtempSync(path.join(tmpdir(), 'glm-io-env-'));
process.env.GLM_USAGE_DATA_DIR = path.join(process.env.GLM_ZCODE_DIR, 'config');
const { readTailIoEntries, readIoEntries, readLatestIoEntry } =
  (await import('../plugin/mcp/server.mjs')).__internals;
process.stdin.destroy(); // server.mjs 顶层的 stdin 监听在测试进程里无人喂数据，显式释放事件循环

const mk = (dir) => mkdtempSync(path.join(dir || os.tmpdir(), 'glm-io-'));
const entry = (n) => JSON.stringify({ request: { body: { model: 'glm-5', messages: [{ role: 'user', content: 'x'.repeat(n) }] } } });
const MB = 1024 * 1024;

test('readTailIoEntries: 反向分块凑齐即停、顺序最新在前、常态读取远小于整文件', () => {
  const dir = mk();
  const f = path.join(dir, 'a.jsonl');
  // pad 1MB + entry 100KB + entry 120KB（末尾带换行）
  const pad = 'P'.repeat(MB);
  const e1 = entry(100 * 1024), e2 = entry(120 * 1024);
  writeFileSync(f, pad + '\n' + e1 + '\n' + e2 + '\n');
  const size = fs.statSync(f).size;
  readCalls = 0; readBytes = 0;
  const got = readTailIoEntries(f, size, 2, 24 * MB);
  assert.equal(got.entries.length, 2);
  assert.equal(got.entries[0].request.body.messages[0].content.length, 120 * 1024); // 最新在前
  assert.equal(got.entries[1].request.body.messages[0].content.length, 100 * 1024);
  assert.equal(got.bytes, Buffer.byteLength(e1) + Buffer.byteLength(e2));
  assert(readBytes <= 1.25 * MB, `常态读取 ${readBytes} 字节应 ≤ 1.25MB（实际 ${readCalls} 次读）`);
  rmSync(dir, { recursive: true, force: true });
});

test('readTailIoEntries: 单行超块时按 256KB→1MB→4MB 扩块直至凑齐', () => {
  const dir = mk();
  const f = path.join(dir, 'b.jsonl');
  const big = entry(1.5 * MB); // 超过 256KB 与 1MB 块，4MB 块内可容纳
  writeFileSync(f, big + '\n');
  const size = fs.statSync(f).size;
  readCalls = 0; readBytes = 0;
  const got = readTailIoEntries(f, size, 1, 24 * MB);
  assert.equal(got.entries.length, 1);
  assert.equal(got.entries[0].request.body.messages[0].content.length, 1.5 * MB);
  // 步长 256K→1M→4M：读到 5.25MB 内必然命中
  assert(readBytes <= 5.25 * MB + 4096, `扩块读取 ${readBytes} 字节应 ≤ 5.25MB`);
  rmSync(dir, { recursive: true, force: true });
});

test('readTailIoEntries: cap 之内找不到完整 entry 时返回空（与旧整段尾读同界）', () => {
  const dir = mk();
  const f = path.join(dir, 'c.jsonl');
  const giant = entry(30 * MB); // 单行 30MB，超过 8MB cap
  writeFileSync(f, giant + '\n');
  const size = fs.statSync(f).size;
  readCalls = 0; readBytes = 0;
  const got = readTailIoEntries(f, size, 1, 8 * MB);
  assert.deepEqual(got.entries, []);
  assert(readBytes <= 8 * MB, `cap 读取 ${readBytes} 字节应 ≤ 8MB`);
  rmSync(dir, { recursive: true, force: true });
});

test('readTailIoEntries: 截断半行被丢弃、多字节 UTF-8 跨块不损坏、空文件安全', () => {
  const dir = mk();
  // 空文件
  const fe = path.join(dir, 'empty.jsonl');
  writeFileSync(fe, '');
  assert.deepEqual(readTailIoEntries(fe, 0, 1, 8 * MB).entries, []);
  // 完整 entry（含中文，跨 256KB 边界）+ 末行无换行且截断
  const f = path.join(dir, 'd.jsonl');
  const good = JSON.stringify({ request: { body: { model: 'glm-5', messages: [{ role: 'user', content: '上下文边界测试'.repeat(40 * 1024) }] } } });
  const tail = JSON.stringify({ request: { body: { model: 'glm-5', messages: [{ role: 'user', content: '被截断' }] } } });
  writeFileSync(f, good + '\n' + tail.slice(0, 40));
  const size = fs.statSync(f).size;
  const got = readTailIoEntries(f, size, 2, 24 * MB);
  assert.equal(got.entries.length, 1); // 首行完整（文件头），末行截断被跳过
  assert.equal(got.entries[0].request.body.messages[0].content.includes('上下文边界测试'), true);
  rmSync(dir, { recursive: true, force: true });
});

test('readIoEntries / readLatestIoEntry: 语义保持（缓存、want 截取、最新一条）', async () => {
  const dir = mk();
  const root = process.env.GLM_ZCODE_DIR;
  fs.mkdirSync(path.join(root, 'cli/rollout'), { recursive: true });
  const e1 = entry(10), e2 = entry(20), e3 = entry(30);
  const f = path.join(root, 'cli/rollout/model-io-sess_iotest.jsonl');
  writeFileSync(f, e1 + '\n' + e2 + '\n' + e3 + '\n');
  const first = readIoEntries('sess_iotest', 2);
  assert.equal(first.length, 2);
  assert.equal(first[0].request.body.messages[0].content.length, 30);
  assert.equal(first[1].request.body.messages[0].content.length, 20);
  // 命中缓存（TTL 内不再读盘）
  readCalls = 0; readBytes = 0;
  readIoEntries('sess_iotest', 2);
  assert.equal(readCalls, 0);
  // want=1 只回 1 条但缓存仍保留 max(want,2)
  const one = readIoEntries('sess_iotest', 1);
  assert.equal(one.length, 1);
  // readLatestIoEntry 返回最新一条
  const latest = readLatestIoEntry('sess_iotest');
  assert.equal(latest.request.body.messages[0].content.length, 30);
  rmSync(dir, { recursive: true, force: true });
});
