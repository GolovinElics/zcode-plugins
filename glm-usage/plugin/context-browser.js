function browserRows() {
  return (state.browser?.cats || []).flatMap(c => c.items.map(it => ({ c, it })))
    .sort((a, b) => a.it.seq - b.it.seq);
}
function renderCurrent() {
  const live = state.ctx?.live;
  document.getElementById('ctxLive').innerHTML = live ? '<i></i>最新请求快照' : '<span>无请求快照</span>';
  document.getElementById('ctxLive').classList.toggle('unavailable', !live);
  if (!live) {
    document.getElementById('ctxCurN').textContent = '—';
    document.getElementById('ctxCurW').textContent = '该会话没有可解析的请求记录';
    document.getElementById('ctxCurPct').textContent = '';
    patchHTML('ctxCurBar', ''); patchHTML('ctxCurLegend', '');
    document.getElementById('estimateNote').textContent = '历史请求的 Token 和耗时仍可在趋势中查看。'; return;
  }
  const win = live.window || 0, used = live.total || 0, max = Math.max(win, used, 1), cats = live.cats || [];
  document.getElementById('ctxCurModel').textContent = live.model || '未知模型';
  document.getElementById('ctxCurN').textContent = (live.estimated ? '≈' : '') + cnum(used);
  document.getElementById('ctxCurW').textContent = win ? `/ ${cnum(win)} tokens` : 'tokens · 窗口未知';
  const pct = win ? used / win * 100 : null, p = document.getElementById('ctxCurPct');
  p.textContent = pct == null ? '' : `${pct.toFixed(1)}% 已使用`; p.style.color = pct > 80 ? 'var(--bad)' : pct > 60 ? 'var(--mid)' : 'var(--fg)';
  patchHTML('ctxCurBar', cats.filter(c => c.tokens > 0).map(c => `<button data-key="${c.key}" data-cat="${c.key}" data-pick-cat="${c.key}" aria-label="查看${esc(c.label)}，约${fmt(c.tokens)} tokens" style="width:${c.tokens / max * 100}%;background:${CAT_HEX[c.key]}" data-tip="${esc(c.label)} · ≈${fmt(c.tokens)} tokens · ${c.pct}%\n点击定位到上下文浏览器"></button>`).join('') + (win > used ? `<span class="reserve" style="width:${(win - used) / max * 100}%" data-tip="可用窗口 ${fmt(win - used)} tokens"></span>` : ''));
  patchHTML('ctxCurLegend', cats.map(c => `<button class="cl" data-key="${c.key}" data-cat="${c.key}" data-pick-cat="${c.key}" aria-pressed="${state.catPick === c.key}"><i style="background:${CAT_HEX[c.key]}"></i><span class="catName">${esc(c.label)}</span><b>≈${cnum(c.tokens)}</b><span>${c.pct}%</span></button>`).join(''));
  document.getElementById('estimateNote').textContent = live.estimated ? '暂无模型上报值 · 按字符与图片权重估算' : '输入总量来自模型上报 · 分类与条目按字符权重估算';
  highlightCategory();
}
function pickCategory(key) {
  state.catPick = state.catPick === key ? null : key;
  if (state.catPick) state.expanded.add(key);
  renderCurrent(); renderBrowser();
  const el = [...document.querySelectorAll('[data-cat-row]')].find(el => el.dataset.catRow === key);
  if (el) reveal(el);
}
function browserItem(row, dna = false) {
  const { c, it } = row;
  return `<button class="${dna ? 'dnaRow' : 'brItem'}" data-key="item-${it.id}" data-cat="${c.key}" data-item="${esc(it.id)}" style="--cat:${CAT_HEX[c.key]}" data-tip="${esc(it.title)}\n≈${fmt(it.tokens)} tokens · ${fmt(it.chars)} 字符\n${esc(it.preview)}" aria-label="查看${esc(it.title)}的内容">${dna ? `<span class="ix">${it.seq + 1}</span><i class="cd" style="background:var(--cat)"></i>` : ''}<span class="nm"><b>${esc(it.title)}</b><span class="itemPreview">${esc(it.preview)}</span></span><span class="tk">≈${cnum(it.tokens)}<span>${esc(it.kind)}</span></span><span class="itemChevron" aria-hidden="true">›</span></button>`;
}
function renderBrowser() {
  const b = state.browser; if (!b) return;
  const rows = browserRows();
  if (state.stripFocus && !rows.some(r => r.it.id === state.stripFocus)) state.stripFocus = null;
  const query = state.browserQuery;
  const filtered = rows.filter(r => (!query || `${r.it.title} ${r.it.preview} ${r.c.label} ${r.it.kind}`.toLowerCase().includes(query)) && (!state.catPick || r.c.key === state.catPick));
  document.getElementById('browserClear').hidden = !query;
  const itemCount = b.cats.reduce((n, c) => n + (c.count ?? c.items.length), 0);
  document.getElementById('browserMeta').textContent = `${rows.length < itemCount ? rows.length + '/' + itemCount + ' 项预览' : rows.length + ' 项'} · ${b.estimated ? '估算' : '输入'} ${cnum(b.total || b.actual_input)} tok`;
  const prevButton = document.querySelector('[data-snapshot="prev"]'); prevButton.disabled = !b.has_previous;
  document.querySelectorAll('[data-snapshot]').forEach(el => { el.classList.toggle('on', el.dataset.snapshot === state.snapshot); el.setAttribute('aria-pressed', String(el.dataset.snapshot === state.snapshot)); });
  document.querySelectorAll('#dnaMode button').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.m === state.dna)));
  const selection = document.getElementById('browserSelection'); selection.hidden = !state.catPick;
  if (state.catPick) {
    const cat = b.cats.find(c => c.key === state.catPick);
    patchHTML('browserSelection', `<span><i style="background:${CAT_HEX[state.catPick]}"></i>${esc(cat?.label || '')} · ${filtered.length} 项</span><button class="textButton" data-pick-cat="${state.catPick}">清除分类 ×</button>`);
  }
  patchHTML('browserStrip', rows.map(r => `<button data-key="strip-${r.it.id}" tabindex="${r.it.id === (state.stripFocus || rows[0]?.it.id) ? 0 : -1}" data-item="${r.it.id}" data-cat="${r.c.key}" style="flex:${Math.max(1, r.it.tokens)};background:${CAT_HEX[r.c.key]}" data-tip="${esc(r.c.label)} · ${esc(r.it.title)}\n≈${fmt(r.it.tokens)} tokens" aria-label="${esc(r.it.title)}，约${fmt(r.it.tokens)} tokens"></button>`).join(''));
  const strip = document.getElementById('browserStrip');
  strip.onfocusin = e => {
    const button = e.target.closest('[data-item]'); if (!button) return;
    state.stripFocus = button.dataset.item;
    strip.querySelectorAll('button').forEach(el => { el.tabIndex = el === button ? 0 : -1; });
  };
  strip.onkeydown = e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); const buttons = [...strip.querySelectorAll('button')], at = buttons.indexOf(document.activeElement);
    const i = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, at + (e.key === 'ArrowRight' ? 1 : -1)));
    buttons[i]?.focus();
  };
  let html = '';
  if (!filtered.length) html = '<div class="empty">没有匹配的上下文条目。可清除搜索或分类筛选。</div>';
  else if (state.dna === 'map') {
    const shownCats = b.cats.filter(c => filtered.some(r => r.c.key === c.key));
    html = '<div class="contextMap" aria-label="按 token 占比排列的上下文矩形图">' + shownCats.map(c => {
      const items = filtered.filter(r => r.c.key === c.key), total = items.reduce((a, r) => a + r.it.tokens, 0);
      return `<section class="mapCategory" data-cat="${c.key}" style="--cat:${CAT_HEX[c.key]};flex-grow:${Math.max(1, total)};flex-basis:${Math.max(20, Math.min(65, total / Math.max(1, b.total) * 100))}%"><button class="mapHeading" data-pick-cat="${c.key}">${esc(c.label)} <span>≈${cnum(total)}</span></button><div class="mapTiles">${items.slice(0, 100).map(r => `<button class="mapTile" data-key="map-${r.it.id}" data-item="${r.it.id}" data-cat="${c.key}" style="flex-grow:${Math.max(1, r.it.tokens)};flex-basis:${Math.max(12, r.it.tokens / Math.max(1, total) * 100)}%" data-tip="${esc(r.it.title)} · ≈${fmt(r.it.tokens)} tokens"><b>${esc(r.it.title)}</b><span>≈${cnum(r.it.tokens)}</span></button>`).join('')}</div>${items.length > 100 ? '<span class="muted">该分类展示前 100 项</span>' : ''}</section>`;
    }).join('') + '</div><div class="estimateNote">面积按估算 Token 分配，小条目保留可点击的最小面积。</div>';
  } else if (state.dna === 'dna') {
    const limit = state.dnaLimit || 160;
    html = `<div class="dnaList">${filtered.slice(0, limit).map(r => browserItem(r, true)).join('')}${filtered.length > limit ? `<button class="loadMore" data-more="dna">再显示 ${Math.min(100, filtered.length - limit)} 项 · 共 ${filtered.length} 项</button>` : ''}</div><div class="estimateNote">按请求中的真实顺序排列 · 点击条目查看内容</div>`;
  } else {
    html = '<div class="brCats">' + b.cats.filter(c => !state.catPick || c.key === state.catPick).map(c => {
      const items = filtered.filter(r => r.c.key === c.key);
      if (query && !items.length) return '';
      const open = state.expanded.has(c.key) || !!query;
      const limit = state.rowLimits?.[c.key] || 80;
      return `<section class="brCat ${open ? 'open' : ''}" data-cat-row="${c.key}" data-cat="${c.key}" style="--cat:${CAT_HEX[c.key]}"><button class="brCatHead" data-toggle-cat="${c.key}" aria-expanded="${open}" aria-controls="items-${c.key}"><span class="cv">›</span><i class="cd" style="background:var(--cat)"></i><span class="nm">${esc(c.label)} <span>${query ? items.length : c.count ?? c.items.length} 项${c.truncated ? ' · 预览 ' + c.items.length : ''}</span></span><span class="tk">≈${cnum(c.tokens)}</span><span class="pc">${c.pct}%</span></button><div class="brFold" ${open ? '' : 'inert'}><div><div class="brItems" id="items-${c.key}">${items.slice(0, limit).map(r => browserItem(r)).join('') || '<div class="empty">暂无此类内容</div>'}${open && items.length > limit ? `<button class="loadMore" data-more="${c.key}">再显示 ${Math.min(100, items.length - limit)} 项 · 共 ${items.length} 项</button>` : ''}${open && c.truncated ? '<div class="estimateNote">此分类最多返回 400 项预览，分类总量包含全部条目。</div>' : ''}</div></div></div></section>`;
    }).join('') + '</div>';
  }
  patchHTML('ctxBrowser', html);
  document.getElementById('ctxBrowser').onclick = e => {
    const cat = e.target.closest('[data-toggle-cat]');
    if (cat) { const key = cat.dataset.toggleCat; if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key); renderBrowser(); }
    const more = e.target.closest('[data-more]');
    if (more) { if (more.dataset.more === 'dna') state.dnaLimit = (state.dnaLimit || 160) + 100; else { state.rowLimits ||= {}; state.rowLimits[more.dataset.more] = (state.rowLimits[more.dataset.more] || 80) + 100; } renderBrowser(); }
  };
  highlightCategory();
}

