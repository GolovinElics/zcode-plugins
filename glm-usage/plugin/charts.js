/* Geometry and coordinated chart interactions, adapted from dsh-context v0.84.1. */
function donut(segs, centerTop, centerSub, size = 118) {
  const total = segs.reduce((a, s) => a + Math.max(0, Number(s.v) || 0), 0);
  let acc = 0;
  const arcs = segs.map((s, i) => {
    if (!(s.v > 0)) return '';
    const pct = s.v / total * 100, cut = segs.filter(s => s.v > 0).length > 1 ? Math.min(.25, pct / 4) : 0;
    const offset = 125 - acc - cut; acc += pct;
    return `<circle class="segArc" data-slice="${i}" style="--i:${i}" fill="none" stroke-width="4" cx="21" cy="21" r="15.9155" stroke="${s.c}" stroke-dasharray="${(pct - cut * 2).toFixed(3)} ${(100 - pct + cut * 2).toFixed(3)}" stroke-dashoffset="${offset.toFixed(3)}"/>`;
  }).join('');
  return `<div class="lc-donut" style="width:${size}px;height:${size}px"><svg viewBox="0 0 42 42" width="${size}" height="${size}" aria-hidden="true">${arcs || '<circle class="lc-donut-track" fill="none" stroke-width="4" cx="21" cy="21" r="15.9155"/>'}</svg><div class="lc-donut-center" data-value="${esc(centerTop)}" data-label="${esc(centerSub || '')}"><b style="font-size:${Math.max(11, Math.round(size * .13))}px">${esc(centerTop)}</b>${centerSub != null ? `<span style="font-size:${Math.max(9, Math.round(size * .095))}px">${esc(centerSub)}</span>` : ''}</div></div>`;
}
function donutLegendBlock(segs, centerTop, centerSub, size, timing = false) {
  const total = segs.reduce((a, s) => a + s.v, 0) || 1;
  return `<div class="donutWrap">${donut(segs, centerTop, centerSub, size)}<div class="legendGrid">${segs.map((s, i) => {
    const value = timing ? durMs(s.v) : cnum(s.v), pct = Math.round(s.v / total * 1000) / 10;
    return `<button class="lgRow" data-slice="${i}" data-value="${esc(value)}" data-label="${esc(s.n)}" data-tip="${esc(s.n)} · ${timing ? durMs(s.v) : fmt(s.v) + ' tokens'} · ${pct}%\n点击固定高亮，再次点击或按 Esc 取消" aria-pressed="false"><i style="background:${s.c}"></i><span class="n">${esc(s.n)}</span><span class="p">${pct}%</span><span class="v">${value}</span></button>`;
  }).join('')}</div></div>`;
}
function dateKey(value) {
  const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function renderDaily(d) {
  if (!d) return;
  const count = state.range === 'today' ? 1 : state.range === '30d' ? 30 : 7;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const source = new Map((d.daily || []).map(x => [x.day, x]));
  const rows = Array.from({ length: count }, (_, i) => { const date = new Date(today); date.setDate(date.getDate() - count + i + 1); const day = dateKey(date); return source.get(day) || { day, tokens: 0, steps: 0, sessions: 0 }; });
  const max = Math.max(1, ...rows.map(x => x.tokens));
  document.getElementById('insDailyTitle').textContent = count === 1 ? '今日用量' : `近 ${count} 天用量`;
  document.getElementById('insDailySub').textContent = `${cnum(rows.reduce((a, x) => a + x.tokens, 0))} tokens`;
  patchHTML('insDailyChart', `<div class="dailyAxis"><span>${cnum(max)}</span><span>${cnum(max / 2)}</span><span>0</span></div><div class="dailyPlot">${rows.map((x, i) => {
    const cr = x.cache_read || 0, input = Math.max((x.input_t || 0) - cr, 0), output = x.output_t || 0;
    const h = n => (n / max * 100).toFixed(3);
    return `<button class="col ${state.day === x.day ? 'selected' : ''}" data-day="${x.day}" aria-pressed="${state.day === x.day}" aria-label="${x.day}，${fmt(x.tokens)} tokens，筛选会话" data-tip="${x.day}\n${fmt(x.tokens)} tokens · ${x.steps} 步 · ${x.sessions || 0} 个会话\n缓存 ${cnum(cr)} · 新输入 ${cnum(input)} · 输出 ${cnum(output)}\n点击筛选当日会话"><i style="height:${h(output)}%;background:#f59e0b"></i><i style="height:${h(input)}%;background:#3b82f6"></i><i style="height:${h(cr)}%;background:#22c55e"></i><span class="lb">${count <= 7 || i % 5 === 0 || i === count - 1 ? x.day.slice(5) : ''}</span></button>`;
  }).join('')}</div>`);
}
function renderHeatmap(d) {
  if (!d) return;
  const values = new Map((d.heatmap || []).map(x => [x.day, x]));
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = new Date(end); start.setDate(start.getDate() - 83);
  const pad = (start.getDay() + 6) % 7;
  const max = Math.max(1, ...(d.heatmap || []).map(x => x.tokens));
  const cells = Array.from({ length: pad }, () => '<span></span>');
  for (let i = 0; i < 84; i++) {
    const date = new Date(start); date.setDate(date.getDate() + i); const day = dateKey(date);
    const value = values.get(day) || { tokens: 0, steps: 0 };
    const color = value.tokens ? `color-mix(in srgb,#3b82f6 ${Math.round(25 + Math.sqrt(value.tokens / max) * 75)}%,var(--card2))` : 'var(--card2)';
    cells.push(`<button data-day="${day}" aria-pressed="${state.day === day}" class="${state.day === day ? 'selected' : ''}" style="background:${color}" data-tip="${day}\n${fmt(value.tokens)} tokens · ${value.steps} 步" aria-label="${day}，${fmt(value.tokens)} tokens"></button>`);
  }
  patchHTML('insHeatGrid', cells.join(''));
  patchHTML('insHeatScale', '<span>少</span>' + [0, 25, 50, 75, 100].map(x => `<i style="background:color-mix(in srgb,#3b82f6 ${x}%,var(--card2))"></i>`).join('') + '<span>多</span>');
}
function renderSessions() {
  const all = state.insights?.sessions || [], groups = new Map();
  all.forEach(s => { const path = s.directory || ''; groups.set(path, (groups.get(path) || 0) + 1); });
  patchHTML('sessGroups', `<button class="gchip ${!state.group ? 'on' : ''}" data-group="" aria-pressed="${!state.group}">全部 <b>${all.length}</b></button>` + [...groups].map(([path, n]) => `<button class="gchip ${state.group === path ? 'on' : ''}" data-group="${esc(path)}" data-tip="${esc(path)}" aria-pressed="${state.group === path}">${esc(dirName({ directory: path }))} <b>${n}</b></button>`).join(''));
  const dayRecord = [...(state.insights?.daily || []), ...(state.insights?.heatmap || [])].find(x => x.day === state.day);
  const daySessions = dayRecord?.session_ids ? new Set(Array.isArray(dayRecord.session_ids) ? dayRecord.session_ids : dayRecord.session_ids.split(',')) : null;
  let list = all.filter(s => (!state.group || s.directory === state.group) && (!state.archive || !s.archived)
    && (!state.search || `${s.title} ${s.directory} ${s.last_msg || ''} ${s.model || ''}`.toLowerCase().includes(state.search))
    && (!state.day || (daySessions ? daySessions.has(s.id) : dateKey(s.updated) === state.day)));
  list = list.slice().sort((a, b) => (b[state.sortKey] || 0) - (a[state.sortKey] || 0));
  document.getElementById('insSessCount').textContent = `${list.length} / ${all.length} 个${state.day ? ' · ' + state.day : ''}`;
  document.getElementById('clearSessionFilters').hidden = !(state.day || state.group || state.search || state.archive);
  patchHTML('insSessions', list.map(s => {
    const pct = s.window ? Math.round(s.context / s.window * 1000) / 10 : null;
    return `<button class="sCard ${s.id === state.sessionId ? 'on' : ''}" data-sid="${esc(s.id)}" aria-label="查看会话：${esc(s.title)}"><div class="sHead"><span class="sTitle">${esc(s.title || '无标题会话')}</span><span class="sTimes"><span class="sTime">${agoTs(s.updated)}</span><span class="sCreated">${dateKey(s.created)}</span></span></div><div class="sCrumb"><span class="sPill" data-tip="${esc(s.directory)}">${esc(dirName(s))}</span>${s.parent_id ? '<span class="sPill">子代理</span>' : ''}${s.archived ? '<span class="sPill">已归档</span>' : ''}<span class="sPill">${esc(s.model || '未知模型')}</span></div><div class="sBody">${donut([{ v: s.context, c: '#3b82f6' }, { v: Math.max((s.window || s.context) - s.context, 0), c: 'var(--bd)' }], cnum(s.context), pct == null ? '上下文' : pct + '%', 76)}<div class="sStats"><div class="sStat"><span class="k">轮次</span><span class="v">${s.turns} 轮 ${s.steps} 步</span></div><div class="sStat"><span class="k">Token 总用量</span><span class="v">${cnum(s.tokens)}</span></div><div class="sStat"><span class="k">上下文窗口</span><span class="v">${cnum(s.window)}</span></div></div></div><div class="sPreview"><span class="k">最新消息</span><span class="v" data-tip="${esc(s.last_msg || '')}">${esc(s.last_msg || '暂无文本消息')}</span><span class="cardArrow" aria-hidden="true">↗</span></div></button>`;
  }).join('') || '<div class="empty">当前筛选没有匹配会话。可清除筛选或扩大时间范围。</div>');
}

let trendValues = [];
function renderTrend() {
  const data = state.ctx, steps = data?.steps || [], box = document.getElementById('ctxTrend');
  if (!steps.length) { renderTrend.signature = null; patchHTML('ctxTrend', '<div class="empty">该会话暂无模型请求记录</div>'); document.getElementById('ctxTrendDetail').hidden = true; return; }
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
  box.onpointerout = e => { if (!e.relatedTarget?.closest?.('[data-step]')) { box.querySelectorAll('.hovered').forEach(n => n.classList.remove('hovered')); hideTip(); } };
  box.onfocusin = e => { const g = e.target.closest('[data-step]'); if (g) hoverTrend(g); };
  box.onclick = e => { const g = e.target.closest('[data-step]'); if (g) pickTrend(g.dataset.step); };
  box.onkeydown = e => {
    const g = e.target.closest('[data-step]');
    if (e.key === 'Escape') { state.trendKey = null; updateTrendPick(); hideTip(); return; }
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
  document.querySelectorAll('#ctxTrend .hovered').forEach(el => el.classList.remove('hovered')); group.classList.add('hovered');
  const v = trendValues[Number(group.dataset.index)];
  showTip(group, `第 ${v.number} 步 · ${v.model}\n${new Date(v.ts).toLocaleString('zh-CN')}\n输入 ${fmt(v.input)} · 输出 ${fmt(v.output)}\n缓存读 ${fmt(v.cr)} · 缓存写 ${fmt(v.cw)}\n耗时 ${durMs(v.dur)}${state.trendMode === 'delta' ? '\n输入变化 ' + (v.delta == null ? (v.input > 0 ? '无上一有效请求' : '未报告输入') : (v.delta > 0 ? '+' : '') + fmt(v.delta)) : ''}${v.status === 'error' ? '\n请求失败：' + (v.error || '未知错误') : ''}`);
}
function pickTrend(key) { state.trendKey = state.trendKey === key ? null : key; updateTrendPick(); }
function updateTrendPick() {
  document.querySelectorAll('#ctxTrend [data-step]').forEach(g => { g.classList.toggle('selected', g.dataset.step === state.trendKey); g.setAttribute('aria-pressed', String(g.dataset.step === state.trendKey)); });
  const v = trendValues.find(v => v.key === state.trendKey), el = document.getElementById('ctxTrendDetail'); el.hidden = !v;
  if (!v) return;
  patchHTML('ctxTrendDetail', `<div class="hd"><b>第 ${v.number} 步</b><span class="tm">${new Date(v.ts).toLocaleString('zh-CN')}</span><button class="textButton" onclick="state.trendKey=null;updateTrendPick()">取消选择 ×</button></div><div class="stepMetrics"><span>输入 <b>${fmt(v.input)}</b></span><span>输出 <b>${fmt(v.output)}</b></span><span>缓存命中 <b>${v.input ? (v.cr / v.input * 100).toFixed(1) : '0'}%</b></span><span>耗时 <b>${durMs(v.dur)}</b></span></div><div class="stepNote">${esc(v.model)} · ${v.status === 'error' ? '请求失败：' + esc(v.error || '未知错误') : v.status === 'running' ? '请求执行中' : v.status === 'cancelled' ? '请求已取消' : '请求已完成'}${v.delta != null ? ' · 输入变化 ' + (v.delta > 0 ? '+' : '') + fmt(v.delta) : v.input > 0 ? '' : ' · 未报告输入，不计算增量'}</div>`);
}
function renderEvents() {
  const events = state.ctx?.events || [];
  document.getElementById('ctxEvSub').textContent = `${events.length} 条`;
  const icons = { compact: '↓', overflow: '!', error: '!', switch: '⇄', spawn: '+', cancel: '⊘' };
  patchHTML('ctxEvents', [...events].reverse().slice(0, 80).map(e => `<button class="evRow" data-event-ts="${e.ts}" data-tip="${esc(e.detail || '')}\n${new Date(e.ts).toLocaleString('zh-CN')}\n点击定位最近请求"><span class="ic">${icons[e.type] || '·'}</span><span class="ty ${e.type}">${esc(e.label)}</span><span class="ds">${esc(e.detail || '')}</span><span class="tm">${agoTs(e.ts)}</span></button>`).join('') || '<div class="empty">该会话暂无上下文事件</div>');
  document.getElementById('ctxEvents').onclick = e => {
    const row = e.target.closest('[data-event-ts]'); if (!row || !trendValues.length) return;
    const v = [...trendValues].sort((a, b) => Math.abs(a.ts - Number(row.dataset.eventTs)) - Math.abs(b.ts - Number(row.dataset.eventTs)))[0];
    state.trendKey = v.key; updateTrendPick(); const g = [...document.querySelectorAll('[data-step]')].find(g => g.dataset.step === v.key); reveal(g); g?.focus();
  };
}
