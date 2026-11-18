import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function runtime() {
  const nodes=new Map(), timers=[], listeners={};
  const node=()=>({style:{},dataset:{},value:'',textContent:'',innerHTML:'',querySelector:()=>null,addEventListener(){},setAttribute(){},getAttribute(){return 'dark';},classList:{add(){},remove(){},toggle(){},contains:()=>false}});
  const document={hidden:false,documentElement:node(),getElementById:id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},querySelectorAll:()=>[]};
  const r=vm.createContext({document,window:{addEventListener(name,fn){listeners[name]=fn;}},setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval(){},clearTimeout, setBusy(){},console});
  vm.runInContext(readFileSync(new URL('../plugin/app.js',import.meta.url),'utf8'),r);
  return {r,nodes,timers,listeners};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const response=data=>({content:[{type:'text',text:JSON.stringify({ok:true,data})}]});
test('automatic quota refresh includes details and health and coalesces overlapping cycles',async()=>{
  const {r,timers}=runtime(),gate=deferred(),calls=[];
  for(const name of ['load','loadDetail','loadHealth'])r[name]=()=>{calls.push(name);return gate.promise;};
  const first=r.refreshUsage(),second=r.refreshUsage();assert.equal(first,second);assert.deepEqual(calls,['load','loadDetail','loadHealth']);
  gate.resolve();await first; r.schedule();r.tick=1;timers.at(-1)();await r.usageRefresh;
  assert.equal(calls.length,6);r.document.hidden=true;r.tick=1;timers.at(-1)();assert.equal(calls.length,6);
});
test('late context response cannot overwrite the newer session or fetch its browser',async()=>{
  const {r}=runtime(),requests=[],rendered=[],browsers=[];
  r.callTool=(_name,args)=>{const d=deferred();requests.push({args,...d});return d.promise;};
  r.fillSessionSelect=()=>{};r.renderContext=()=>rendered.push(r.state.ctx.session.id);r.loadBrowser=async()=>browsers.push(r.state.sessionId);
  r.state.sessionId='a';const a=r.loadContext();r.state.sessionId='b';const b=r.loadContext();
  requests[1].resolve({session:{id:'b',title:'B',updated:0}});await b;
  requests[0].resolve({session:{id:'a',title:'A',updated:0}});await a;
  assert.deepEqual(rendered,['b']);assert.deepEqual(browsers,['b']);assert.equal(r.state.sessionTitle,'B');
});
test('late insights and snapshot responses do not change the selected scope',async()=>{
  const {r}=runtime(),pending=[];r.callTool=()=>{const d=deferred();pending.push(d);return d.promise;};
  for(const name of ['renderInsights','fillSessionSelect','renderSessions','animateSwap','renderBrowser','renderCurrent','renderSnapshotScope'])r[name]=()=>{};
  r.state.range='today';const oldRange=r.loadInsights();r.state.range='30d';const nextRange=r.loadInsights();
  pending[1].resolve({sessions:[],label:'month'});await nextRange;pending[0].resolve({sessions:[],label:'today'});await oldRange;
  assert.equal(r.state.insights.label,'month');
  r.state.sessionId='b';r.state.snapshot='prev';const oldSnapshot=r.loadBrowser();r.state.snapshot='live';const nextSnapshot=r.loadBrowser();
  pending[3].resolve({request_id:'live',cats:[]});await nextSnapshot;pending[2].resolve({request_id:'prev',cats:[]});await oldSnapshot;
  assert.equal(r.state.browser.request_id,'live');
});
test('current session remains an option when the insight date filter excludes it',()=>{
  const {r,nodes}=runtime();let html='';r.patchHTML=(_id,value)=>html=value;
  Object.assign(r.state,{sessions:[],sessionId:'current',sessionTitle:'Current session'});r.fillSessionSelect();
  assert(html.includes('value="current" selected'));assert(html.includes('Current session'));assert.equal(nodes.get('ctxSession').value,'current');
});
test('quota sparkline keeps stable gradient identity for repeated samples',()=>{
  const {r}=runtime(),samples=[[1,10],[2,15],[3,18]];
  assert.equal(r.sparkline(samples,'green','five-hour'),r.sparkline(samples,'green','five-hour'));
  assert.notEqual(r.sparkline(samples,'green','five-hour'),r.sparkline(samples,'green','weekly'));
});
test('detail and health ignore outdated ranges and background renders do not request entrance animation',async()=>{
  const {r}=runtime(),pending=[],renders=[];
  r.window.__bridgeCall=()=>{const d=deferred();pending.push(d);return d.promise;};
  r.renderDetail=animate=>renders.push(['detail',animate]);r.renderHealth=animate=>renders.push(['health',animate]);
  const old=r.loadDetail();r.detailState.days=30;const latest=r.loadDetail();
  pending[1].resolve(response({label:'month'}));await latest;pending[0].resolve(response({label:'week'}));await old;
  const health=r.loadHealth();pending[2].resolve(response({label:'health'}));await health;
  assert.equal(r.detailState.data.label,'month');assert.deepEqual(renders,[['detail',false],['health',false]]);
});
test('paused auto refresh (refresh_seconds=0) registers no timer, keeps manual path working', async () => {
  const { r, timers } = runtime(), calls = [];
  r.refreshUsage = () => { calls.push('refresh'); return Promise.resolve(); };
  r.REFRESH = 0; r.tick = 0; r.schedule();
  assert.equal(timers.length, 0); // 不再注册倒计时定时器
  assert.equal(r.document.getElementById('countdown').textContent, '刷新已暂停');
  timers.at(-1)?.(); // 无定时器可触发
  assert.deepEqual(calls, []);
  await r.manualRefresh(); // 手动刷新仍可用（图标旋转包装不阻断）
  assert.deepEqual(calls, ['refresh']);
});
test('renderSubline reflects paused auto pull', async () => {
  const { r } = runtime();
  r.renderSubline(0);
  assert.match(r.document.getElementById('subline').innerHTML, /已暂停/);
  r.renderSubline(45);
  assert.match(r.document.getElementById('subline').innerHTML, /每 45 秒/);
});