function agentCard(a, role) {
  const color = role === 'lead' ? '#14b8a6' : ['#6366f1', '#f59e0b', '#3b82f6'][Math.abs(hash(a.id)) % 3];
  const pct = a.window ? a.context / a.window * 100 : 0;
  const state = `<span class="runState${a.running ? ' on' : ''}">${a.running ? '运行中' : '空闲'}</span>`;
  return `<button class="agentCard ${role === 'lead' ? 'lead' : ''}" data-agent="${esc(a.id)}" style="--agent:${color}"><div class="ah"><span class="ad" style="background:${color}"></span><span class="an">${esc(a.title || a.id)}</span><span class="sPill">${role === 'lead' ? '主会话' : '子代理'}</span></div><div class="am">${esc(a.model || '未知模型')} · ${a.steps} 步</div><div class="agentValue">${cnum(a.context)}<span> / ${cnum(a.window)} tokens</span></div><div class="abar"><i style="width:${Math.min(pct, 100)}%;background:${color}"></i></div><div class="af"><span>累计 ${cnum(a.tokens)} tok</span><span>${pct.toFixed(1)}% 已用</span></div><div class="agentOpen">${state} · 悬浮预览 · 点击固定 <span>⌖</span></div></button>`;
}
function renderFleet() {
  const f = state.fleet; if (!f) return;
  const sm = f.summary || {}, members = f.members || [];
  const leadId = f.lead?.id || null;
  patchHTML('fleetStats', [[sm.agents || 1, '会话'], [sm.running || 0, '近期活跃'], [sm.work_items || 0, '待办事项'], [sm.messages || 0, '模型请求']].map(([v, l]) => `<div class="st"><div class="v">${v}</div><div class="l">${l}</div></div>`).join(''));
  /* 家族树渲染：横向思维导——根在左侧，子级按层级一列一列向右展开，贝塞尔曲线连接 */
  const byParent = new Map();
  for (const m of members) { const key = m.parent_id || leadId; if (!byParent.has(key)) byParent.set(key, []); byParent.get(key).push(m); }
  const branch = (m) => `<div class="treeBranch">${agentCard(m, 'member')}${(byParent.get(m.id) || []).length ? `<div class="treeKids">${byParent.get(m.id).map(branch).join('')}</div>` : ''}</div>`;
  const roots = byParent.get(leadId) || [];
  patchHTML('fleetNodes', f.lead ? `<div class="treeBranch treeRoot">${agentCard(f.lead, 'lead')}${roots.length ? `<div class="treeKids">${roots.map(branch).join('')}</div>` : ''}</div>` : '<div class="empty">该主会话尚未派出子代理</div>');
  const derived = members.length - roots.length;
  document.getElementById('fleetNetSub').textContent = `${members.length} 个子代理${derived > 0 ? `（含 ${derived} 个下级派生）` : ''} · 悬浮预览 · 点击固定 · Esc 取消`;
  document.getElementById('fleetSub').textContent = `${members.length} 个 · 近期活跃按 3 分钟内更新估算`;
  const depthOf = new Map();
  for (const m of members) { let d = 0, p = m.parent_id; while (p && p !== leadId && d < 8) { d++; p = members.find(x => x.id === p)?.parent_id || null; } depthOf.set(m.id, d); }
  patchHTML('fleetMembers', members.map(m => `<button class="fleetRow" data-agent="${esc(m.id)}"${depthOf.get(m.id) ? ` style="margin-left:${depthOf.get(m.id) * 16}px"` : ''}><span class="avatar">${esc((m.title || '?')[0])}</span><span class="fleetInfo"><span class="fn">${esc(m.title)}</span><span class="fm">${esc(m.model || '未知模型')} · ${m.steps} 步 · ${durMs(m.model_ms)}</span></span><span class="fleetCtx"><span class="fx"><span>Context ${cnum(m.context)}</span><span>${(m.context / Math.max(1, m.window) * 100).toFixed(1)}%</span></span><span class="bar"><i style="width:${Math.min(100, m.context / Math.max(1, m.window) * 100)}%"></i></span></span><span>↗</span></button>`).join('') || '<div class="empty">子代理会话将显示在这里。</div>');
  /* 跨 Agent 协作：委派 / 消息记录，悬浮或点击可定位对应代理 */
  const nameOf = new Map([[leadId, f.lead?.title || '主会话'], ...members.map(m => [m.id, m.title || m.id])]);
  const comms = f.comms || [];
  const kinds = [['all', '全部'], ['delegate', '委派'], ['message', '消息']];
  const commsKind = state.commsKind || 'all';
  patchHTML('commsChips', kinds.map(([k, label]) => `<button class="${commsKind === k ? 'on' : ''}" data-comms-kind="${k}" aria-pressed="${commsKind === k}">${label} <b>${k === 'all' ? comms.length : comms.filter(c => c.kind === k).length}</b></button>`).join(''));
  const memberOf = id => members.find(m => m.id === id);
  patchHTML('fleetComms', comms.filter(c => commsKind === 'all' || c.kind === commsKind).map(c => {
    const owner = c.to && nameOf.get(c.to) ? c.to : c.from;
    const target = c.to && nameOf.get(c.to) ? `${nameOf.get(c.from) || '?'} → ${nameOf.get(c.to)}` : nameOf.get(c.from) || '?';
    const live = !!(c.to && memberOf(c.to)?.running);
    return `<button class="commsRow" data-agent="${esc(owner)}"><span class="cKind ${c.kind}">${c.kind === 'delegate' ? '委派' : '消息'}</span><span class="cBody"><span class="cDesc" data-tip="${esc(c.description)}">${esc(c.description)}</span><span class="cMeta">${esc(target)} · ${agoTs(c.at)}${c.kind === 'delegate' ? ` · ${live ? '运行中' : '已委派'}` : ''}</span></span><span class="cdot${live ? ' live' : ''}"></span></button>`;
  }).join('') || '<div class="empty">这个编队还没有跨 Agent 事件。</div>');
  document.getElementById('fleetCommsSub').textContent = `${comms.length} 条记录`;
  /* 协作任务：全家族待办三态分相 */
  const works = f.works || [];
  const phases = [['all', '全部'], ['in_progress', '运行中'], ['pending', '待处理'], ['completed', '已完成']];
  const workPhase = state.workPhase || 'all';
  const phaseText = s => s === 'completed' ? '已完成' : s === 'in_progress' ? '运行中' : '待处理';
  patchHTML('workChips', phases.map(([p, label]) => `<button class="${workPhase === p ? 'on' : ''}" data-work-phase="${p}" aria-pressed="${workPhase === p}">${label} <b>${p === 'all' ? works.length : works.filter(w => w.status === p).length}</b></button>`).join(''));
  patchHTML('fleetWork', works.filter(w => workPhase === 'all' || w.status === workPhase).map(w => {
    const dot = w.status === 'completed' ? 'done' : w.status === 'in_progress' ? 'ongoing' : 'idle';
    return `<button class="commsRow" data-agent="${esc(w.sid)}"><span class="wdot ${dot}"></span><span class="cBody"><span class="cDesc" data-tip="${esc(w.content)}">${esc(w.content)}</span><span class="cMeta">${esc(nameOf.get(w.sid) || '?')} · ${agoTs(w.at)}</span></span><span class="cState">${phaseText(w.status)}</span></button>`;
  }).join('') || '<div class="empty">当前阶段没有协作任务。</div>');
  document.getElementById('fleetWorkSub').textContent = `${works.length} 项`;
  const page = document.getElementById('tab-agent');
  const hover = target => {
    state.agentHover = target?.closest?.('[data-agent]')?.dataset.agent || null;
    highlightAgent(); renderAgentInspector();
  };
  page.onpointerover = e => hover(e.target);
  page.onpointerout = e => { if (!e.relatedTarget || !page.contains(e.relatedTarget)) hover(null); };
  page.onfocusin = e => hover(e.target);
  page.onfocusout = e => hover(e.relatedTarget);
  const commsChips = document.getElementById('commsChips');
  if (commsChips) commsChips.onclick = e => { const b = e.target.closest('[data-comms-kind]'); if (b) { state.commsKind = b.dataset.commsKind; renderFleet(); } };
  const workChips = document.getElementById('workChips');
  if (workChips) workChips.onclick = e => { const b = e.target.closest('[data-work-phase]'); if (b) { state.workPhase = b.dataset.workPhase; renderFleet(); } };
  const ids = [f.lead, ...members].filter(Boolean).map(a => a.id);
  if (!ids.includes(state.agentPick)) state.agentPick = null;
  if (!ids.includes(state.agentHover)) state.agentHover = null;
  highlightAgent(); renderAgentInspector();
  requestAnimationFrame(drawFleetEdges);
  if (!renderFleet.observer) { renderFleet.observer = new ResizeObserver(drawFleetEdges); renderFleet.observer.observe(document.getElementById('fleetGrid')); }
}

