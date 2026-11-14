/* Shared interaction state. Inspired by dsh-context v0.84.1; ZCode implementation. */
function nodeKey(node) {
  if (node.nodeType !== 1) return null;
  for (const name of ['id', 'data-key', 'data-sid', 'data-item', 'data-step', 'data-cat-row']) {
    if (node.hasAttribute(name)) return name + ':' + node.getAttribute(name);
  }
  return null;
}
function morphChildren(parent, source) {
  const old = [...parent.childNodes];
  const keyed = new Map(old.map(n => [nodeKey(n), n]).filter(([k]) => k));
  let cursor = parent.firstChild;
  for (const next of [...source.childNodes]) {
    const key = nodeKey(next);
    let current = key ? keyed.get(key) : cursor && !nodeKey(cursor) ? cursor : null;
    if (!current || current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
      current = next.cloneNode(true); parent.insertBefore(current, cursor);
    } else {
      if (current !== cursor) parent.insertBefore(current, cursor);
      if (current.nodeType === 3) { if (current.data !== next.data) current.data = next.data; }
      else if (current.nodeType === 1) {
        for (const attr of [...current.attributes]) {
          if (!next.hasAttribute(attr.name) && !['aria-describedby', 'data-hovered'].includes(attr.name)) current.removeAttribute(attr.name);
        }
        for (const attr of [...next.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
        morphChildren(current, next);
      }
    }
    cursor = current.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}
function setBusy(id, busy) {
  document.getElementById(id)?.setAttribute('aria-busy', String(busy));
}
function reducedMotion() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
function reveal(el) { el?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'instant' : 'smooth' }); }
function toast(message) {
  const el = document.getElementById('toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 2600);
}
let tipAnchor = null, hoverElement = null, lastInput = 'pointer';
function restoreHover(root) {
  if (hoverElement?.isConnected && root.contains(hoverElement)) { highlightDonut(hoverElement); highlightCategory(); }
}
function showTip(anchor, label) {
  if (!anchor || !(label || anchor.dataset.tip)) return hideTip();
  const tip = document.getElementById('hoverTip');
  if (tipAnchor !== anchor) tipAnchor?.removeAttribute('aria-describedby');
  tipAnchor = anchor; anchor.setAttribute('aria-describedby', 'hoverTip');
  tip.textContent = label || anchor.dataset.tip;
  tip.hidden = false;
  const rect = anchor.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
  tip.style.top = Math.max(8, Math.min(rect.top > h + 14 ? rect.top - h - 7 : rect.bottom + 7, innerHeight - h - 8)) + 'px';
}
function hideTip() {
  document.getElementById('hoverTip').hidden = true;
  tipAnchor?.removeAttribute('aria-describedby'); tipAnchor = null;
}
function highlightDonut(target) {
  const wrap = target?.closest('.donutWrap');
  if (!wrap) return;
  const picked = target.closest('[data-slice]');
  const key = picked?.dataset.slice ?? wrap.dataset.pinned ?? null;
  wrap.querySelectorAll('[data-slice]').forEach(el => {
    el.classList.toggle('dimmed', key !== null && el.dataset.slice !== key);
    el.classList.toggle('highlighted', el.dataset.slice === key);
    if (el.tagName === 'BUTTON') el.setAttribute('aria-pressed', String(el.dataset.slice === (wrap.dataset.pinned ?? null)));
  });
  const row = key !== null ? wrap.querySelector(`button[data-slice="${key}"]`) : null;
  const center = wrap.querySelector('.lc-donut-center');
  if (center) {
    center.querySelector('b').textContent = row?.dataset.value || center.dataset.value;
    center.querySelector('span').textContent = row?.dataset.label || center.dataset.label;
  }
}
function highlightCategory(key = state.hoverCat || state.catPick, itemId = null) {
  document.querySelectorAll('#tab-context [data-cat]').forEach(el => {
    el.classList.toggle('catDim', !!key && el.dataset.cat !== key);
    el.classList.toggle('catHot', !!key && el.dataset.cat === key);
  });
  document.querySelectorAll('[data-item]').forEach(el => el.classList.toggle('itemHot', !!itemId && el.dataset.item === itemId));
}
function selectSession(sid) {
  if (!sid) return;
  if (sid !== state.sessionId) {
    state.sessionId = sid; state.ctx = null; state.browser = null; state.fleet = null;
    state.trendKey = null; state.trendSel = -1; state.catPick = null; state.hoverCat = null; state.snapshot = 'live';
    state.expanded.clear(); state.browserQuery = ''; state.inspectorId = null;
    requestTickets.context++; requestTickets.browser++; requestTickets.fleet++;
    inFlight.context = false; inFlight.browser = false; inFlight.fleet = false;
    document.getElementById('browserSearch').value = '';
    for (const id of ['ctxTokensBody', 'ctxTimingBody', 'ctxBrowser', 'ctxTrend', 'ctxEvents', 'ctxInfo', 'ctxStats']) {
      patchHTML(id, '<div class="loadingRows" role="status" aria-label="正在读取会话"><i></i><i></i><i></i></div>');
    }
    for (const id of ['ctxCurBar', 'ctxCurLegend', 'browserStrip', 'ctxIoChips', 'ctxToolChips', 'ctxCmdChips', 'ctxFleetRows']) patchHTML(id, '');
    document.getElementById('ctxCurN').textContent = '—';
    document.getElementById('ctxCurW').textContent = '正在读取上下文…';
    document.getElementById('ctxCurPct').textContent = '';
    document.getElementById('ctxTrendDetail').hidden = true;
    document.getElementById('browserSelection').hidden = true;
  }
  fillSessionSelect(); switchTab('context');
}

// Searchable, keyboard-operable select, backed by the original native form value.
const selects = new WeakMap();
function syncSelect(select) {
  const ui = selects.get(select); if (!ui) return;
  ui.button.textContent = select.selectedOptions[0]?.textContent || '选择会话';
  ui.button.dataset.tip = ui.button.textContent;
  const query = ui.input.value.toLowerCase();
  const visible = [...select.options].filter(o => o.textContent.toLowerCase().includes(query));
  const signature = JSON.stringify(visible.map(o => [o.value, o.textContent, o.selected]));
  if (ui.signature === signature) return;
  ui.signature = signature;
  ui.list.replaceChildren(...visible.map(o => {
    const button = document.createElement('button'); button.type = 'button'; button.role = 'option';
    button.textContent = o.textContent; button.dataset.value = o.value;
    button.setAttribute('aria-selected', String(o.selected));
    button.className = o.selected ? 'picked' : ''; return button;
  }));
  if (!visible.length) { const empty = document.createElement('div'); empty.className = 'selectEmpty'; empty.textContent = '无匹配项'; ui.list.append(empty); }
}
function enhanceSelect(select) {
  const box = document.createElement('div'); box.className = 'selectbox';
  const button = document.createElement('button'); button.type = 'button'; button.className = 'selectTrigger';
  button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', select.getAttribute('aria-label') || select.title || '选择');
  const pop = document.createElement('div'); pop.className = 'selectPopup'; pop.hidden = true;
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = '搜索会话…'; input.setAttribute('aria-label', '搜索选项');
  const list = document.createElement('div'); list.className = 'selectOptions'; list.role = 'listbox'; list.id = select.id + '-options';
  button.setAttribute('aria-controls', list.id);
  pop.append(input, list); select.before(box); box.append(button, pop, select);
  select.hidden = true; const ui = { box, button, pop, input, list }; selects.set(select, ui);
  const close = focus => { pop.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); };
  button.addEventListener('click', () => {
    const opening = pop.hidden; document.querySelectorAll('.selectPopup').forEach(el => { el.hidden = true; el.previousElementSibling?.setAttribute('aria-expanded', 'false'); });
    pop.hidden = !opening; button.setAttribute('aria-expanded', String(opening));
    input.hidden = select.options.length < 8; input.value = ''; syncSelect(select);
    if (opening) (input.hidden ? list.querySelector('[aria-selected="true"]') || list.firstElementChild : input)?.focus();
  });
  input.addEventListener('input', () => syncSelect(select));
  list.addEventListener('click', e => { const option = e.target.closest('[data-value]'); if (!option) return; select.value = option.dataset.value; select.dispatchEvent(new Event('change', { bubbles: true })); syncSelect(select); close(true); });
  box.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(true); e.stopPropagation(); }
    if (e.key === 'Tab') close(false);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); if (pop.hidden) { button.click(); return; }
      const options = [...list.querySelectorAll('button')], at = options.indexOf(document.activeElement);
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[index]?.focus();
    }
  });
  document.addEventListener('pointerdown', e => { if (!box.contains(e.target)) close(false); });
  new MutationObserver(() => syncSelect(select)).observe(select, { childList: true, subtree: true });
  select.addEventListener('change', () => syncSelect(select)); syncSelect(select);
}

