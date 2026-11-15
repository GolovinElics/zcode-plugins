const activity = { ticket: 0, data: null, lens: 'all', query: '', pick: '', sort: 'recent', expanded: null };
async function openActivity(kind, pick = '', session = false) {
  hideTip();
  const ticket = ++activity.ticket;
  Object.assign(activity, { data: null, lens: 'all', query: '', pick, sort: 'recent', expanded: null });
  document.getElementById('activityTitle').textContent = ({ tools: '工具调用', commands: '命令执行', files: '文件活动', skills: '技能加载' })[kind];
  document.getElementById('activityScope').textContent = session ? '当前会话 · 本地执行记录' : '当前时间范围 · 本地执行记录';
  document.getElementById('activitySearch').value = '';
  patchHTML('activityRows', '<div class="loadingRows" role="status"><i></i><i></i><i></i></div>');
  patchHTML('activitySummary', ''); patchHTML('activityPrograms', '');
  const dialog = document.getElementById('activityDialog'); if (!dialog.open) dialog.showModal();
  try {
    const data = await callTool('get_activity', { kind, ...(session ? { session_id: state.sessionId } : { range: state.range }) });
    if (ticket !== activity.ticket || !dialog.open) return;
    activity.data = data; renderActivity();
  } catch (e) { if (ticket === activity.ticket) patchHTML('activityRows', `<div class="empty">${esc(e.message)}<br><button onclick="document.getElementById('activityDialog').close()">关闭</button></div>`); }
}
function renderActivity() {
  const data = activity.data; if (!data) return;
  const rows = data.rows || [];
  const lenses = [
    ['all', '全部记录', rows.length], ['failed', '失败', rows.filter(r => r.status === 'error' || (r.exit_code != null && r.exit_code !== 0)).length],
    ['background', '后台执行', rows.filter(r => r.background).length], ['slow', '超过 5 秒', rows.filter(r => r.dur > 5000).length],
  ];
  patchHTML('activitySummary', lenses.map(([key, label, count]) => `<button class="activityKpi ${activity.lens === key ? 'on' : ''}" data-lens="${key}" aria-pressed="${activity.lens === key}"><b>${count}</b><span>${label}</span></button>`).join(''));
  const names = new Map();
  const groupFor = r => data.kind === 'files' ? r.file : data.kind === 'commands' ? r.program : data.kind === 'skills' ? (r.skill || r.name) : r.name;
  rows.forEach(r => { const key = groupFor(r) || '未知'; names.set(key, (names.get(key) || 0) + 1); });
  patchHTML('activityPrograms', `<button class="gchip ${!activity.pick ? 'on' : ''}" data-program="">全部</button>` + [...names].sort((a, b) => b[1] - a[1]).map(([key, count]) => `<button class="gchip ${activity.pick === key ? 'on' : ''}" data-program="${esc(key)}" title="${esc(key)}">${esc(data.kind === 'files' ? key.split('/').pop() : key)} <b>${count}</b></button>`).join(''));
  const filtered = rows.filter(r => (!activity.pick || groupFor(r) === activity.pick)
    && (!activity.query || `${r.name} ${r.command || ''} ${r.file || ''} ${r.skill || ''} ${r.error_type || ''}`.toLowerCase().includes(activity.query))
    && (activity.lens === 'all' || activity.lens === 'failed' && (r.status === 'error' || (r.exit_code != null && r.exit_code !== 0)) || activity.lens === 'background' && r.background || activity.lens === 'slow' && r.dur > 5000))
    .sort((a, b) => activity.sort === 'slow' ? b.dur - a.dur : b.ts - a.ts);
  document.getElementById('activityCount').textContent = `${filtered.length} / ${rows.length} 条${data.truncated ? ' · 仅展示最近 500 条' : ''}`;
  document.getElementById('activitySort').textContent = activity.sort === 'slow' ? '按耗时排序 ↓' : '最近执行 ↓';
  patchHTML('activityRows', filtered.map(r => {
    const failed = r.status === 'error' || (r.exit_code != null && r.exit_code !== 0), open = activity.expanded === r.id;
    return `<section class="activityRecord" data-key="${esc(r.id)}"><button class="activityRecordHead" data-record="${esc(r.id)}" aria-expanded="${open}"><span class="activityStatus ${failed ? 'failed' : ''}">${failed ? '失败' : r.status === 'running' ? '执行中' : r.status === 'cancelled' ? '取消' : '完成'}</span><span class="activityCommand">${esc(r.command || r.file || r.skill || r.name)}</span>${r.background ? '<span class="badge">后台</span>' : ''}<span class="activityDuration">${durMs(r.dur)}</span><span class="muted">${agoTs(r.ts)}</span><span>${open ? '−' : '+'}</span></button>${open ? `<div class="activityDetail"><div>${esc(r.skill || r.name)} · ${new Date(r.ts).toLocaleString('zh-CN')} · 退出码 ${r.exit_code ?? '—'} · 输出 ${fmt(r.output_bytes || 0)} 字节</div><pre>${esc(r.command || r.file || r.skill || r.name)}</pre>${r.error_type ? `<p>错误类型：${esc(r.error_type)}</p>` : ''}<button data-open-session="${esc(r.session_id)}" class="textButton">查看所属会话 ↗</button></div>` : ''}</section>`;
  }).join('') || '<div class="empty">没有匹配记录。点击「全部记录」重置筛选。</div>');
}
function bootActivity() {
  const dialog = document.createElement('dialog'); dialog.id = 'activityDialog'; dialog.className = 'inspectorDialog activityDialog'; dialog.setAttribute('aria-labelledby', 'activityTitle');
  dialog.innerHTML = '<div class="inspectorHead"><div><div class="muted" id="activityScope"></div><h2 id="activityTitle"></h2></div><button class="closeButton" aria-label="关闭活动明细">×</button></div><div id="activitySummary" class="activitySummary"></div><div id="activityPrograms" class="activityPrograms"></div><div class="activityToolbar"><input type="search" id="activitySearch" class="searchInput" placeholder="搜索命令、文件或工具…" aria-label="搜索活动记录"><button id="activitySort" class="textButton">最近执行 ↓</button><span id="activityCount" class="muted"></span></div><div id="activityRows" class="activityRows"></div>';
  document.body.append(dialog);
  dialog.querySelector('.closeButton').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { activity.ticket++; hideTip(); });
  dialog.addEventListener('click', e => {
    const lens = e.target.closest('[data-lens]');
    if (lens) { activity.lens = lens.dataset.lens; activity.query = ''; activity.pick = ''; activity.sort = 'recent'; document.getElementById('activitySearch').value = ''; renderActivity(); }
    const program = e.target.closest('[data-program]'); if (program) { activity.pick = program.dataset.program; renderActivity(); }
    const record = e.target.closest('[data-record]'); if (record) { activity.expanded = activity.expanded === record.dataset.record ? null : record.dataset.record; renderActivity(); }
    const session = e.target.closest('[data-open-session]'); if (session) { dialog.close(); selectSession(session.dataset.openSession); }
    if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); }
  });
  document.getElementById('activitySearch').oninput = e => { activity.query = e.target.value.trim().toLowerCase(); renderActivity(); };
  document.getElementById('activitySort').onclick = () => { activity.sort = activity.sort === 'recent' ? 'slow' : 'recent'; renderActivity(); };
  document.addEventListener('click', e => { const target = e.target.closest('[data-activity]'); if (target && !target.classList.contains('pickRow')) openActivity(target.dataset.activity, target.dataset.pick || '', target.closest('#tab-context') != null); });
  for (const [id, kind] of [['ctxToolChips', 'tools'], ['ctxCmdChips', 'commands']]) {
    const el = document.getElementById(id); el.setAttribute('role', 'button'); el.tabIndex = 0; el.dataset.activity = kind;
    el.setAttribute('aria-label', kind === 'tools' ? '查看工具调用明细' : '查看命令执行明细');
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
  }
}
bootActivity();
