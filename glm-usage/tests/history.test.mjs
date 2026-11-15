import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory, readHistory, strideCap } from '../plugin/mcp/history.mjs';

function freshDir() { return mkdtempSync(join(tmpdir(), 'glm-history-')); }

test('appendHistory 值未变时跳过写盘（mtime 不动）', () => {
  const dir = freshDir();
  const f = join(dir, 'history.json');
  try {
    const t0 = 1_000_000;
    assert.equal(appendHistory(f, { 'cp:0': 100 }, { sampleSeconds: 60, now: t0 * 1000 }), true);
    const before = statSync(f);
    // 同一采样窗口内、值完全一致 → 不写盘
    assert.equal(appendHistory(f, { 'cp:0': 100 }, { sampleSeconds: 60, now: (t0 + 5) * 1000 }), false);
    const after = statSync(f);
    assert.equal(after.mtimeMs, before.mtimeMs, '值未变不应重写文件');
    // 值变化 → 写盘并合并进末条（不新增采样点）
    assert.equal(appendHistory(f, { 'cp:0': 130 }, { sampleSeconds: 60, now: (t0 + 10) * 1000 }), true);
    const h = readHistory(f);
    assert.equal(h.length, 1);
    assert.equal(h[0].values['cp:0'], 130);
    // 跨过采样间隔 → 新增采样点
    assert.equal(appendHistory(f, { 'cp:0': 160 }, { sampleSeconds: 60, now: (t0 + 61) * 1000 }), true);
    assert.equal(readHistory(f).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendHistory 48 小时窗口裁剪与损坏文件自愈', () => {
  const dir = freshDir();
  const f = join(dir, 'history.json');
  try {
    const now = 2_000_000;
    // 预置一条远超 48h 的陈旧样本 + 一条新样本
    writeFileSync(f, JSON.stringify([
      { t: now - 100 * 3600, values: { old: 1 } },
      { t: now - 3600, values: { 'cp:0': 5 } },
    ]));
    appendHistory(f, { 'cp:0': 6 }, { sampleSeconds: 60, now: now * 1000 });
    const h = readHistory(f);
    assert.equal(h.length, 2, '仅裁掉 100h 前的陈旧样本，1h 前与新增样本保留');
    assert.equal(h[1].values['cp:0'], 6);
    // 损坏文件 → readHistory 自愈为空数组，append 正常重建
    writeFileSync(f, '{bad json');
    assert.deepEqual(readHistory(f), []);
    appendHistory(f, { x: 1 }, { sampleSeconds: 60, now: now * 1000 });
    assert.equal(readHistory(f).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sampleSeconds 下限 10 秒且非数值回退 60', () => {
  const dir = freshDir();
  const f = join(dir, 'history.json');
  try {
    const t0 = 3_000_000;
    appendHistory(f, { a: 1 }, { sampleSeconds: 0, now: t0 * 1000 });         // 0 → 回退 60
    appendHistory(f, { a: 2 }, { sampleSeconds: 'x', now: (t0 + 30) * 1000 }); // 非数值 → 60；间隔 30s 不足 → 合并
    assert.equal(readHistory(f).length, 1, '间隔不足 60s 不应新增采样点');
    appendHistory(f, { a: 3 }, { sampleSeconds: 60, now: (t0 + 61) * 1000 });  // 跨 60s → 新增
    assert.equal(readHistory(f).length, 2);
    appendHistory(f, { a: 4 }, { sampleSeconds: 1, now: (t0 + 66) * 1000 });   // 下限 10 → 间隔 5s 仍合并
    assert.equal(readHistory(f).length, 2, 'sampleSeconds 下限 10s，5s 间隔不应新增');
    appendHistory(f, { a: 5 }, { sampleSeconds: 1, now: (t0 + 80) * 1000 });   // 间隔 19s ≥ 10 → 新增
    assert.equal(readHistory(f).length, 3);
    assert.equal(readHistory(f)[2].values.a, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strideCap 步长封顶：≤cap 原样返回，超限等距取样且首尾保留', () => {
  const small = [[1, 10], [2, 20], [3, 30]];
  assert.equal(strideCap(small, 180), small, '未超限应返回原数组引用');
  const pts = Array.from({ length: 999 }, (_, i) => [i, i * 2]);
  const capped = strideCap(pts, 180);
  assert.equal(capped.length, 180);
  assert.deepEqual(capped[0], [0, 0], '首点必含');
  assert.deepEqual(capped[179], [998, 1996], '尾点必含');
  // 等距：相邻取样的原始下标间距恒定（999 点 → 180 点，步长 (998)/(179)）
  const idx = capped.map(p => p[0]);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] - idx[i - 1] >= 5 && idx[i] - idx[i - 1] <= 6, `间距应约 5.57：${idx[i] - idx[i - 1]}`);
  }
  // 时间范围全覆盖：最老与最新样本都在
  assert.equal(capped[0][0], pts[0][0]);
  assert.equal(capped[capped.length - 1][0], pts[pts.length - 1][0]);
});
