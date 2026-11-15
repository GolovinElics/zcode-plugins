import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRICES_BUILTIN, normKey, tokenize, matchScore, recommendFor, normalizeLitellm, normalizeOpenRouter, mergeCatalog, toCny } from '../plugin/mcp/pricing.mjs';
import { mcpClient } from '../dev/mcp-client.mjs';

test('normKey strips vendor/relay prefixes, variant suffixes and lowercases', () => {
  assert.equal(normKey('zai-api/GLM-5.3'), 'glm-5.3');
  assert.equal(normKey('z-ai/glm-5.3:batch'), 'glm-5.3');
  assert.equal(normKey('cloudflare/@cf/zai-org/glm-4.7-flash:free'), 'glm-4.7-flash');
  assert.equal(normKey('GLM-5.3-Flash'), 'glm-5.3-flash');
  assert.equal(tokenize('glm-5.3-flash').join(','), 'glm,5,3,flash');
});

test('matchScore: exact 1, cross-family 0, version-off is a low-confidence fallback, tier-word fallback', () => {
  assert.equal(matchScore('glm-5.3', 'zai/glm-5.3'), 1);
  assert.equal(matchScore('glm-5.3', 'deepseek-flash'), 0);
  const off = matchScore('gpt-5.2', 'gpt-5.1'); // 隔代：作低置信备选而非精确推荐
  assert.ok(off > 0.5 && off < 1);
  assert.ok(matchScore('glm-5.3-flash', 'glm-5.3') >= 0.75); // 前缀兜底
  assert.ok(matchScore('deepseek-chat', 'deepseek-reasoner') < 0.5); // 同族无版本号不足以推荐
});

test('recommendations prefer builtin official CNY, then source tier, with confidence', () => {
  const cat = mergeCatalog({
    litellm: { 'glm-5.3': { in: 1.4, out: 4.4, cur: 'USD', vendor: 'zai', tier: 2 }, 'gpt-5.2': { in: 1.75, out: 14, cur: 'USD', vendor: 'openai', tier: 2 } },
    openrouter: { 'glm-5.3': { in: 0.084, out: 3.6, cur: 'USD', vendor: 'z-ai', tier: 2 } },
  });
  const recs = recommendFor('GLM-5.3', cat, 7.2);
  assert.equal(recs[0].source, 'builtin');
  assert.deepEqual(recs[0].price_cny, [8, 28]);
  const gpt = recommendFor('gpt-5.2', cat, 7.2);
  assert.ok(gpt.length >= 1);
  assert.equal(gpt[0].confidence, 100);
  assert.ok(recommendFor('qwen-max', cat, 7.2).length === 0); // 目录未覆盖 → 无推荐而不是乱猜
});

test('litellm normalization: per-token→per-million, official beats relay on the same key, junk skipped', () => {
  const out = normalizeLitellm({
    'gpt-5.2': { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
    'zai/glm-5.3': { input_cost_per_token: 0.0000014, output_cost_per_token: 0.0000044 },
    'aihubmix/glm-5.3': { input_cost_per_token: 0.00000113, output_cost_per_token: 0.00000394 },
    'broken/x': { input_cost_per_token: null, output_cost_per_token: 0.000002 },
    'zero/y': { input_cost_per_token: 0, output_cost_per_token: 0 },
  });
  assert.equal(out.get('gpt-5.2').in, 1.75);
  assert.equal(out.get('glm-5.3').tier, 2); // 官方 zai 条目压过 aihubmix 中转
  assert.equal(out.get('glm-5.3').in, 1.4);
  assert.ok(!out.has('x') && !out.has('y'));
});

test('openrouter normalization: per-token strings, :batch variants skipped, relay tiers kept when unique', () => {
  const out = normalizeOpenRouter({ data: [
    { id: 'z-ai/glm-5.3', pricing: { prompt: '0.000000084', completion: '0.0000036' } },
    { id: 'z-ai/glm-5.3:batch', pricing: { prompt: '0.00000045', completion: '0.000002' } },
    { id: 'some-relay/gpt-5.2', pricing: { prompt: '0.0000025', completion: '0.000018' } },
    { id: 'bad/no-price', pricing: {} },
  ] });
  assert.equal(out.get('glm-5.3').in, 0.084); // batch 变体被跳过，官方价保留
  assert.equal(out.get('gpt-5.2').tier, 1); // 中转参考
  assert.ok(!out.has('no-price'));
});

test('toCny converts USD with the configured rate and rounds cleanly', () => {
  assert.deepEqual(toCny({ in: 1.75, out: 14, cur: 'USD' }, 7.2), [12.6, 100.8]);
  assert.deepEqual(toCny({ in: 2, out: 8, cur: 'CNY' }, 7.2), [2, 8]);
});

test('builtin catalog covers the four vendors the user asked for', () => {
  for (const prefix of ['glm-', 'deepseek-', 'gpt-', 'claude-']) {
    assert.ok(Object.keys(PRICES_BUILTIN).some(k => k.startsWith(prefix)), prefix);
  }
});

test('MCP end-to-end: set/get/apply recommendations persist normalized keys in config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'glm-price-test-'));
  const client = mcpClient({ GLM_ZCODE_DIR: join(root, 'zcode'), GLM_USAGE_DATA_DIR: join(root, 'data') });
  try {
    const before = await client.call('get_pricing');
    assert.ok(before.catalog.builtin >= 12);
    assert.equal(before.usd_cny, 7.2);
    const rec = before.local_models.length === 0 || before; // 无本地 DB → 本地模型来自配置，初始为空
    assert.deepEqual(before.local_models, []);

    const applied = await client.call('set_prices', { prices: { 'zai-api/GLM-5.3': [8, 28] }, meta: { 'zai-api/GLM-5.3': { source: 'builtin', at: 1 } } });
    assert.equal(applied.applied, 1);
    const cfg = JSON.parse(readFileSync(join(root, 'data/config.json'), 'utf8'));
    assert.deepEqual(cfg.prices['glm-5.3'], [8, 28]); // 归一化键落盘
    assert.equal(cfg.price_meta['glm-5.3'].source, 'builtin');

    const after = await client.call('get_pricing');
    const row = after.local_models.find(m => m.norm === 'glm-5.3');
    assert.ok(row); assert.deepEqual(row.price, [8, 28]);
    assert.ok(row.recs.length >= 1 && row.recs[0].confidence === 100); // 内置推荐命中

    const search = await client.call('get_pricing', { query: 'gpt' });
    assert.ok(search.search.some(s => s.key === 'gpt-5.2'));

    await assert.rejects(() => client.call('set_prices', { prices: { bad: [-1, 2] } }), /价格需为/);
    await assert.rejects(() => client.call('set_prices', { prices: { bad: ['x', 2] } }), /价格需为/);
    await assert.rejects(() => client.call('set_prices', { usd_cny: 99 }), /usd_cny/);
    await assert.rejects(() => client.call('sync_pricing', { source: 'nope' }), /未知价格源/);

    const removed = await client.call('set_prices', { prices: { 'GLM-5.3': null } });
    assert.equal(removed.removed, 1);
    const cleared = await client.call('get_pricing');
    assert.ok(!cleared.local_models.some(m => m.norm === 'glm-5.3'));
  } finally { client.close(); rmSync(root, { recursive: true, force: true }); }
});