function drawFleetEdges() {
  const grid = document.getElementById('fleetGrid'), svg = document.getElementById('agentEdges'), lead = grid.querySelector('.treeRoot > .agentCard');
  if (!svg || !lead || grid.offsetWidth === 0) return;
  const wrap = grid.querySelector('.agentTreeWrap');
  const box = (wrap || grid).getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const leadId = state.fleet?.lead?.id;
  const byId = new Map([...grid.querySelectorAll('.agentCard[data-agent]')].map(el => [el.dataset.agent, el]));
  const parentElOf = el => {
    const m = (state.fleet?.members || []).find(x => x.id === el.dataset.agent);
    if (!m || !m.parent_id || m.parent_id === leadId) return lead;
    return byId.get(m.parent_id) || lead; /* 父代理卡片不在图内时回退连线到主会话 */
  };
  /* 横向思维导连线：父卡右缘中点 → 子卡左缘外侧 7px（端点与圆点露在卡外，明确归属） */
  patchHTML('agentEdges', [...grid.querySelectorAll('.agentCard[data-agent]')].filter(el => el !== lead).map(el => {
    const parentNode = parentElOf(el);
    const parent = parentNode.getBoundingClientRect(), child = el.getBoundingClientRect();
    const x1 = parent.right - box.left, y1 = parent.top + parent.height / 2 - box.top;
    const x2 = child.left - 7 - box.left, y2 = child.top + child.height / 2 - box.top;
    return `<g data-edge="${esc(el.dataset.agent)}"><path class="agentLink" d="M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}" fill="none" stroke="var(--bd2)" stroke-width="1.5"/><circle cx="${x2}" cy="${y2}" r="3" fill="var(--acc)"/></g>`;
  }).join(''));
  highlightAgent();
}

