import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeEntry } from '../plugin/mcp/context-composition.mjs';
import { panelResource } from '../plugin/mcp/panel-resource.mjs';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import requestMetrics from '../plugin/request-metrics.js';

const entry = (messages, usage = {}) => ({ request: { body: { messages } }, response: { usage } });
test('missing request usage is not mistaken for context compression', () => {
  const deltas = requestMetrics.calculateInputDeltas([
    { input: 66430, status: 'completed' }, { input: 0, status: 'error' },
    { input: 67000, status: 'completed' }, { input: 0, status: 'running' },
    { input: 12000, status: 'completed' },
  ]);
  assert.deepEqual(deltas, [null, null, 570, null, -55000]);
});
test('GLM OpenAI format keeps system, tool calls, tool results and reasoning in sequence', () => {
  const data = categorizeEntry(entry([
    { role: 'system', content: 'Base prompt' },
    { role: 'user', content: 'Read this file' },
    { role: 'assistant', content: 'Reading', reasoning_content: 'Think first', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'export const answer = 42;' },
    { role: 'system', content: 'Additional environment context' },
    { role: 'system', content: 'skills/testing/SKILL.md\nInstructions' },
  ], { prompt_tokens: 1001, completion_tokens: 25 }));
  assert.equal(data.total, 1001);
  assert.equal(data.cats.reduce((sum, c) => sum + c.tokens, 0), 1001);
  assert.equal(data.cats.find(c => c.key === 'tool_results').items[0].title, 'read');
  assert.equal(data.cats.find(c => c.key === 'skill').count, 1);
  assert.equal(data.cats.find(c => c.key === 'injected').count, 1);
  const items = data.cats.flatMap(c => c.items).sort((a, b) => a.seq - b.seq);
  assert.equal(items[0].kind, 'system');
  assert.equal(items.findIndex(i => i.kind === 'tool_use') + 1, items.findIndex(i => i.kind === 'tool_result'));
  for (const c of data.cats) assert.equal(c.tokens, c.items.reduce((sum, i) => sum + i.tokens, 0));
});
test('Anthropic image and tool result weights reconcile without double counting', () => {
  const data = categorizeEntry(entry([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'read', input: { path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'result' }] }, { type: 'image', source: { data: 'not-returned' } }] },
  ], { input_tokens: 57, output_tokens: 3 }));
  assert.equal(data.cats.reduce((n, c) => n + c.tokens, 0), 57);
  assert.equal(data.total, 57);
  assert(!JSON.stringify(data).includes('not-returned'));
});
test('missing provider usage retains nonzero estimates and bounded detail', () => {
  const source = entry([{ role: 'user', content: '<script>alert(1)</script>' + 'x'.repeat(40000) }]);
  const data = categorizeEntry(source);
  assert(data.total > 0); assert(data.estimated);
  const item = data.cats.find(c => c.key === 'user_messages').items[0];
  assert.equal(item.preview.length, 240);
  const detail = categorizeEntry(source, { contentId: item.id }).detail;
  assert.equal(detail.content.length, 32000); assert(detail.truncated);
  assert.equal(detail.id, item.id);
});
test('preview caps do not change category totals or item identity', () => {
  const source = entry(Array.from({ length: 401 }, (_, i) => ({ role: 'user', content: `message ${i}` })), { input_tokens: 9001 });
  const data = categorizeEntry(source);
  const cat = data.cats.find(c => c.key === 'user_messages');
  assert.equal(cat.count, 401); assert.equal(cat.items.length, 400); assert(cat.truncated); assert.equal(cat.tokens, 9001);
  assert.equal(categorizeEntry(source).cats[2].items[0].id, cat.items[0].id);
});
test('MCP resource embeds all assets and every script parses', async () => {
  const html = await panelResource();
  assert(!html.includes('@inline:'));
  assert(!/<script[^>]+src=/.test(html));
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  assert(html.includes('get_context_item')); assert(html.includes('get_activity'));
});

test('marketplace, both manifests, MCP and UI report the same release version', async () => {
  const json = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
  const a = await json('../plugin/.zcode-plugin/plugin.json');
  const b = await json('../plugin/.claude-plugin/plugin.json');
  const market = await json('../../marketplace.json');
  assert.deepEqual(a, b);
  assert.equal(market.plugins.find(p => p.name === a.name).version, a.version);
  const server = await readFile(new URL('../plugin/mcp/server.mjs', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../plugin/bridge.js', import.meta.url), 'utf8');
  assert(server.includes(`const VERSION = "${a.version}"`));
  assert(bridge.includes(`version: "${a.version}"`));
});
