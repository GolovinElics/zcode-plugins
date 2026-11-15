/* Geometry and coordinated chart interactions, adapted from dsh-context v0.84.1. */
/* 按需日筛选：get_insights 响应不再内联 session_ids，点日期后经 get_day_sessions({ day }) 按需查询并在此缓存（day → Set）。
   get_insights 每次刷新调用 invalidateDaySessions() 整体失效（app.js loadInsights 成功路径）；未命中时 renderSessions 先以
   dateKey(s.updated)===day 兜底渲染，再异步取数修正（不阻塞渲染）。 */
const daySessionsCache = new Map();
const daySessionsPending = new Set(); /* 在途日期去重：同一天最多一个并发请求（对应 requestTickets/inFlight 的 inFlight 角色） */
async function requestDaySessions(day) {
  if (daySessionsPending.has(day)) return;
  daySessionsPending.add(day);
  try {
    const data = await callTool('get_day_sessions', { day });
    daySessionsPending.delete(day);
    daySessionsCache.set(day, new Set(Array.isArray(data?.session_ids) ? data.session_ids : []));
    if (state.day !== day) return; /* 迟到丢弃：日期已切换/取消时不再触发重渲染（结果仍入缓存备复用） */
    renderSessions();
  } catch (e) {
    daySessionsPending.delete(day); /* 失败静默降级：保持 dateKey 兜底结果，不提示、不缓存，下次渲染按需重试 */
  }
}
function invalidateDaySessions() { daySessionsCache.clear(); }
function donut(segs, centerTop, centerSub, size = 118) {
  const total = segs.reduce((a, s) => a + Math.max(0, Number(s.v) || 0), 0);
  let acc = 0;
  const arcs = segs.map((s, i) => {
    if (!(s.v > 0)) return '';
    const pct = s.v / total * 100, cut = segs.filter(s => s.v > 0).length > 1 ? Math.min(.25, pct / 4) : 0;
    const offset = 125 - acc - cut; acc += pct;
    return `<circle class="segArc" data-slice="${esc(s.n || String(i))}" style="--i:${i}" fill="none" stroke-width="4" cx="21" cy="21" r="15.9155" stroke="${s.c}" stroke-dasharray="${(pct - cut * 2).toFixed(3)} ${(100 - pct + cut * 2).toFixed(3)}" stroke-dashoffset="${offset.toFixed(3)}"/>`;
  }).join('');
  return `<div class="lc-donut" style="width:${size}px;height:${size}px"><svg viewBox="0 0 42 42" width="${size}" height="${size}" aria-hidden="true">${arcs || '<circle class="lc-donut-track" fill="none" stroke-width="4" cx="21" cy="21" r="15.9155"/>'}</svg><div class="lc-donut-center" data-value="${esc(centerTop)}" data-label="${esc(centerSub || '')}"><b style="font-size:${Math.max(11, Math.round(size * .13))}px">${esc(centerTop)}</b>${centerSub != null ? `<span style="font-size:${Math.max(9, Math.round(size * .095))}px">${esc(centerSub)}</span>` : ''}</div></div>`;
}
function donutLegendBlock(segs, centerTop, centerSub, size, timing = false) {
  const total = segs.reduce((a, s) => a + s.v, 0) || 1;
  return `<div class="donutWrap">${donut(segs, centerTop, centerSub, size)}<div class="legendGrid">${segs.map((s, i) => {
    const value = (timing ? durMs(s.v) : cnum(s.v)) + (s.sub ? ' · ' + s.sub : ''), pct = Math.round(s.v / total * 1000) / 10;
    return `<button class="lgRow" data-slice="${esc(s.n || String(i))}" data-value="${esc(value)}" data-label="${esc(s.n)}" data-tip="${esc(s.n)} · ${timing ? durMs(s.v) : fmt(s.v) + ' tokens'}${s.sub ? ' · ' + esc(s.sub) : ''} · ${pct}%\n点击固定高亮，再次点击或按 Esc 取消" aria-pressed="false"><i style="background:${s.c}"></i><span class="n">${esc(s.n)}</span><span class="p">${pct}%</span><span class="v">${esc(value)}</span></button>`;
  }).join('')}</div></div>`;
}
function dateKey(value) {
  const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function renderDaily(d) {
  if (!d) return;
  const count = 7; /* 近 7 天用量固定展示最近 7 天，不随全局范围筛选变化（对齐 dsh-context）；数据来自服务端固定的 daily7 序列 */
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const source = new Map((d.daily7 || d.daily || []).map(x => [x.day, x]));
  const rows = Array.from({ length: count }, (_, i) => { const date = new Date(today); date.setDate(date.getDate() - count + i + 1); const day = dateKey(date); return source.get(day) || { day, tokens: 0, steps: 0, sessions: 0 }; });
  const max = Math.max(1, ...rows.map(x => x.tokens));
  const maxCost = Math.max(0, ...rows.map(x => Number(x.cost) || 0));
  document.getElementById('insDailyTitle').textContent = '近 7 天用量';
  const costAll = rows.reduce((a, x) => a + (Number(x.cost) || 0), 0);
  document.getElementById('insDailySub').textContent = `${cnum(rows.reduce((a, x) => a + x.tokens, 0))} tokens` + (costAll > 0 ? ` · ¥${costAll.toFixed(2)}（仅计价模型）` : '');
  const ticks = [1, .75, .5, .25, 0];
  // 费用轴对齐 dsh：顶档为实际最大值，0 档不带 ¥；范围内无计价数据时用 ¥— 占位，位置保留
  const yuanTick = f => f === 0 ? '0' : maxCost > 0 ? '¥' + (Math.round(maxCost * f * 100) / 100) : '¥—';
  patchHTML('insDailyChart', `<div class="dailyAxis">${ticks.map(f => `<span>${cnum(max * f)}</span>`).join('')}</div><div class="dailyPlot">${rows.map((x, i) => {
    const cr = x.cache_read || 0, input = Math.max((x.input_t || 0) - cr, 0), output = x.output_t || 0, cost = Number(x.cost) || 0;
    const h = n => (n / max * 100).toFixed(3);
    const hc = maxCost > 0 ? (cost / maxCost * 100).toFixed(3) : '0';
    const showLabel = count <= 7 || i % 5 === 0 || i === count - 1;
    return `<span class="col" role="img" aria-label="${x.day}，Token ${fmt(x.tokens)}，缓存 ${cnum(cr)} · 输入 ${cnum(input)} · 输出 ${cnum(output)}${cost > 0 ? `，费用 ¥${cost.toFixed(2)}` : ''}" data-tip="${x.day} · Token ${fmt(x.tokens)}\n缓存 ${cnum(cr)} · 输入 ${cnum(input)} · 输出 ${cnum(output)}${cost > 0 ? `\n费用 ¥${cost.toFixed(2)}（仅计价模型）` : ''}"><span class="tv">${showLabel && x.tokens > 0 ? cnum(x.tokens) : ''}</span><span class="pair"><span class="bar"><i style="height:${h(output)}%;background:#f59e0b"></i><i style="height:${h(input)}%;background:#3b82f6"></i><i style="height:${h(cr)}%;background:#22c55e"></i></span><span class="bar cost"><i style="height:${hc}%;background:#06b6d4"></i></span></span><span class="lb">${count <= 7 || i % 5 === 0 || i === count - 1 ? x.day.slice(5) : ''}</span></span>`;
  }).join('')}</div><div class="dailyAxis costAxis">${ticks.map(f => `<span>${yuanTick(f)}</span>`).join('')}</div>`);
}
function renderHeatmap(d) {
  if (!d) return;
  const values = new Map((d.heatmap || []).map(x => [x.day, x]));
  const end = new Date(); end.setHours(0, 0, 0, 0);
  // 对齐 dsh：周日对齐的周列 × 8 周，跨月列上浮月份标签，行标仅周一/三/五，会话 / Token 消耗双指标离散 5 级色阶
  const weeks = 8;
  const lastSunday = new Date(end); lastSunday.setDate(lastSunday.getDate() - lastSunday.getDay());
  const start = new Date(lastSunday); start.setDate(start.getDate() - 7 * (weeks - 1));
  const mode = state.heatMode === 'sessions' ? 'sessions' : 'tokens';
  const max = Math.max(1, ...(d.heatmap || []).map(x => mode === 'sessions' ? (x.sessions || 0) : x.tokens));
  const level = n => n <= 0 || max <= 0 ? 0 : (n /= max) <= .25 ? 1 : n <= .5 ? 2 : n <= .75 ? 3 : 4;
  let cols = '';
  for (let w = 0; w < weeks; w++) {
    const sun = new Date(start); sun.setDate(sun.getDate() + 7 * w);
    const sat = new Date(sun); sat.setDate(sat.getDate() + 6);
    const opens = w === 0 || sun.getMonth() !== sat.getMonth() || sun.getDate() === 1;
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const date = new Date(sun); date.setDate(date.getDate() + i); const day = dateKey(date);
      if (date > end) { cells += '<span class="hcell future" aria-hidden="true"></span>'; continue; }
      const v = values.get(day) || { tokens: 0, sessions: 0 };
      const tip = `${day}\n${v.sessions || 0} 个活跃会话\n${fmt(v.tokens)} token`;
      cells += `<button data-day="${day}" class="hcell l${level(mode === 'sessions' ? (v.sessions || 0) : v.tokens)}${state.day === day ? ' selected' : ''}" aria-pressed="${state.day === day}" data-tip="${tip}" aria-label="${day}，${v.sessions || 0} 个活跃会话，${fmt(v.tokens)} token"></button>`;
    }
    cols += `<div class="hcol">${opens ? `<span class="hmon" aria-hidden="true">${sat.getMonth() + 1}月</span>` : ''}${cells}</div>`;
  }
  patchHTML('insHeatGrid', `<div class="hwds" aria-hidden="true">${[0, 1, 2, 3, 4, 5, 6].map(r => `<span class="hwd">${r === 1 ? '星期一' : r === 3 ? '星期三' : r === 5 ? '星期五' : ''}</span>`).join('')}</div><div class="hcols">${cols}</div>`);
  patchHTML('insHeatScale', '<span>少</span>' + [0, 1, 2, 3, 4].map(l => `<i class="hcell l${l}"></i>`).join('') + '<span>多</span>');
}
const SESS_PAGE = 12;
function pagerPages(cur, total) {
  const pages = [...new Set([1, total, cur - 1, cur, cur + 1])].filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
  const out = []; let prev = 0;
  for (const p of pages) { if (p - prev > 1) out.push('…'); out.push(p); prev = p; }
  return out;
}
function renderSessions() {
  const all = state.insights?.sessions || [], groups = new Map();
  // 分组对齐 dsh 工作区语义：ZCode 未命名草稿工作区（.zcode/workspace/draft-*）聚合为「草稿」，真实目录按路径分组
  const DRAFT_RE = /\.zcode\/workspace\/draft-/;
  const groupKeyOf = s => { const d = String(s.directory || ''); return !d ? '' : DRAFT_RE.test(d) ? '@draft' : d; };
  const groupLabel = key => !key ? '未分组' : key === '@draft' ? '草稿' : dirName({ directory: key });
  const groupTip = key => !key ? '无目录信息' : key === '@draft' ? 'ZCode 未命名草稿工作区（.zcode/workspace/draft-*）聚合展示' : key;
  all.forEach(s => { const key = groupKeyOf(s); groups.set(key, (groups.get(key) || 0) + 1); });
  patchHTML('sessGroups', `<button class="gchip ${!state.group ? 'on' : ''}" data-group="" aria-pressed="${!state.group}">全部 <b>${all.length}</b></button>` + [...groups].map(([key, n]) => `<button class="gchip ${state.group === key ? 'on' : ''}" data-group="${esc(key)}" data-tip="${esc(groupTip(key))}" aria-pressed="${state.group === key}">${esc(groupLabel(key))} <b>${n}</b></button>`).join(''));
  if (state.group && !all.some(s => groupKeyOf(s) === state.group)) state.group = '';
  /* 日筛选数据源：day 为空 → 不过滤；缓存命中 → 直接用；未命中 → dateKey 兜底先行渲染并异步取数修正（requestDaySessions） */
  let daySessions = null;
  if (state.day) {
    daySessions = daySessionsCache.get(state.day) || null;
    if (!daySessions) requestDaySessions(state.day);
  }
  let list = all.filter(s => (!state.group || groupKeyOf(s) === state.group) && (!state.archive || !s.archived)
    && (!state.search || `${s.title} ${s.directory} ${s.last_msg || ''} ${s.model || ''}`.toLowerCase().includes(state.search))
    && (!state.day || (daySessions ? daySessions.has(s.id) : dateKey(s.updated) === state.day))
    && (!state.pick || state.pick.sessions == null || state.pick.sessions.has(s.id)));
  list = list.slice().sort((a, b) => (b[state.sortKey] || 0) - (a[state.sortKey] || 0));
  // 当前会话在筛选结果内置顶并标注（对齐 dsh：全部或所在分组选中时排第一）
  const currentId = state.insights?.current_id || null;
  if (currentId) { const at = list.findIndex(s => s.id === currentId); if (at > 0) list.unshift(list.splice(at, 1)[0]); }
  document.getElementById('insSessCount').textContent = `${list.length} / ${all.length} 个${state.day ? ' · ' + state.day : ''}`;
  document.getElementById('clearSessionFilters').hidden = !(state.day || state.group || state.search || state.archive || state.pick);
  // 排行行筛选 chip（对齐 dsh lc-ov-day-chip：可单击清除）
  updatePickChip();
  /* 分页（比 dsh 前后页翻页多数字页码）：筛选/排序变化回第一页；新选中会话自动跳到所在页；背景刷新保持当前页 */
  const filterSig = [state.search, state.group, state.archive, state.day, state.sortKey, state.pick ? state.pick.kind + ':' + state.pick.name : ''].join('|');
  if (renderSessions.filterSig != null && renderSessions.filterSig !== filterSig) state.sessPage = 1;
  renderSessions.filterSig = filterSig;
  if (state.sessionId && state.sessPageFor !== state.sessionId) {
    const at = list.findIndex(s => s.id === state.sessionId);
    if (at >= 0) state.sessPage = Math.floor(at / SESS_PAGE) + 1;
    state.sessPageFor = state.sessionId;
  } else if (!state.sessionId) state.sessPageFor = null;
  const pageCount = Math.max(1, Math.ceil(list.length / SESS_PAGE));
  state.sessPage = Math.min(Math.max(1, Math.floor(state.sessPage) || 1), pageCount);
  const pageRows = list.slice((state.sessPage - 1) * SESS_PAGE, state.sessPage * SESS_PAGE);
  const pager = pageCount > 1 ? `<nav class="pager" role="navigation" aria-label="会话分页" data-pages="${pageCount}"><button class="pgBtn" data-pg="prev" aria-label="上一页"${state.sessPage <= 1 ? ' disabled' : ''}>‹</button>${pagerPages(state.sessPage, pageCount).map(p => p === '…' ? '<span class="pgGap">…</span>' : `<button class="pgBtn${p === state.sessPage ? ' on' : ''}" data-pg="${p}"${p === state.sessPage ? ' aria-current="page"' : ''}>${p}</button>`).join('')}<button class="pgBtn" data-pg="next" aria-label="下一页"${state.sessPage >= pageCount ? ' disabled' : ''}>›</button><span class="pgInfo">第 ${state.sessPage} / ${pageCount} 页</span></nav>` : '';
  patchHTML('insSessions', pageRows.map(s => {
    const pct = s.window ? Math.round(s.context / s.window * 1000) / 10 : null;
    const parts = (s.parts || []).filter(p => p.tokens > 0), partSum = parts.reduce((a, p) => a + p.tokens, 0);
    const center = cnum(s.context), sub = pct == null ? '上下文' : pct + '%';
    const ring = parts.length
      ? donut(parts.map(p => ({ v: p.tokens, c: p.color })), center, sub, 76)
      : donut([{ v: s.context, c: '#3b82f6' }, { v: Math.max((s.window || s.context) - s.context, 0), c: 'var(--bd)' }], center, sub, 76);
    const ringTip = parts.length
      ? '当前上下文构成（最近一次请求）\n' + parts.map(p => `${p.label} ${cnum(p.tokens)} · ${partSum ? Math.round(p.tokens / partSum * 1000) / 10 : 0}%`).join('\n')
      : '无构成数据（无 model-io 记录或超出预解析范围）\n环显示上下文窗口占用';
    const cur = s.id === currentId;
    return `<button class="sCard${cur ? ' cur' : ''}${s.id === state.sessionId ? ' on' : ''}" data-sid="${esc(s.id)}" aria-label="查看会话：${esc(s.title)}"><div class="sHead"><span class="sTitle">${esc(s.title || '无标题会话')}</span>${cur ? '<span class="curBadge">当前</span>' : ''}<span class="sTimes"><span class="sTime">${agoTs(s.updated)}</span><span class="sCreated">${dateKey(s.created)}</span></span></div><div class="sCrumb"><span class="sPill" data-tip="${esc(s.directory)}">${esc(groupLabel(groupKeyOf(s)))}</span>${s.parent_id ? '<span class="sPill">子代理</span>' : ''}${s.archived ? '<span class="sPill">已归档</span>' : ''}<span class="sPill">${esc(s.model || '未知模型')}</span></div><div class="sBody"><div class="sRing" data-tip="${esc(ringTip)}">${ring}</div><div class="sStats"><div class="sStat"><span class="k">轮次</span><span class="v">${s.turns} 轮 ${s.steps} 步</span></div><div class="sStat"><span class="k">Token 总用量</span><span class="v">${cnum(s.tokens)}</span></div><div class="sStat"><span class="k">上下文窗口</span><span class="v">${cnum(s.window)}</span></div></div></div><div class="sPreview"><span class="k">最新消息</span><span class="v" data-tip="${esc(s.last_msg || '')}">${esc(s.last_msg || '暂无文本消息')}</span><span class="cardArrow" aria-hidden="true">↗</span></div></button>`;
  }).join('') + pager || '<div class="empty">当前筛选没有匹配会话。可清除筛选或扩大时间范围。</div>');
}

