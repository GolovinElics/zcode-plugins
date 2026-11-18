import { createHash } from 'node:crypto';

const DEFINITIONS = [
  ['system_prompt', '系统提示词', '#6366f1'], ['tool_schemas', '工具定义', '#f59e0b'],
  ['user_messages', '用户消息', '#22c55e'], ['injected', '注入内容', '#a855f7'],
  ['skill', '技能注入', '#f97316'], ['assistant', '模型消息', '#3b82f6'],
  ['tool_results', '工具结果', '#14b8a6'],
];
const finite = n => Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0;
const stringify = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const textOf = value => Array.isArray(value)
  ? value.map(p => typeof p === 'string' ? p : p.text ?? p.thinking ?? (['image', 'image_url'].includes(p.type) ? '[图片附件]' : '')).join('\n')
  : stringify(value);
const isSkill = text => /(?:SKILL\.md|\bskills?\/|^#+\s*(?:技能|Skill))/im.test(text.slice(0, 500));

// GLM may be recorded through either Anthropic or OpenAI-compatible transports.
// Category values are estimates calibrated to provider input usage, never tokenizer counts.
export function categorizeEntry(entry, { contentId = null, itemCap = 400 } = {}) {
  const body = entry?.request?.body || {};
  const cats = Object.fromEntries(DEFINITIONS.map(([key, label, color]) => [key, { key, label, color, items: [], chars: 0 }]));
  let sequence = 0;
  let detail = null;
  const add = (key, title, value, kind = 'text', images = 0, callId = null) => {
    const text = textOf(value);
    if (Array.isArray(value)) images += value.filter(p => p && ['image', 'image_url'].includes(p.type)).length;
    const seq = sequence++;
    const id = `${key}-${seq}-${createHash('sha1').update(text).digest('hex').slice(0, 10)}`;
    const item = { id, seq, call_id: typeof callId === "string" ? callId : null, title: String(title || key).slice(0, 120), kind, chars: text.length, images,
      preview: text.replace(/\s+/g, ' ').slice(0, 240) };
    cats[key].items.push(item);
    if (id === contentId) detail = { ...item, category: key, label: cats[key].label,
      content: text.slice(0, 32000), truncated: text.length > 32000 };
  };
  const head = text => text.trim().split('\n').find(Boolean)?.slice(0, 80) || '空消息';
  if (body.system) add('system_prompt', '系统提示词', body.system, 'system');
  for (const tool of body.tools || []) add('tool_schemas', tool.name || tool.function?.name || 'tool', tool, 'schema');
  const toolNames = new Map();
  for (const m of body.messages || []) {
    const content = m.content;
    if (m.role === 'system' || m.role === 'developer') {
      const text = textOf(content);
      const key = isSkill(text) ? 'skill' : !cats.system_prompt.items.length ? 'system_prompt' : 'injected';
      add(key, head(text), text, key === 'system_prompt' ? 'system' : key);
    } else if (m.role === 'tool') {
      add('tool_results', toolNames.get(m.tool_call_id) || m.name || '工具结果', content, 'tool_result', 0, m.tool_call_id);
    } else if (m.role === 'user' || m.role === 'assistant') {
      const key = m.role === 'user' ? 'user_messages' : 'assistant';
      if (m.reasoning_content) add('assistant', '思考块', m.reasoning_content, 'thinking');
      if (typeof content === 'string' && content) {
        const injection = m.role === 'user' && /<(?:system-reminder|system_reminder|environment_context|skill_instructions)[\s>]/.test(content);
        add(injection ? (isSkill(content) ? 'skill' : 'injected') : key, head(content), content, m.role === 'assistant' ? 'answer' : 'text');
      }
      for (const p of Array.isArray(content) ? content : []) {
        if (p.type === 'text') add(key, head(p.text || ''), p.text || '', m.role === 'assistant' ? 'answer' : 'text');
        else if (p.type === 'thinking') add('assistant', '思考块', p.thinking || '', 'thinking');
        else if (p.type === 'tool_use') {
          toolNames.set(p.id, p.name);
          add('assistant', `调用 ${p.name}`, { name: p.name, input: p.input }, 'tool_use', 0, p.id);
        } else if (p.type === 'tool_result') {
          add('tool_results', toolNames.get(p.tool_use_id) || '工具结果', p.content, 'tool_result', 0, p.tool_use_id);
        } else if (p.type === 'image' || p.type === 'image_url') {
          const mime = p.source?.media_type || String(p.image_url?.url || '').match(/^data:(image\/[a-z0-9.+-]+);/i)?.[1];
          add(key, '图片附件', mime ? '[图片附件 · ' + String(mime).slice(0, 80) + ']' : '[图片附件]', 'image', 1);
        }
      }
      for (const call of m.tool_calls || []) {
        const fn = call.function || call;
        toolNames.set(call.id, fn.name);
        add('assistant', `调用 ${fn.name || 'tool'}`, { name: fn.name, arguments: fn.arguments }, 'tool_use', 0, call.id);
      }
    }
  }
  const usage = entry?.response?.usage || {};
  const actualInput = finite(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens);
  const actualOutput = finite(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens);
  const items = Object.values(cats).flatMap(c => c.items);
  const raw = item => item.chars / 4 + item.images * 800;
  const rawTotal = items.reduce((sum, item) => sum + raw(item), 0);
  const scale = actualInput > 0 && rawTotal > 0 ? actualInput / rawTotal : 1;
  // Largest-remainder allocation keeps item, category and total values consistent.
  const total = actualInput || Math.round(rawTotal);
  items.forEach(item => { item.tokens = Math.floor(raw(item) * scale); });
  let remainder = total - items.reduce((sum, item) => sum + item.tokens, 0);
  const sorted = [...items].sort((a, b) => (raw(b) * scale % 1) - (raw(a) * scale % 1));
  for (let i = 0; i < sorted.length && remainder > 0; i++, remainder--) sorted[i].tokens++;
  const out = Object.values(cats).map(c => ({ ...c,
    chars: c.items.reduce((sum, item) => sum + item.chars, 0),
    tokens: c.items.reduce((sum, item) => sum + item.tokens, 0),
    count: c.items.length, items: c.items.slice(0, itemCap), truncated: c.items.length > itemCap,
  }));
  out.forEach(c => { c.pct = total > 0 ? Math.round(c.tokens / total * 1000) / 10 : 0; });
  if (detail) detail.tokens = items.find(item => item.id === detail.id)?.tokens || 0;
  return { cats: out, actualInput, actualOutput, total, scale, detail,
    estimated: actualInput === 0, method: actualInput ? 'provider-calibrated' : 'character-estimate' };
}
