/* 模型价格管理：本地模型自动匹配推荐 / 单条·批量应用 / 手动定价与覆盖 / 多源同步（LiteLLM·OpenRouter）。
 * 入口：洞察页「预估费用」KPI 与 用量页设置区；dialog 模式与 activity.js 同构。
 * 计价口径不变：config.prices = { 模型: [输入, 输出] }（¥/百万 tokens）；同步只更新参考目录，应用必须显式点击。 */
const pricing = { ticket: 0, data: null, editing: null, alt: {} };
const PRICE_SRC = { builtin: '内置参考', litellm: 'LiteLLM', openrouter: 'OpenRouter', manual: '手动' };

async function openPricing() {
  hideTip();
  const ticket = ++pricing.ticket;
  pricing.data = null; pricing.editing = null; pricing.alt = {};
  const dialog = document.getElementById('priceDialog');
  if (!dialog.open) dialog.showModal();
  document.getElementById('priceSearch').value = '';
  patchHTML('priceModels', '<div class="loadingRows" role="status" aria-label="正在读取价格配置"><i></i><i></i><i></i></div>');
  try {
    const data = await callTool('get_pricing', {});
    if (ticket !== pricing.ticket || !dialog.open) return;
    pricing.data = data;
    renderPricing();
  } catch (e) {
    if (ticket === pricing.ticket) patchHTML('priceModels', `<div class="empty">${esc(e.message)}</div>`);
  }
}
async function refreshPricing() {
  const ticket = ++pricing.ticket;
  try {
    const data = await callTool('get_pricing', pricing.query ? { query: pricing.query } : {});
    if (ticket !== pricing.ticket) return;
    pricing.data = data;
    if (pricing.editing != null && !data.local_models[pricing.editing]) pricing.editing = null;
    renderPricing();
  } catch (e) { toast('价格数据刷新失败：' + e.message); }
}
function priceChip(rec, extra) {
  return `<span class="priceChip${extra || ''}" data-tip="${esc(rec.name)} · ${PRICE_SRC[rec.source] || rec.source}${rec.tier === 2 ? ' · 官方线' : ' · 中转参考'} · 置信 ${rec.confidence}%${rec.note ? '\n' + esc(rec.note) : ''}">¥${rec.price_cny[0]} / ¥${rec.price_cny[1]}</span>`;
}
function renderPricing() {
  const d = pricing.data;
  if (!d) return;
  document.getElementById('priceRate').value = d.usd_cny;
  const srcBits = Object.entries(d.catalog?.sources || {}).map(([k, s]) => `${s.label || k} ${Number(s.count || 0).toLocaleString('zh-CN')} 条${s.at ? ' · ' + agoTs(s.at) : '（未同步）'}`);
  document.getElementById('priceSync').textContent = `目录：内置 ${d.catalog?.builtin || 0} 条 · ` + (srcBits.join(' · ') || '尚未同步外部目录');
  const models = d.local_models || [];
  const unpricedWithRec = models.filter(m => !m.price && m.recs?.length);
  const applyAll = document.getElementById('priceApplyAll');
  applyAll.disabled = !unpricedWithRec.length;
  applyAll.textContent = unpricedWithRec.length ? `全部应用推荐（${unpricedWithRec.length}）` : '全部应用推荐';
  patchHTML('priceModels', models.map((m, i) => {
    const rec = (m.recs || [])[0], altOpen = pricing.alt[i], editing = pricing.editing === i;
    const rows = [`<div class="priceRow" data-key="${esc(m.norm)}">`,
      `<div class="prMain"><div class="prName">${esc(m.model)}${m.price ? '<span class="badge active">已计价</span>' : '<span class="badge">未计价</span>'}</div>`,
      `<div class="prUse muted">${m.calls ? m.calls.toLocaleString('zh-CN') + ' 次调用 · 输入 ' + cnum(m.in_t) + ' · 输出 ' + cnum(m.out_t) : '本地无调用记录（仅配置）'}</div></div>`,
      `<div class="prCur">${m.price ? `<b>¥${m.price[0]} / ¥${m.price[1]}</b><span class="muted">每百万 tokens · 来源 ${PRICE_SRC[m.meta?.source] || '手动'}${m.meta?.at ? ' · ' + agoTs(m.meta.at) : ''}</span>` : '<span class="muted">未配置价格</span>'}</div>`,
      `<div class="prRec">${rec
        ? priceChip(rec) + `<button class="textButton" data-apply="${i}">应用</button>${m.recs.length > 1 ? `<button class="textButton" data-alt="${i}">${altOpen ? '收起' : '备选 ' + (m.recs.length - 1)}</button>` : ''}`
        : '<span class="muted">目录中无匹配</span>'}</div>`,
      `<div class="prOps"><button class="textButton" data-edit="${i}">${m.price ? '编辑' : '手动定价'}</button>${m.price ? `<button class="textButton" data-remove="${i}">移除</button>` : ''}</div>`,
      altOpen && m.recs?.length > 1 ? `<div class="priceAlt">${m.recs.slice(1).map((r, j) => `<div class="priceAltRow">${priceChip(r)}<span class="muted">${esc(r.name)} · ${PRICE_SRC[r.source]}${r.tier === 2 ? ' · 官方线' : ' · 中转'}</span><button class="textButton" data-apply-alt="${i}:${j + 1}">应用</button></div>`).join('')}</div>` : '',
      editing ? `<div class="priceEdit"><input type="number" step="0.01" min="0" id="peIn" value="${m.price ? m.price[0] : rec?.price_cny[0] ?? ''}" placeholder="输入 ¥/百万"><input type="number" step="0.01" min="0" id="peOut" value="${m.price ? m.price[1] : rec?.price_cny[1] ?? ''}" placeholder="输出 ¥/百万"><button data-save="${i}">保存</button><button class="textButton" data-cancel="1">取消</button><span class="muted">口径：¥ 每百万 tokens</span></div>` : '',
      `</div>`].join('');
    return rows;
  }).join('') || '<div class="empty">本地还没有模型调用记录。可在下方手动添加价格。</div>');
  renderPriceSearch();
}
function renderPriceSearch() {
  const out = document.getElementById('priceSearchOut');
  const results = pricing.data?.search;
  if (!results) { patchElement(out, ''); return; }
  patchElement(out, results.map((r, i) => `<div class="priceAltRow">${priceChip(r)}<span class="muted">${esc(r.name)} · ${PRICE_SRC[r.source] || r.source}${r.tier === 2 ? ' · 官方线' : ' · 中转'}${r.cur === 'USD' ? ` · $${r.in}/$${r.out}` : ''}</span><button class="textButton" data-apply-search="${esc(r.key)}" data-in="${r.price_cny[0]}" data-out="${r.price_cny[1]}">应用</button></div>`).join('') || '<div class="muted" style="padding:6px 0">目录中没有匹配的模型。</div>');
}
async function applyPrices(patch, meta) {
  try {
    const r = await callTool('set_prices', { prices: patch, meta: meta || undefined });
    toast(`已应用 ${r.applied} 条价格${r.removed ? `，移除 ${r.removed} 条` : ''}`);
    pricing.editing = null;
    await refreshPricing();
    if (state.tab === 'insights') loadInsights(true); // 费用 KPI / 日费用随之刷新
  } catch (e) { toast('保存失败：' + e.message); }
}
async function syncPriceSource(source, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '同步中…';
  document.getElementById('priceSync').textContent = `正在同步 ${source === 'litellm' ? 'LiteLLM' : 'OpenRouter'} 目录…`;
  try {
    const r = await callTool('sync_pricing', { source });
    toast(`${r.label} 已同步 ${r.count.toLocaleString('zh-CN')} 条参考价格`);
    await refreshPricing();
  } catch (e) {
    toast('同步失败：' + e.message);
    document.getElementById('priceSync').textContent = '同步失败：' + e.message;
  } finally { btn.disabled = false; btn.textContent = old; }
}
function bootPricing() {
  const dialog = document.createElement('dialog');
  dialog.id = 'priceDialog';
  dialog.className = 'inspectorDialog pricingDialog';
  dialog.setAttribute('aria-labelledby', 'priceTitle');
  dialog.innerHTML = `<div class="inspectorHead"><div><div class="muted">洞察 · 费用估算</div><h2 id="priceTitle">模型价格管理</h2></div><button class="closeButton" aria-label="关闭价格管理">×</button></div>
  <div class="priceToolbar">
    <label class="muted" for="priceRate">汇率 1 USD =</label><input id="priceRate" type="number" step="0.05" min="0.5" max="50" style="width:64px" aria-label="美元兑人民币汇率"><span class="muted">CNY · 用于换算目录美元价</span>
    <button data-sync="litellm" title="社区维护的全厂商价格目录（约 6000 条）">同步 LiteLLM</button>
    <button data-sync="openrouter" title="OpenRouter 直连/中转挂牌价（约 470 条）">同步 OpenRouter</button>
    <span id="priceSync" class="muted"></span>
    <button id="priceApplyAll" class="textButton" style="margin-left:auto">全部应用推荐</button>
  </div>
  <div id="priceBody"><div class="priceModels" id="priceModels"></div>
  <div class="priceSearchRow"><input type="search" id="priceSearch" class="searchInput" placeholder="搜索目录模型（gpt / claude / deepseek / glm …），回车查看参考价" aria-label="搜索价格目录"></div>
  <div id="priceSearchOut"></div>
  <div class="priceAdd">
    <input id="priceAddKey" class="searchInput" placeholder="手动添加：模型 key（glm-5.3 / deepseek-chat / *）">
    <input id="priceAddIn" type="number" step="0.01" min="0" placeholder="输入 ¥/百万">
    <input id="priceAddOut" type="number" step="0.01" min="0" placeholder="输出 ¥/百万">
    <button id="priceAddBtn">添加</button>
  </div>
  <div class="muted" style="margin-top:10px">价格保存在 ~/.glm-usage/config.json（仅本地）。费用 = 输入×输入价 + 输出×输出价，缓存读按输入价估算。同步只更新参考目录，不会自动改写已配置价格；内置参考价可在编辑中随时覆盖。</div></div>`;
  document.body.append(dialog);
  dialog.querySelector('.closeButton').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { pricing.ticket++; hideTip(); });
  dialog.addEventListener('click', async e => {
    const sync = e.target.closest('[data-sync]');
    if (sync) { syncPriceSource(sync.dataset.sync, sync); return; }
    const apply = e.target.closest('[data-apply]');
    if (apply) {
      const m = pricing.data.local_models[Number(apply.dataset.apply)];
      const rec = m?.recs?.[0];
      if (rec) applyPrices({ [m.norm]: rec.price_cny }, { [m.norm]: { source: rec.source, at: Date.now(), name: rec.name } });
      return;
    }
    const applyAlt = e.target.closest('[data-apply-alt]');
    if (applyAlt) {
      const [i, j] = applyAlt.dataset.applyAlt.split(':').map(Number);
      const m = pricing.data.local_models[i], rec = m?.recs?.[j];
      if (rec) applyPrices({ [m.norm]: rec.price_cny }, { [m.norm]: { source: rec.source, at: Date.now(), name: rec.name } });
      return;
    }
    const applySearch = e.target.closest('[data-apply-search]');
    if (applySearch) {
      const b = applySearch;
      const key = b.dataset.applySearch;
      applyPrices({ [key]: [Number(b.dataset.in), Number(b.dataset.out)] }, { [key]: { source: 'manual', at: Date.now(), note: '目录检索应用' } });
      return;
    }
    if (e.target.closest('#priceApplyAll')) {
      const patch = {}, meta = {};
      for (const m of pricing.data.local_models.filter(x => !x.price && x.recs?.length)) {
        const rec = m.recs[0];
        patch[m.norm] = rec.price_cny;
        meta[m.norm] = { source: rec.source, at: Date.now(), name: rec.name };
      }
      if (Object.keys(patch).length) applyPrices(patch, meta);
      return;
    }
    const alt = e.target.closest('[data-alt]');
    if (alt) { const i = Number(alt.dataset.alt); pricing.alt[i] = !pricing.alt[i]; renderPricing(); return; }
    const edit = e.target.closest('[data-edit]');
    if (edit) { pricing.editing = Number(edit.dataset.edit); renderPricing(); setTimeout(() => document.getElementById('peIn')?.focus(), 30); return; }
    if (e.target.closest('[data-cancel]')) { pricing.editing = null; renderPricing(); return; }
    const save = e.target.closest('[data-save]');
    if (save) {
      const m = pricing.data.local_models[Number(save.dataset.save)];
      const i = Number(document.getElementById('peIn').value), o = Number(document.getElementById('peOut').value);
      if (!(i >= 0) || !(o >= 0)) { toast('请输入有效的价格（≥0）'); return; }
      applyPrices({ [m.norm]: [i, o] }, { [m.norm]: { source: 'manual', at: Date.now() } });
      return;
    }
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      const m = pricing.data.local_models[Number(remove.dataset.remove)];
      if (m) applyPrices({ [m.norm]: null });
      return;
    }
    if (e.target.closest('#priceAddBtn')) {
      const key = document.getElementById('priceAddKey').value.trim().toLowerCase();
      const i = Number(document.getElementById('priceAddIn').value), o = Number(document.getElementById('priceAddOut').value);
      if (!key || !(i >= 0) || !(o >= 0)) { toast('请填写模型 key 与输入/输出价格'); return; }
      applyPrices({ [key]: [i, o] }, { [key]: { source: 'manual', at: Date.now() } });
      return;
    }
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    }
  });
  document.getElementById('priceRate').addEventListener('change', async e => {
    const v = Number(e.target.value);
    if (!(v >= 0.5 && v <= 50)) { toast('汇率需在 0.5~50 之间'); e.target.value = pricing.data?.usd_cny || 7.2; return; }
    try { await callTool('set_prices', { usd_cny: v }); toast(`汇率已设为 ${v}`); refreshPricing(); }
    catch (err) { toast('保存失败：' + err.message); }
  });
  let searchTimer = null;
  document.getElementById('priceSearch').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => { pricing.query = q; refreshPricing(); }, q ? 350 : 0);
  });
}
bootPricing();
