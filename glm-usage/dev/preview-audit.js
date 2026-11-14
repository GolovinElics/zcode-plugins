const auditRuns = [], auditPending = new Map(), identities = new WeakMap();
let nextIdentity = 0;
function auditSnapshot() {
  const doc = frame.contentDocument;
  if (!doc) return {};
  const page = doc.querySelector('.tabpage:not([hidden])');
  const nodes = [...(page?.querySelectorAll('.quotaSection, .sparkBox svg, .healthPoint, .sCard, .donutWrap, [data-step], .brItem, .agentCard, [data-edge]') || [])];
  const keyed = nodes.map(el => {
    if (!identities.has(el)) identities.set(el, ++nextIdentity);
    return identities.get(el);
  });
  return {
    page: page?.id, nodes: keyed,
    y: doc.scrollingElement.scrollTop,
    height: page?.getBoundingClientRect().height,
    search: [...doc.querySelectorAll('input[type=search]')].filter(e => page?.contains(e)).map(e => e.value),
    selected: [...(page?.querySelectorAll('[aria-pressed=true], .donutWrap[data-pinned]') || [])].map(e => e.dataset.step || e.dataset.agent || e.dataset.pickCat || e.dataset.day || e.dataset.pinned || e.textContent.trim().slice(0,40)),
  };
}
function auditStart(id, params) { auditPending.set(id, {tool:params.name,before:auditSnapshot()}); }
function auditEnd(id) {
  const run = auditPending.get(id); if (!run) return;
  auditPending.delete(id);
  setTimeout(() => {
    const after = auditSnapshot(), before = run.before;
    const alive = new Set(after.nodes || []);
    auditRuns.push({tool:run.tool,page:after.page,samePage:before.page===after.page,
      removed:(before.nodes || []).filter(id=>!alive.has(id)).length,
      scrollDelta:Math.round((after.y || 0)-(before.y || 0)),
      heightDelta:Math.round((after.height || 0)-(before.height || 0)),
      searchKept:JSON.stringify(before.search)===JSON.stringify(after.search),
      selectionKept:JSON.stringify(before.selected)===JSON.stringify(after.selected),
      at:new Date().toISOString()});
    if(auditRuns.length>80) auditRuns.shift();
    document.getElementById('auditStatus').textContent=JSON.stringify(auditRuns);
  },350);
}
const report=document.createElement('details'); report.style.cssText='position:fixed;right:0;top:0;z-index:10;background:#202023;color:#ddd;font:11px monospace;max-width:80vw;max-height:40vh;overflow:auto';
report.innerHTML='<summary>刷新回归记录</summary><pre id="auditStatus">[]</pre>';
document.body.append(report);