let inspectorTicket = 0;
async function inspectItem(id) {
  const row = browserRows().find(r => r.it.id === id); if (!row) return;
  hideTip();
  const dialog = document.getElementById('itemDialog');
  const ticket = ++inspectorTicket, sid = state.sessionId, prev = state.snapshot === 'prev';
  state.inspectorId = id;
  document.getElementById('inspectorTitle').textContent = row.it.title;
  document.getElementById('inspectorCategory').textContent = row.c.label;
  document.getElementById('inspectorMeta').textContent = `≈${cnum(row.it.tokens)} tokens · ${fmt(row.it.chars)} 字符 · 上下文第 ${row.it.seq + 1} 项`;
  document.getElementById('inspectorContent').textContent = row.it.preview;
  document.getElementById('inspectorNote').textContent = '正在读取条目内容…';
  document.getElementById('inspectorCopy').disabled = true;
  const rows = browserRows(), index = rows.findIndex(r => r.it.id === id);
  document.getElementById('inspectorPrev').disabled = index <= 0;
  document.getElementById('inspectorNext').disabled = index >= rows.length - 1;
  if (!dialog.open) dialog.showModal();
  try {
    const data = await callTool('get_context_item', { session_id: sid, item_id: id, prev });
    if (ticket !== inspectorTicket || !dialog.open) return;
    document.getElementById('inspectorContent').textContent = data.content;
    document.getElementById('inspectorNote').textContent = data.truncated ? '内容较长，展示前 32,000 字符。' : 'Token 按字符权重估算，并用模型上报的输入总量校准。';
    document.getElementById('inspectorCopy').disabled = false;
  } catch (e) { if (ticket === inspectorTicket) document.getElementById('inspectorNote').textContent = e.message; }
}