test('the health card dates previous official readings and retains local readings during a network failure', () => {
  const {r} = runtime();
  vm.runInContext(readFileSync(new URL('../plugin/health-chart.js',import.meta.url),'utf8'),r);
  const out = new Map();
  r.patchHTML = (id, value) => out.set(id,value);
  r.speedChart = () => 'chart';
  r.requestAnimationFrame = () => {};
  r.healthState.data = {
    days:1, xTime:['2026-11-19'], proMax:[null], lite:[null], actual:[73], actualN:[8],
    official:false, official_status:'empty',
    official_latest:{ proMax:{value:128.4,date:'2026-11-18'}, lite:{value:102.6,date:'2026-11-18'} },
  };
  r.renderHealth();
  assert.match(out.get('healthSummary'), /128\.4 .*?最近官方 · 11-18/);
  assert.match(out.get('healthSummary'), /102\.6/);
  assert.match(out.get('healthSummary'), /73\.0 .*?8 次 · 11-19/);
  const foot = r.document.getElementById('healthFoot');
  assert.match(foot.textContent, /今天暂无官方测速快照/);
  r.healthState.data.official_latest = {};
  r.healthState.data.official_status = 'network';
  r.renderHealth();
  assert.match(foot.textContent, /官方性能接口连接失败/);
  assert.equal((out.get('healthSummary').match(/无官方样本/g) || []).length, 2);
  assert.match(out.get('healthSummary'), /73\.0/);
  assert.doesNotMatch(out.get('healthSummary'), /—.*?tok\/s/);
});

test('从已暂停配置冷启动只加载首屏，三个时钟周期内无自动请求', async()=>{
  const {r,timers,listeners}=runtime();
  const config=deferred();let loads=0;
  r.restorePersistentViews=async()=>{};r.keyStatus=async()=>{await config.promise;r.REFRESH=0;r.tick=0;};
  r.switchTab=()=>{loads++;};r.refreshUsage=async()=>{loads++;};
  const boot=listeners['bridge-ready']();assert.equal(timers.length,0);
  config.resolve();await boot;
  for(let i=0;i<3;i++)timers.forEach(f=>f());
  assert.equal(timers.length,0);assert.equal(loads,1);
  await r.manualRefresh();assert.equal(loads,2);
});