function highlightAgent() {
  const active = state.agentHover || state.agentPick;
  const lead = state.fleet?.lead?.id;
  /* 家族传播：悬浮/固定某个成员时，其全部下级派生代理与连线一并保持高亮 */
  const kin = new Set();
  if (active && active !== lead) {
    const mem = state.fleet?.members || [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of mem) {
        if (kin.has(m.id)) continue;
        if (m.parent_id === active || kin.has(m.parent_id)) { kin.add(m.id); grew = true; }
      }
    }
  }
  document.querySelectorAll('#tab-agent [data-agent]').forEach(el => {
    el.classList.toggle('agentHot', el.dataset.agent === active);
    el.classList.toggle('agentDim', !!active && el.dataset.agent !== active && el.dataset.agent !== lead && !kin.has(el.dataset.agent));
    el.classList.toggle('agentPinned', el.dataset.agent === state.agentPick);
    el.setAttribute('aria-pressed', String(el.dataset.agent === state.agentPick));
  });
  document.querySelectorAll('[data-edge]').forEach(el => {
    el.classList.toggle('edgeHot', !!active && (active === lead || el.dataset.edge === active || kin.has(el.dataset.edge)));
    el.classList.toggle('edgeDim', !!active && active !== lead && el.dataset.edge !== active && !kin.has(el.dataset.edge));
  });
}
function renderAgentInspector() {
  const fleet = state.fleet;
  const a = [fleet?.lead, ...(fleet?.members || [])].find(a => a && a.id === (state.agentHover || state.agentPick)) || fleet?.lead;
  if (!a) return;
  const pinned = state.agentPick === a.id;
  const pct = a.window ? (a.context / a.window * 100).toFixed(1) + '%' : '窗口未知';
  patchHTML('agentInspector', `<div class="agentInspectorHead"><div><span class="muted">${pinned ? '已固定' : '会话预览'}</span><b>${esc(a.title || a.id)}</b></div><button data-sid="${esc(a.id)}" class="textButton">打开上下文 ↗</button>${state.agentPick ? '<button class="textButton" data-agent-clear>取消固定 ×</button>' : ''}</div><div class="stepMetrics"><span>当前上下文<b>${cnum(a.context)} · ${pct}</b></span><span>累计 Token<b>${cnum(a.tokens)}</b></span><span>模型请求<b>${a.steps} 步</b></span><span>模型耗时<b>${durMs(a.model_ms || 0)}</b></span></div><div class="stepNote">${esc(a.model || '未知模型')} · ${a.id === fleet.lead?.id ? '主会话' : '子代理'} · 活跃状态按最近更新时间估算</div>`);
  const clear = document.getElementById('agentInspector').querySelector('[data-agent-clear]');
  if (clear) clear.onclick = () => { state.agentPick = null; state.agentHover = null; highlightAgent(); renderAgentInspector(); };
}
