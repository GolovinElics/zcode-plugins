import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpClient } from '../dev/mcp-client.mjs';

test('real MCP transport: recent 600 steps, all-time totals, family, browser and activity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'glm-mcp-test-'));
  mkdirSync(join(root, 'cli/db'), { recursive: true }); mkdirSync(join(root, 'cli/rollout'));
  const db = new DatabaseSync(join(root, 'cli/db/db.sqlite'));
  db.exec(`
    CREATE TABLE session(id TEXT, title TEXT, directory TEXT, parent_id TEXT, task_type TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, time_compacting INTEGER, time_deleted INTEGER);
    CREATE TABLE model_usage(id TEXT, session_id TEXT, started_at INTEGER, completed_at INTEGER, turn_id TEXT, model_id TEXT, status TEXT, query_source TEXT, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, computed_total_tokens INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER, error_type TEXT, finish_reason TEXT, attempt_index INTEGER);
    CREATE TABLE tool_usage(id TEXT, session_id TEXT, tool_call_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, output_bytes INTEGER);
    CREATE TABLE turn_usage(session_id TEXT, started_at INTEGER, cancelled_by_user INTEGER, context_exceeded INTEGER, status TEXT, error_type TEXT);
    CREATE TABLE part(id TEXT, session_id TEXT, message_id TEXT, sequence INTEGER, time_created INTEGER, data TEXT);
    CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE todo(session_id TEXT, status TEXT);
  `);
  const now = Date.now();
  const insertSession = db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?,?,?,?,?)');
  insertSession.run('sess_root', 'Root', '/workspace/a', null, null, now - 3600000, now, null, null, null);
  insertSession.run('sess_child', 'Child', '/workspace/a', 'sess_root', null, now - 10000, now, null, null, null);
  const insertStep = db.prepare('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 605; i++) insertStep.run(`step_${String(i).padStart(4, '0')}`, 'sess_root', now - (605 - i) * 1000, now, 'turn', 'glm-5', 'completed', 'chat', 100 + i, 10, 0, 50, 0, 110 + i, 1000, 100, null, 'stop', 0);
  db.prepare('INSERT INTO tool_usage VALUES(?,?,?,?,?,?,?,?,?,?)').run('tool1', 'sess_root', 'call1', 'bash', 'error', now, 6000, 1, 'process_exit', 100);
  db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('p1', 'sess_root', 'm1', 0, now, JSON.stringify({ type: 'tool', callID: 'call1', tool: 'bash', state: { input: { command: 'node --test', run_in_background: true }, status: 'error' } }));
  for (let i = 0; i < 13; i++) {
    db.prepare('INSERT INTO tool_usage VALUES(?,?,?,?,?,?,?,?,?,?)').run(`extra${i}`, 'sess_root', `extra${i}`, 'bash', 'completed', now - i - 1, 10, 0, null, 0);
    db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(`p_extra${i}`, 'sess_root', 'm1', i + 1, now, JSON.stringify({ type: 'tool', callID: `extra${i}`, tool: 'bash', state: { input: { command: `program${i} --help` }, status: 'completed' } }));
  }
  const io = { request: { body: { model: 'glm-5', messages: [{ role: 'user', content: 'Test context' }] } }, response: { usage: { prompt_tokens: 100, completion_tokens: 10 } }, completedAt: new Date(now).toISOString() };
  writeFileSync(join(root, 'cli/rollout/model-io-sess_root.jsonl'), JSON.stringify(io) + '\n');
  db.close();
  const client = mcpClient({ GLM_ZCODE_DIR: root, GLM_USAGE_DATA_DIR: join(root, 'config') });
  try {
    const init = await client.request('initialize'); assert.equal(init.serverInfo.name, 'glm-usage'); assert.equal(init.serverInfo.icons.length, 2);
    const context = await client.call('get_session_context', { session_id: 'sess_root' });
    assert.equal(context.steps.length, 600); assert.equal(context.session.steps, 605); assert.equal(context.steps_offset, 5);
    assert.equal(context.steps[0].id, 'step_0005'); assert.equal(context.steps.at(-1).id, 'step_0604');
    assert.equal(context.session.token_sums.input, 605 * 100 + 604 * 605 / 2);
    assert.equal(context.stats.commands.length, 12); assert.equal(context.stats.command_calls, 14);
    const fleet = await client.call('get_fleet', { session_id: 'sess_child' });
    assert.equal(fleet.lead.id, 'sess_root'); assert.equal(fleet.summary.running, 2); assert.equal(fleet.lead.context, 704);
    const browser = await client.call('get_context_browser', { session_id: 'sess_root' });
    assert.equal(browser.total, 100); assert.equal(browser.has_previous, false);
    await assert.rejects(client.call('get_context_browser', { session_id: 'sess_root', prev: true }), /上一条/);
    const item = browser.cats.find(c => c.key === 'user_messages').items[0];
    const detail = await client.call('get_context_item', { session_id: 'sess_root', item_id: item.id });
    assert.equal(detail.content, 'Test context');
    await assert.rejects(client.call('get_context_item', { session_id: '../escape', item_id: item.id }), /无效/);
    await assert.rejects(client.call('get_context_item', { session_id: 'sess_root', item_id: 'stale' }), /更新/);
    const activity = await client.call('get_activity', { session_id: 'sess_root', kind: 'commands' });
    assert.equal(activity.rows.length, 14); assert.equal(activity.rows[0].program, 'node'); assert(activity.rows[0].background);
    const insights = await client.call('get_insights', { range: '7d' });
    assert.equal(insights.kpis.steps, 605); assert.equal(insights.sessions[0].context, 704);
    assert(insights.daily[0].session_ids.includes('sess_root'));
    const resource = await client.request('resources/read', { uri: 'ui://glm-usage/panel.html' });
    assert(!resource.contents[0].text.includes('@inline:'));
  } finally { client.close(); rmSync(root, { recursive: true, force: true }); }
});
