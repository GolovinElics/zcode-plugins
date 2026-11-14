import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function element(dataset = {}, tagName = 'BUTTON') {
  const classes = new Set(), attributes = {};
  return { dataset, tagName, attributes, classes,
    classList: { toggle(key, on) { if (on) classes.add(key); else classes.delete(key); } },
    setAttribute(key, value) { attributes[key] = value; },
  };
}
function runtime(document = {}) {
  const context = vm.createContext({ document, state: {}, esc: String, cnum: String, fmt: String, durMs: String });
  for (const file of ['interactions.js', 'context-browser.js', 'charts.js']) {
    const source = readFileSync(new URL('../plugin/' + file, import.meta.url), 'utf8').replace(/^bootInteractions\(\);$/m, '');
    vm.runInContext(source, context);
  }
  return context;
}
function donutHarness() {
  const arcs = [element({slice:'缓存读取'}, 'circle'), element({slice:'输出'}, 'circle')];
  const rows = [element({slice:'缓存读取',value:'900',label:'缓存读取'}), element({slice:'输出',value:'100',label:'输出'})];
  const value = {}, label = {}, center = {dataset:{value:'1000',label:'总用量'},querySelector:s=>s==='b'?value:label};
  const wrap = {dataset:{},closest:()=>wrap,querySelectorAll:s=>s.startsWith('button')?rows:[...arcs,...rows],querySelector:s=>s==='.lc-donut-center'?center:rows.find(r=>s.includes(r.dataset.slice))};
  wrap.closest = selector => selector === '.donutWrap' ? wrap : null;
  for (const row of [...rows,...arcs]) row.closest = selector => selector === '.donutWrap' ? wrap : row;
  return {arcs,rows,wrap,value,label};
}
test('donut returns to pinned segment over the center, and to totals when unpinned', () => {
  const r = runtime(), d = donutHarness();
  r.highlightDonut(d.rows[0]); assert(d.arcs[1].classes.has('dimmed'));
  r.highlightDonut(d.wrap); assert.equal(d.value.textContent,'1000'); assert(!d.arcs[1].classes.has('dimmed'));
  d.wrap.dataset.pinned='缓存读取'; r.highlightDonut(d.rows[1]); assert.equal(d.value.textContent,'100');
  r.highlightDonut(d.wrap); assert.equal(d.value.textContent,'900'); assert.equal(d.rows[0].attributes['aria-pressed'],'true');
});
test('a disappearing donut category clears the pin instead of dimming every slice', () => {
  const r=runtime(),d=donutHarness(); d.wrap.dataset.pinned='已消失分类'; r.highlightDonut(d.wrap);
  assert.equal(d.wrap.dataset.pinned,undefined); assert.equal(d.label.textContent,'总用量');
  assert(d.arcs.every(a=>!a.classes.has('dimmed')));
});
test('donut identities remain stable when a zero-valued category appears', () => {
  const r=runtime();
  const before=r.donutLegendBlock([{n:'输出',v:10,c:'red'}],'10','总用量',118);
  const after=r.donutLegendBlock([{n:'缓存读取',v:20,c:'green'},{n:'输出',v:10,c:'red'}],'30','总用量',118);
  assert(before.includes('data-slice="输出"')); assert(after.includes('data-slice="输出"'));
  assert(!after.includes('NaN'));
  r.highlightDonut({closest:()=>null});
});
test('agent hover overrides a pin temporarily and links cards, rows and the correct edge', () => {
  const nodes=['lead','a','a','b','b'].map(agent=>element({agent}));
  const edges=['a','b'].map(edge=>element({edge},'g'));
  const r=runtime({querySelectorAll:s=>s==='[data-edge]'?edges:nodes});
  Object.assign(r.state,{fleet:{lead:{id:'lead'}},agentPick:'a',agentHover:'b'});
  r.highlightAgent(); assert.equal(nodes.filter(n=>n.classes.has('agentHot')).length,2);
  assert(nodes[1].classes.has('agentPinned')); assert(edges[1].classes.has('edgeHot')); assert(edges[0].classes.has('edgeDim'));
  r.state.agentHover=null; r.highlightAgent(); assert(edges[0].classes.has('edgeHot')); assert(nodes[1].classes.has('agentHot'));
  r.state.agentPick=null; r.highlightAgent(); assert(nodes.every(n=>!n.classes.has('agentDim'))); assert(edges.every(e=>!e.classes.has('edgeHot')));
});
test('trend hover previews another step then restores the pinned detail and linked event', () => {
  const groups=['one','two'].map(step=>element({step},'g')), events=[element({eventTs:'190'})],detail={};
  const r=runtime({querySelectorAll:s=>s.includes('ctxEvents')?events:groups,getElementById:()=>detail});
  r.patchHTML=(_id,html)=>{detail.html=html;};
  vm.runInContext("trendValues = [{key:'one',number:1,ts:100,input:10,output:2,cr:5,dur:1,model:'glm',status:'completed'},{key:'two',number:2,ts:200,input:20,output:2,cr:10,dur:2,model:'glm',status:'completed'}]",r);
  Object.assign(r.state,{trendKey:'one',trendHover:'two'}); r.updateTrendPick();
  assert(detail.html.includes('第 2 步')); assert(events[0].classes.has('eventHot')); assert(groups[0].classes.has('selected'));
  r.state.trendHover=null; r.updateTrendPick(); assert(detail.html.includes('第 1 步')); assert(!events[0].classes.has('eventHot'));
  r.state.trendKey=null; r.updateTrendPick(); assert(detail.hidden);
});
test('scroll clears transient hover while preserving pinned requests and agents', () => {
  const r=runtime({querySelectorAll:()=>[]});
  Object.assign(r.state,{trendHover:'preview',trendKey:'pinned',agentHover:'b',agentPick:'a',hoverCat:'tools',catPick:'system'});
  const calls=[];
  for(const name of ['highlightCategory','highlightDay','updateTrendPick','highlightAgent','renderAgentInspector']) r[name]=()=>calls.push(name);
  r.resetTransientHover();
  assert.equal(r.state.trendHover,null); assert.equal(r.state.trendKey,'pinned');
  assert.equal(r.state.agentHover,null); assert.equal(r.state.agentPick,'a');
  assert.equal(r.state.hoverCat,null); assert.equal(r.state.catPick,'system');
  assert(calls.includes('updateTrendPick')); assert(calls.includes('renderAgentInspector'));
});
test('fleet connectors follow horizontal and folded card geometry', () => {
  const parent={left:10,top:20,width:100,height:80,right:110,bottom:100};
  for(const [child,expected] of [
    [{left:146,top:20,width:100,height:80},'M 100 40 C 118 40 118 40 136 40'],
    [{left:10,top:128,width:100,height:80},'M 50 80 C 50 94 50 94 50 108'],
  ]) {
    const svg={setAttribute(){}},lead={getBoundingClientRect:()=>parent};
    const member={dataset:{agent:'child'},getBoundingClientRect:()=>child};
    const grid={offsetWidth:300,getBoundingClientRect:()=>({left:10,top:20,width:300,height:220}),querySelector:()=>lead,querySelectorAll:()=>[member]};
    const r=runtime({getElementById:id=>id==='fleetGrid'?grid:svg,querySelectorAll:()=>[]});
    let rendered='';r.patchHTML=(_id,html)=>{rendered=html;};r.drawFleetEdges();
    assert(rendered.includes(expected));assert(rendered.includes('data-edge="child"'));
  }
});
test('session return restores independent filters, pins and expansion without sharing mutable state', () => {
  const wrap={dataset:{pinned:'缓存读取'}};
  const r=runtime({querySelectorAll:()=>[],getElementById:()=>({querySelector:()=>wrap})});
  Object.assign(r.state,{sessionId:'a',sessionTitle:'A',dna:'dna',trendMode:'delta',snapshot:'prev',catPick:'tool_results',browserQuery:'Bash',trendKey:'step-a',agentPick:'child-a',expanded:new Set(['tool_results']),rowLimits:{tool_results:160}});
  r.saveContextView();r.restoreContextView('b');assert.equal(r.state.browserQuery,'');assert.equal(r.state.trendKey,null);
  r.state.sessionId='b';r.state.browserQuery='Read';delete wrap.dataset.pinned;r.saveContextView();r.restoreContextView('a');
  assert.equal(r.state.browserQuery,'Bash');assert.equal(r.state.trendKey,'step-a');assert.equal(r.state.pendingContextPins.ctxTokensBody,'缓存读取');
  assert(r.state.expanded.has('tool_results'));r.state.expanded.add('assistant');r.state.rowLimits.tool_results=999;
  r.restoreContextView('a');assert(!r.state.expanded.has('assistant'));assert.equal(r.state.rowLimits.tool_results,160);
  r.restoreContextView('b');assert.equal(r.state.browserQuery,'Read');assert.equal(r.state.pendingContextPins.ctxTokensBody,undefined);
});
test('fleet data refresh patches members without clearing the separately maintained connectors', () => {
  const elements=new Map();const r=runtime({querySelectorAll:()=>[],getElementById:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);}});
  r.requestAnimationFrame=()=>{};r.ResizeObserver=class {observe(){}};r.hash=()=>0;r.highlightAgent=()=>{};r.renderAgentInspector=()=>{};
  const writes=[];r.patchHTML=(id,html)=>writes.push(id);r.state.fleet={lead:{id:'root'},members:[{id:'child',title:'Child'}]};
  r.renderFleet();r.state.fleet.lead.context=42;r.renderFleet();
  assert(writes.includes('fleetNodes'));assert(!writes.includes('fleetGrid'));assert(!writes.includes('agentEdges'));
});
test('rapid switches retain pending pins and the per-session view cache remains bounded', () => {
  const r=runtime({querySelectorAll:()=>[],getElementById:()=>({querySelector:()=>null})});
  Object.assign(r.state,{sessionId:'pending',browserQuery:'search',expanded:new Set(),rowLimits:{},pendingContextPins:{ctxTokensBody:'输出'}});
  r.saveContextView();r.restoreContextView('pending');assert.equal(r.state.pendingContextPins.ctxTokensBody,'输出');
  for(let i=0;i<13;i++){r.state.sessionId='session-'+i;r.saveContextView();}
  r.restoreContextView('pending');assert.equal(r.state.browserQuery,'');assert.equal(r.state.pendingContextPins.ctxTokensBody,undefined);
});