function bootInteractions() {
  document.getElementById('tabs').setAttribute('role', 'tablist');
  document.getElementById('tabs').setAttribute('aria-label', '看板页面');
  document.querySelectorAll('#tabs button').forEach((b, i) => {
    b.id = 'nav-' + b.dataset.tab; b.role = 'tab'; b.tabIndex = i ? -1 : 0;
    b.setAttribute('aria-selected', String(i === 0)); b.setAttribute('aria-controls', 'tab-' + b.dataset.tab);
    const page = document.getElementById('tab-' + b.dataset.tab); page.role = 'tabpanel'; page.setAttribute('aria-labelledby', b.id);
  });
  document.getElementById('tabs').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); const tabs = [...document.querySelectorAll('#tabs button')], at = tabs.indexOf(document.activeElement);
    const idx = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[idx].focus(); tabs[idx].click();
  });
  document.querySelectorAll('select').forEach(enhanceSelect);
  document.addEventListener('pointermove', e => {
    lastInput = 'pointer';
    const anchor = e.target.closest('[data-tip]'); if (anchor && anchor !== tipAnchor) showTip(anchor);
  });
  document.addEventListener('keydown', () => { lastInput = 'keyboard'; }, true);
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('pointerover', e => {
    hoverElement = e.target;
    const title = e.target.closest('[title]');
    if (title) { title.dataset.tip = title.title; title.removeAttribute('title'); }
    const tip = e.target.closest('[data-tip]'); if (tip && lastInput === 'pointer') showTip(tip);
    highlightDonut(e.target);
    const cat = e.target.closest('[data-cat]'); if (cat) { state.hoverCat = cat.dataset.cat; highlightCategory(cat.dataset.cat, cat.dataset.item); }
  });
  document.addEventListener('pointerout', e => {
    const next = e.relatedTarget instanceof Element ? e.relatedTarget : null;
    if (!next?.closest('[data-tip]')) hideTip();
    const donut = e.target.closest('.donutWrap'); if (donut && !donut.contains(next)) highlightDonut(donut);
    if (e.target.closest('[data-cat]') && !next?.closest('[data-cat]')) { state.hoverCat = null; highlightCategory(); }
  });
  document.addEventListener('focusin', e => {
    const tip = e.target.closest('[data-tip]'); if (tip) showTip(tip); highlightDonut(e.target);
    const cat = e.target.closest('[data-cat]'); if (cat) { state.hoverCat = cat.dataset.cat; highlightCategory(cat.dataset.cat, cat.dataset.item); }
  });
  document.addEventListener('focusout', e => { hideTip(); const wrap = e.target.closest('.donutWrap'); if (wrap) highlightDonut(wrap); state.hoverCat = null; highlightCategory(); });
  document.addEventListener('scroll', () => {
    hideTip();
    if (lastInput === 'keyboard') requestAnimationFrame(() => { const anchor = document.activeElement.closest?.('[data-tip]'); if (anchor) showTip(anchor); });
  }, true); window.addEventListener('resize', hideTip);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { hideTip(); document.querySelectorAll('.donutWrap[data-pinned]').forEach(w => { delete w.dataset.pinned; highlightDonut(w); }); } });
  document.addEventListener('click', e => {
    const slice = e.target.closest('[data-slice]');
    if (slice) { const wrap = slice.closest('.donutWrap'); if (wrap) { if (wrap.dataset.pinned === slice.dataset.slice) delete wrap.dataset.pinned; else wrap.dataset.pinned = slice.dataset.slice; highlightDonut(slice); } }
    const item = e.target.closest('[data-item]'); if (item) { inspectItem(item.dataset.item); return; }
    const cat = e.target.closest('[data-pick-cat]'); if (cat) { pickCategory(cat.dataset.pickCat); return; }
    const session = e.target.closest('[data-sid]'); if (session) { selectSession(session.dataset.sid); return; }
    const group = e.target.closest('[data-group]'); if (group) { state.group = group.dataset.group; renderSessions(); return; }
    const date = e.target.closest('[data-day]'); if (date) { state.day = state.day === date.dataset.day ? null : date.dataset.day; renderSessions(); renderDaily(state.insights); renderHeatmap(state.insights); reveal(document.getElementById('insSessions')); }
    const kpi = e.target.closest('[data-kpi]'); if (kpi) {
      const index = Number(kpi.dataset.kpi);
      if (index === 0) { state.group = ''; state.day = null; state.search = ''; state.archive = ''; document.getElementById('sessSearch').value = ''; document.getElementById('sessArchive').value = ''; syncSelect(document.getElementById('sessArchive')); renderSessions(); reveal(document.getElementById('insSessions')); }
      else if (index === 2) toast('可在本地配置 prices 为不同 GLM 模型设置单价。套餐额度不等同于按量计费。');
      else reveal(document.getElementById(index === 4 ? 'insToolsList' : index === 5 ? 'insTimingBody' : 'insTokensBody'));
    }
  });
  document.getElementById('sessArchive').addEventListener('change', e => { state.archive = e.target.value; renderSessions(); });
  document.getElementById('clearSessionFilters').addEventListener('click', () => {
    state.day = null; state.group = ''; state.search = ''; state.archive = '';
    document.getElementById('sessSearch').value = ''; document.getElementById('sessArchive').value = ''; syncSelect(document.getElementById('sessArchive'));
    renderSessions(); renderDaily(state.insights); renderHeatmap(state.insights);
  });
  document.getElementById('browserSearch').addEventListener('input', e => { state.browserQuery = e.target.value.trim().toLowerCase(); renderBrowser(); });
  document.getElementById('browserClear').addEventListener('click', () => { state.browserQuery = ''; document.getElementById('browserSearch').value = ''; renderBrowser(); document.getElementById('browserSearch').focus(); });
  document.getElementById('browserSnapshot').addEventListener('click', e => {
    const b = e.target.closest('[data-snapshot]'); if (!b || b.disabled) return;
    state.snapshot = b.dataset.snapshot; state.browser = null; state.catPick = null; requestTickets.browser++; inFlight.browser = false;
    document.querySelectorAll('[data-snapshot]').forEach(el => { el.classList.toggle('on', el === b); el.setAttribute('aria-pressed', String(el === b)); });
    loadBrowser();
  });
  document.getElementById('ctxFleetN').role = 'button'; document.getElementById('ctxFleetN').tabIndex = 0;
  document.getElementById('ctxFleetN').onclick = () => switchTab('agent');
  document.getElementById('ctxFleetN').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTab('agent'); } };
  const dialog = document.getElementById('itemDialog');
  document.getElementById('inspectorClose').onclick = () => dialog.close();
  dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => { inspectorTicket++; });
  for (const [name, delta] of [['Prev', -1], ['Next', 1]]) document.getElementById('inspector' + name).onclick = () => {
    const rows = browserRows(), idx = rows.findIndex(r => r.it.id === state.inspectorId); if (rows[idx + delta]) inspectItem(rows[idx + delta].it.id);
  };
  document.getElementById('inspectorCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(document.getElementById('inspectorContent').textContent); toast('内容已复制'); }
    catch { const range = document.createRange(); range.selectNodeContents(document.getElementById('inspectorContent')); getSelection().removeAllRanges(); getSelection().addRange(range); toast('内容已选中，可按 ⌘C / Ctrl+C 复制'); }
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopLive(); else startLive(); });
}
bootInteractions();
