import { categorizeEntry } from '../plugin/mcp/context-composition.mjs';

// Entirely synthetic. No local conversations, credentials or paths are embedded.
export async function fixtureCall(name, args = {}) {
  const now = Date.now();
  const day = i => new Date(now - i * 86400000).toLocaleDateString('en-CA');
  const names = ['优化插件上下文交互与数据联动', '修复工具调用的缓存命中统计', '构建项目知识检索接口', '完善深色主题与键盘导航', '排查请求重试与错误恢复', '整理组件的设计规范'];
  const sessions = names.map((title, i) => ({ id: `sess_demo_${i}`, title, directory: `/workspace/${i < 3 ? 'zcode-plugins' : 'design-system'}`, parent_id: i === 1 || i === 2 ? 'sess_demo_0' : null,
    created: now - (i + 2) * 86400000, updated: now - i * 1420000, archived: i === 5,
    turns: 12 - i, steps: 42 - i * 5, tokens: 2460000 - i * 285000, output: 28500 - i * 2000,
    context: 128600 - i * 17500, window: 200000, model: 'glm-5.3-flash', model_ms: 420000,
    last_msg: ['已完成上下文条目的双向定位，正在验证悬浮与刷新。', '缓存读取与输入总量已经校准。', '请求适配层的测试全部通过。'][i % 3] }));
  const sid = args.session_id || sessions[0].id;
  const sess = sessions.find(s => s.id === sid) || sessions[0];
  const messages = [{ role: 'system', content: '你是 ZCode 编程助手。使用工具检查代码，验证结果后交付。\n保持改动可追踪，保护用户隐私。'.repeat(80) }];
  for (let i = 0; i < 18; i++) {
    messages.push({ role: 'user', content: i === 0 ? '请实现上下文洞察面板，支持分类、DNA 浏览、趋势联动和键盘导航。' : `第 ${i + 1} 轮：请继续检查交互反馈与数据准确性。` });
    messages.push({ role: 'assistant', content: `正在检查第 ${i + 1} 个模块。\n采用统一的选中状态保留列表滚动与焦点。`.repeat(20),
      tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: i % 2 ? 'edit' : 'read', arguments: JSON.stringify({ file_path: `src/components/${['ContextBrowser', 'TrendChart', 'TokenDonut'][i % 3]}.tsx` }) } }] });
    messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: `// ${['ContextBrowser', 'TrendChart', 'TokenDonut'][i % 3]}.tsx\nexport function render() {\n  return { status: "ready", selected: null };\n}\n`.repeat(28) });
  }
  messages.push({ role: 'system', content: '<environment_context>当前项目 zcode-plugins。测试命令 node --test。</environment_context>'.repeat(12) });
  messages.push({ role: 'system', content: '# Skill\nskills/frontend-design/SKILL.md\n保持颜色语义一致。悬浮时突出所选数据，减少动态时关闭动画。'.repeat(30) });
  const entry = { request: { body: { model: 'glm-5.3-flash', messages: args.prev ? messages.slice(0, -5) : messages,
    tools: ['read', 'edit', 'bash', 'glob', 'grep', 'web_search', 'task'].map(name => ({ type: 'function', function: { name, description: `ZCode ${name} tool`, parameters: { type: 'object', properties: { input: { type: 'string' } } } } })) } },
    response: { usage: { prompt_tokens: args.prev ? 122450 : 128600, completion_tokens: 1245 } } };
  const parsed = categorizeEntry(entry, { contentId: args.item_id });
  const live = { ...parsed, model: sess.model, window: 200000, ts: now - 25000, actual_input: parsed.actualInput, actual_output: parsed.actualOutput, request_id: 'demo-request', prev_total: 122450 };
  const steps = Array.from({ length: 72 }, (_, i) => ({ id: `step_${i}`, ts: now - (72 - i) * 45000, turn: `turn_${Math.floor(i / 6) + 1}`, model: sess.model,
    input: 12000 + i * 1600 - (i >= 38 ? 32000 : 0), output: 650 + i % 5 * 120, cache_read: 10000 + i * 1250 - (i >= 38 ? 28000 : 0), cache_write: i % 8 === 0 ? 500 : 0,
    total: 12650 + i * 1600 - (i >= 38 ? 32000 : 0), dur: 4200 + (Math.sin(i * 1.7) + 1) * 16000, ttft: 1300, status: i === 27 ? 'error' : 'completed', error: i === 27 ? 'rate_limit' : null }));
  const kpis = { sessions: 6, archived: 1, turns: 57, steps: 237, tokens: 12460000, input: 12040000, output: 420000,
    cache_read: 10840000, cache_write: 200000, cache_hit: 90.03, tool_calls: 321, tool_ms: 486000, model_ms: 2160000, ttft_ms: 452000, active_ms: 2646000, tps: 246, cost: null };
  const tools = ['read', 'bash', 'edit', 'grep', 'glob', 'web_search'].map((name, i) => ({ name, calls: 86 - i * 13, tool_ms: 86000 - i * 9000, errors: i === 1 ? 3 : 0 }));
  const commands = ['git', 'node', 'pnpm', 'rg', 'curl'].map((program, i) => ({ program, count: 42 - i * 8 }));
  let data;
  switch (name) {
    case 'get_insights': {
      const count = args.range === 'today' ? 1 : args.range === '30d' ? 30 : 7;
      data = { kpis, sessions, tools, commands, models: [], range: args.range,
        daily: Array.from({ length: count }, (_, i) => { const v = (i % 7 + 1) * 280000; return { day: day(count - i - 1), tokens: v, input_t: v * .96, output_t: v * .04, cache_read: v * .86, cache_write: v * .01, steps: 12 + i * 2, sessions: 2 + i % 4 }; }),
        daily7: Array.from({ length: 7 }, (_, i) => { const v = (i % 7 + 1) * 280000; return { day: day(6 - i), tokens: v, input_t: v * .96, output_t: v * .04, cache_read: v * .86, cache_write: v * .01, steps: 12 + i * 2, sessions: 2 + i % 4 }; }),
        heatmap: Array.from({ length: 84 }, (_, i) => ({ day: day(83 - i), tokens: i % 6 ? (i * 53791) % 2400000 : 0, steps: i % 36, sessions: i % 6 ? 1 + i % 5 : 0 })),
        skills: ['computer-use:computer-use', 'browser-use:control-browser', 'skill-creator', 'plugin-creator:plugin-creator', 'screenshot', 'playwright'].map((name, i) => ({ name, calls: 8 - i, last_at: now - i * 600000 })) };
      break;
    }
    case 'get_session_context': data = { session: { ...sess, steps: steps.length, tokens: kpis.tokens, token_sums: kpis, timing: { ...kpis, gen_ms: kpis.model_ms - kpis.ttft_ms } }, stats: { user_msgs: 12, answers: 26, skills: 4, injects: 9, compacts: 1, overflows: 0, tool_calls: 321, tools: tools.map(t => ({ ...t, count: t.calls })), commands }, steps, steps_offset: 0, live, events: [
      { type: 'compact', ts: steps[38].ts, label: '上下文压缩', detail: '上下文经过压缩后继续执行。' },
      { type: 'error', ts: steps[27].ts, label: '请求失败', detail: '模型请求触发速率限制，重试后恢复。' },
      { type: 'spawn', ts: steps[12].ts, label: '派出子代理', detail: '检查缓存命中统计' },
    ] }; break;
    case 'get_context_browser': data = { ...live, session_id: sid, cats: parsed.cats, has_previous: true, total: parsed.total }; break;
    case 'get_context_item': data = parsed.detail; if (!data) throw new Error('条目已更新'); break;
    case 'get_activity': if (args.pick) { data = { kind: args.kind, pick: args.pick, session_ids: [sid], truncated: false }; break; } data = {kind:args.kind,rows:Array.from({length:48},(_,i)=>({id:'activity_'+i,session_id:sid,name:args.kind==='commands'?'bash':['read','edit','bash'][i%3],program:['git','node','pnpm','rg','curl'][i%5],command:args.kind==='commands'?['git diff --stat','node --test tests/context.test.mjs','pnpm build','rg --files src','curl --head https://example.com'][i%5]:null,file:args.kind==='files'?'/workspace/zcode-plugins/src/ContextBrowser.tsx':null,status:i%9===0?'error':'completed',ts:now-i*45000,dur:1200+i%8*1600,background:i%11===0,exit_code:i%9===0?1:0,error_type:i%9===0?'process_exit':null,output_bytes:2000+i*100}))}; break;
    case 'get_fleet': data = { lead: sessions[0], members: sessions.slice(1, 3), summary: { agents: 3, running: 1, work_items: 4, messages: 128 } }; break;
    case 'get_day_sessions': { const ds = String(args.day || ''); const ids = sessions.filter((s, i) => day(i + 2) === ds).map(s => s.id); data = { day: ds, session_ids: ids.length ? ids : [sessions[0].id] }; break; }
    case 'get_usage_json': data = { coding_plan: { level: 'Max', limits: [{ id: 'cp:0', label: '5 小时窗口', total: 600, used: 216, remaining: 384, percent: 36, reset_at: Math.floor(now / 1000) + 7260 }, { id: 'cp:1', label: '每周额度', total: 6000, used: 2520, remaining: 3480, percent: 42, reset_at: Math.floor(now / 1000) + 158400 }] }, plans: [], buckets: [], rates: {}, history: {} }; break;
    case 'get_config': return { content: [{ type: 'text', text: JSON.stringify({ has_key: false, refresh_seconds: 30, insights_available: true, demo: true }) }] };
    case 'get_usage_detail': { const section = { summary: { total: 12460000, daily: 1780000, cacheHit: .9, peakRate: .3 }, totals: Array.from({length:24}, (_,i) => 15000 + i % 7 * 12000), periodTypes: Array.from({length:24}, (_,i) => i % 3 ? 'OFF_PEAK' : 'PEAK'), xTime: Array.from({length:24}, (_,i) => day(0) + ' ' + String(i).padStart(2,'0') + ':00'), items: [{name:'glm-5.3-flash',total:9800000},{name:'glm-5.3',total:2660000}], granularity:'HOUR' }; data = { days:7, model:section, mcp:section }; break; }
    case 'get_health': data = { days: 7, xTime: Array.from({length:7}, (_,i) => day(6-i)), proMax:[112,126,119,134,140,133,144], lite:[74,82,76,88,94,86,98], actual:[61.5,58.2,49.8,64.1,70.3,55.6,67.4], actualN:[87,105,64,138,176,92,60], official:true }; break;
    case 'get_pricing': {
      const rec = (key, i, o, source, tier, conf, name, note) => ({ key, name: name || key, source, vendor: '', tier, cur: source === 'builtin' ? 'CNY' : 'USD', in: i, out: o, note: note || '', confidence: conf, price_cny: [i, o] });
      data = {
        usd_cny: 7.2, prices: { 'glm-5.3-flash': [1.1, 3.6] }, price_meta: { 'glm-5.3-flash': { source: 'builtin', at: now - 3600e3 } },
        local_models: [
          { model: 'GLM-5.3-Flash', norm: 'glm-5.3-flash', calls: 4191, in_t: 987100000, out_t: 1600000, price: [1.1, 3.6], meta: { source: 'builtin', at: now - 3600e3 },
            recs: [rec('glm-5.3-flash', 1.1, 3.6, 'builtin', 2, 100), rec('glm-5.3-flash', 1.08, 3.6, 'litellm', 2, 100, 'zai/glm-5.3-flash')] },
          { model: 'GLM-5.3', norm: 'glm-5.3', calls: 1134, in_t: 243100000, out_t: 800000, price: null, meta: null,
            recs: [rec('glm-5.3', 8, 28, 'builtin', 2, 100), rec('glm-5.3', 10.08, 31.68, 'litellm', 2, 100, 'zai/glm-5.3'), rec('glm-5.3', 0.6, 25.92, 'openrouter', 2, 100, 'z-ai/glm-5.3')] },
        ],
        catalog: { builtin: 12, sources: { litellm: { count: 5994, at: now - 7200e3, label: 'LiteLLM 社区目录' }, openrouter: { count: 467, at: now - 7200e3, label: 'OpenRouter 直连/中转' } } },
        ...(args.query ? { search: [rec('gpt-5.2', 12.6, 100.8, 'builtin', 2, 0), rec('gpt-5.1', 9, 72, 'builtin', 2, 0)] } : {}),
      }; break;
    }
    case 'sync_pricing': await new Promise(r => setTimeout(r, 600)); data = { source: args.source, label: args.source === 'litellm' ? 'LiteLLM 社区目录' : 'OpenRouter 直连/中转', count: args.source === 'litellm' ? 5994 : 467, at: now }; break;
    case 'set_prices': data = { applied: Object.values(args.prices || {}).filter(v => v != null).length, removed: Object.values(args.prices || {}).filter(v => v == null).length, total: 2, usd_cny: args.usd_cny || 7.2, demo: true }; break;
    default: throw new Error('演示预览不保存配置');
  }
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] };
}