let trendValues = [];
function renderTrend() {
  const data = state.ctx, steps = data?.steps || [], box = document.getElementById('ctxTrend');
  if (!steps.length) { trendValues = []; state.trendHover = null; state.trendKey = null; renderTrend.signature = null; patchHTML('ctxTrend', '<div class="empty">该会话暂无模型请求记录</div>'); document.getElementById('ctxTrendDetail').hidden = true; return; }
  const sig = JSON.stringify([data.session.id, state.trendMode, steps]);
  if (renderTrend.signature === sig) { updateTrendPick(); return; }
  renderTrend.signature = sig;
  const offset = data.steps_offset || 0, deltaMode = state.trendMode === 'delta';
  const deltas = calculateInputDeltas(steps);
  trendValues = steps.map((s, i) => ({ ...s, key: s.id || String(s.ts) + '-' + i, number: offset + i + 1,
    cr: s.cache_read, cw: s.cache_write, fi: Math.max(s.input - s.cache_read - s.cache_write, 0), ou: s.output,
    delta: deltas[i] }));
  document.getElementById('trendCount').textContent = `${data.session.steps || steps.length} 步${offset ? ' · 展示最近 ' + steps.length + ' 步' : ''}`;
  patchHTML('trendLegend', deltaMode ? '<span><i style="background:#3b82f6"></i>输入增长</span><span><i style="background:#e5735f"></i>输入减少</span><span>相对上一有效请求 · 无上报值不计算</span>' : '<span><i style="background:#22c55e"></i>缓存读</span><span><i style="background:#a855f7"></i>缓存写</span><span><i style="background:#3b82f6"></i>新输入</span><span><i style="background:#f59e0b"></i>输出</span><span>⌁ 耗时</span>');
  const H = 190, top = 24, bottom = 158, plotH = bottom - top, slot = 17, left = 42, width = left + steps.length * slot + 42;
  const max = Math.max(1, ...trendValues.map(v => deltaMode ? Math.abs(v.delta || 0) : v.input + v.output));
  const maxDur = Math.max(1, ...steps.map(v => v.dur || 0));
  const y = n => deltaMode ? (top + bottom) / 2 - n / max * plotH / 2 : bottom - n / max * plotH;
  let svg = '';
  for (const f of deltaMode ? [-1, -.5, 0, .5, 1] : [0, .25, .5, .75, 1]) {
    const yy = y(max * f); svg += `<line x1="${left}" x2="${width - 42}" y1="${yy}" y2="${yy}" class="trendGrid"/><text x="${left - 5}" y="${yy + 3}" text-anchor="end" class="axisText">${f < 0 ? '−' : ''}${cnum(Math.abs(max * f))}</text>`;
  }
  const points = [];
  trendValues.forEach((v, i) => {
    const x = left + i * slot, label = `第 ${v.number} 步 · 输入 ${fmt(v.input)} · 输出 ${fmt(v.output)} · ${durMs(v.dur)}`;
    svg += `<g data-step="${esc(v.key)}" data-index="${i}" role="button" tabindex="${state.trendKey === v.key || !state.trendKey && i === steps.length - 1 ? 0 : -1}" aria-label="${esc(label)}" aria-pressed="${state.trendKey === v.key}"><rect x="${x}" y="${top - 4}" width="15" height="${plotH + 8}" class="trendHit" rx="2"/>`;
    if (deltaMode) {
      const n = v.delta || 0; svg += `<rect x="${x + 1}" y="${Math.min(y(n), y(0))}" width="13" height="${Math.abs(y(n) - y(0))}" rx="1" fill="${n < 0 ? '#e5735f' : '#3b82f6'}" class="trendFill"/>`;
    } else {
      let sum = 0;
      for (const [key, color] of [['cr', '#22c55e'], ['cw', '#a855f7'], ['fi', '#3b82f6'], ['ou', '#f59e0b']]) {
        const value = v[key] || 0; if (value > 0) svg += `<rect x="${x + 1}" y="${y(sum + value)}" width="13" height="${Math.max(.35, value / max * plotH)}" fill="${color}" class="trendFill"/>`; sum += value;
      }
    }
    if (v.status === 'error') svg += `<circle cx="${x + 7}" cy="${top - 10}" r="3" fill="var(--bad)"/>`;
    if (i % 5 === 0) svg += `<text x="${x + 7}" y="12" text-anchor="middle" class="axisText">${v.number}</text>`;
    svg += '</g>';
    if (i === 0 || steps[i - 1].turn !== v.turn) svg += `<text x="${x + 3}" y="179" class="axisText">${esc(v.turn || '—')}</text>`;
    points.push([x + 7, bottom - v.dur / maxDur * plotH]);
  });
  if (!deltaMode) {
    svg += `<path d="${monotonePath(points)}" fill="none" class="durationLine"/>`;
    for (const f of [0, .5, 1]) svg += `<text x="${width - 36}" y="${bottom - f * plotH + 3}" class="axisText">${durMs(maxDur * f)}</text>`;
  }
  const oldScroll = box.querySelector('.trendScroll'); const follow = !oldScroll || oldScroll.scrollWidth - oldScroll.clientWidth - oldScroll.scrollLeft < 25;
  patchHTML('ctxTrend', `<div class="trendScroll" tabindex="0" aria-label="模型请求趋势，左右方向键浏览请求"><svg viewBox="0 0 ${width} ${H}" style="width:${width}px;height:${H}px" aria-label="${deltaMode ? '输入增量' : '请求 Token'}趋势">${svg}</svg></div><div class="trendHint">悬浮查看 · 点击固定 · ← → 切换请求 · Esc 取消</div>`);
  const scroll = box.querySelector('.trendScroll'); if (follow && !state.trendKey) scroll.scrollLeft = scroll.scrollWidth;
  box.onpointerover = e => { const g = e.target.closest('[data-step]'); if (!g) return; hoverTrend(g); };
  box.onpointerout = e => { if (!e.relatedTarget?.closest?.('[data-step]')) { state.trendHover = null; updateTrendPick(); hideTip(); } };
  box.onfocusout = e => { if (!e.relatedTarget?.closest?.('[data-step]')) { state.trendHover = null; updateTrendPick(); } };
  box.onfocusin = e => { const g = e.target.closest('[data-step]'); if (g) hoverTrend(g); };
  box.onclick = e => { const g = e.target.closest('[data-step]'); if (g) pickTrend(g.dataset.step); };
  box.onkeydown = e => {
    const g = e.target.closest('[data-step]');
    if (e.key === 'Escape') { state.trendKey = null; state.trendHover = null; updateTrendPick(); hideTip(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && g) { e.preventDefault(); pickTrend(g.dataset.step); }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); const nodes = [...box.querySelectorAll('[data-step]')], at = nodes.indexOf(g);
      const idx = e.key === 'Home' ? 0 : e.key === 'End' ? nodes.length - 1 : Math.max(0, Math.min(nodes.length - 1, at + (e.key === 'ArrowRight' ? 1 : -1)));
      nodes.forEach(n => { n.tabIndex = -1; }); nodes[idx].tabIndex = 0; nodes[idx].focus(); reveal(nodes[idx]);
      if (state.trendKey) { state.trendKey = nodes[idx].dataset.step; updateTrendPick(); }
    }
  };
  updateTrendPick();
}
function hoverTrend(group) {
  state.trendHover = group.dataset.step; updateTrendPick();
  document.querySelectorAll('#ctxTrend .hovered').forEach(el => el.classList.remove('hovered')); group.classList.add('hovered');
  const v = trendValues[Number(group.dataset.index)];
  showTip(group, `第 ${v.number} 步 · ${v.model}\n${new Date(v.ts).toLocaleString('zh-CN')}\n输入 ${fmt(v.input)} · 输出 ${fmt(v.output)}\n缓存读 ${fmt(v.cr)} · 缓存写 ${fmt(v.cw)}\n耗时 ${durMs(v.dur)}${state.trendMode === 'delta' ? '\n输入变化 ' + (v.delta == null ? (v.input > 0 ? '无上一有效请求' : '未报告输入') : (v.delta > 0 ? '+' : '') + fmt(v.delta)) : ''}${v.status === 'error' ? '\n请求失败：' + (v.error || '未知错误') : ''}`);
}
function pickTrend(key) { state.trendHover = null; state.trendKey = state.trendKey === key ? null : key; updateTrendPick(); }
function updateTrendPick() {
  document.querySelectorAll('#ctxTrend [data-step]').forEach(g => { g.classList.toggle('selected', g.dataset.step === state.trendKey); g.classList.toggle('hovered', g.dataset.step === state.trendHover); g.setAttribute('aria-pressed', String(g.dataset.step === state.trendKey)); });
  const active = state.trendHover || state.trendKey;
  document.querySelectorAll('#ctxEvents [data-event-ts]').forEach(row => {
    const nearest = trendValues.reduce((best, v) => !best || Math.abs(v.ts - Number(row.dataset.eventTs)) < Math.abs(best.ts - Number(row.dataset.eventTs)) ? v : best, null);
    row.classList.toggle('eventHot', !!active && nearest?.key === active);
  });
  const v = trendValues.find(v => v.key === active), el = document.getElementById('ctxTrendDetail'); el.hidden = !v;
  if (!v) return;
  patchHTML('ctxTrendDetail', `<div class="hd"><b>${state.trendHover && state.trendHover !== state.trendKey ? '预览' : '已固定'} · 第 ${v.number} 步</b><span class="tm">${new Date(v.ts).toLocaleString('zh-CN')}</span><button class="textButton" onclick="state.trendKey=null;state.trendHover=null;updateTrendPick()">取消选择 ×</button></div><div class="stepMetrics"><span>输入 <b>${fmt(v.input)}</b></span><span>输出 <b>${fmt(v.output)}</b></span><span>缓存命中 <b>${v.input ? (v.cr / v.input * 100).toFixed(1) : '0'}%</b></span><span>耗时 <b>${durMs(v.dur)}</b></span></div><div class="stepNote">${esc(v.model)} · ${v.status === 'error' ? '请求失败：' + esc(v.error || '未知错误') : v.status === 'running' ? '请求执行中' : v.status === 'cancelled' ? '请求已取消' : '请求已完成'}${v.delta != null ? ' · 输入变化 ' + (v.delta > 0 ? '+' : '') + fmt(v.delta) : v.input > 0 ? '' : ' · 未报告输入，不计算增量'}</div>`);
}
function renderEvents() {
  const events = state.ctx?.events || [];
  document.getElementById('ctxEvSub').textContent = `${events.length} 条`;
  const icons = { compact: '↓', overflow: '!', error: '!', switch: '⇄', spawn: '+', cancel: '⊘' };
  patchHTML('ctxEvents', [...events].reverse().slice(0, 80).map(e => `<button class="evRow" data-event-ts="${e.ts}" data-tip="${esc(e.detail || '')}\n${new Date(e.ts).toLocaleString('zh-CN')}\n点击定位最近请求"><span class="ic">${icons[e.type] || '·'}</span><span class="ty ${e.type}">${esc(e.label)}</span><span class="ds">${esc(e.detail || '')}</span><span class="tm">${agoTs(e.ts)}</span></button>`).join('') || '<div class="empty">该会话暂无上下文事件</div>');
  updateTrendPick();
  document.getElementById('ctxEvents').onclick = e => {
    const row = e.target.closest('[data-event-ts]'); if (!row || !trendValues.length) return;
    const v = [...trendValues].sort((a, b) => Math.abs(a.ts - Number(row.dataset.eventTs)) - Math.abs(b.ts - Number(row.dataset.eventTs)))[0];
    state.trendHover = null; state.trendKey = v.key; updateTrendPick(); const g = [...document.querySelectorAll('[data-step]')].find(g => g.dataset.step === v.key); reveal(g); g?.focus();
  };
}
