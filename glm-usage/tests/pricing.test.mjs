import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRICES_BUILTIN, normKey, tokenize, matchScore, recommendFor, normalizeLitellm, normalizeOpenRouter, mergeCatalog, toCny, costFrom } from '../plugin/mcp/pricing.mjs';
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
  assert.deepEqual(recs[0].price_cny, [8, 28, 2, null]); // 缓存命中价随内置目录带出
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

test('cache prices flow through normalizers and merge (read + write, missing → null, 0 = free kept)', () => {
  const lit = normalizeLitellm({
    'anthropic/claude-sonnet-4.6': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, cache_read_input_token_cost: 0.0000003, cache_creation_input_token_cost: 0.00000375 },
    'relay/glm-5.2': { input_cost_per_token: 0.0000014, output_cost_per_token: 0.0000044, cache_read_input_token_cost: 0 }, // 0 = 缓存免费，保留
  });
  assert.deepEqual([lit.get('claude-sonnet-4.6').cr, lit.get('claude-sonnet-4.6').cw], [0.3, 3.75]);
  assert.equal(lit.get('glm-5.2').cr, 0);
  const or = normalizeOpenRouter({ data: [
    { id: 'deepseek/deepseek-chat', pricing: { prompt: '0.00000025', completion: '0.00000095', input_cache_read: '0.00000013' } },
  ] });
  assert.deepEqual([or.get('deepseek-chat').cr, or.get('deepseek-chat').cw], [0.13, null]);
  // 同键同级（两条中转归一为同一裸键）：一方缺缓存价时由同级条目补齐
  const or2 = normalizeOpenRouter({ data: [
    { id: 'relay-a/gpt-5.2', pricing: { prompt: '0.0000025', completion: '0.000018' } },
    { id: 'relay-b/gpt-5.2', pricing: { prompt: '0.0000025', completion: '0.000018', input_cache_read: '0.00000025' } },
  ] });
  assert.equal(or2.get('gpt-5.2').cr, 0.25);
});

test('costFrom: cache tokens priced separately, unconfigured cache falls back to input price', () => {
  const p4 = [8, 28, 2]; // GLM-5.3：输入 8 / 输出 28 / 缓存读 2（¥/百万）
  // 1M 输入其中 0.8M 缓存命中：0.2×8 + 0.8×2 = 3.2（若缓存按输入价则为 8）
  assert.equal(costFrom(p4, 1_000_000, 0, 800_000, 0), 3.2);
  // 缓存写（Claude 口径，写价 1.25 倍）：[3, 15, 0.3, 3.75]
  const claude = [3, 15, 0.3, 3.75];
  assert.equal(costFrom(claude, 1_000_000, 100_000, 0, 500_000), (0.5 * 3 + 0.5 * 3.75 + 0.1 * 15));
  // 未配置缓存价 → 缓存部分按输入价（保守，与旧行为一致）
  assert.equal(costFrom([8, 28], 1_000_000, 0, 800_000, 0), 8);
  // 负数/垃圾缓存量被钳到 0；价格缺失返回 null
  assert.equal(costFrom(p4, 1_000_000, 0, -5, 0), 8);
  assert.equal(costFrom(null, 1, 1), null);
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
  assert.deepEqual(toCny({ in: 1.75, out: 14, cr: 0.175, cur: 'USD' }, 7.2), [12.6, 100.8, 1.26, null]);
  assert.deepEqual(toCny({ in: 2, out: 8, cr: 2, cur: 'CNY' }, 7.2), [2, 8, 2, null]);
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

    // 缓存价：4 元组（null 占位剔除后落盘），推荐里带出缓存价
    await client.call('set_prices', { prices: { 'gpt-5.2': [1.75, 14, 0.175, null] } });
    const cfg2 = JSON.parse(readFileSync(join(root, 'data/config.json'), 'utf8'));
    assert.deepEqual(cfg2.prices['gpt-5.2'], [1.75, 14, 0.175]);
    const rowCache = (await client.call('get_pricing')).local_models.find(m => m.norm === 'gpt-5.2');
    assert.deepEqual(rowCache.price, [1.75, 14, 0.175]);
    assert.equal(rowCache.recs[0].price_cny[2], 1.26); // 内置目录 OpenAI 缓存读价按汇率换算

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
