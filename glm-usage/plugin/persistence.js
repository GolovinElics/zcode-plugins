let persistentReady=false;
const lastSaved=new Map();
function capturePins(ids) {
  return Object.fromEntries(ids.map(id=>[id,document.getElementById(id)?.querySelector('.donutWrap')?.dataset.pinned]).filter(([,key])=>key!=null));
}
function persistViews() {
  if(!persistentReady) return;
  saveContextView();
  const global={tab:state.tab,sessionId:state.sessionId,sessionTitle:state.sessionTitle,range:state.range,
    search:state.search,group:state.group,archive:state.archive,day:state.day,sortKey:state.sortKey,sessPage:state.sessPage,
    detailDays:detailState.days,detailTab:detailState.tab,healthDays:healthState.days,
    pins:pendingInsightPins || capturePins(['insTokensBody','insTimingBody'])};
  const entries=[['global',global],...(state.sessionId?[[`session:${state.sessionId}`,contextViews.get(state.sessionId)]]:[])];
  for(const [key,value] of entries){
    const signature=JSON.stringify(value);if(lastSaved.get(key)===signature)continue;
    lastSaved.set(key,signature);
    callTool('save_view_state',{key,value}).catch(()=>{lastSaved.delete(key);toast('视图状态保存失败，请稍后重试');});
  }
}
async function restorePersistentViews() {
  try {
    const entries=await callTool('get_view_state');
    if(!Array.isArray(entries)) return;
    const pins=v=>Object.fromEntries(Object.entries(v&&typeof v==='object'?v:{}).filter(([k,x])=>['ctxTokensBody','ctxTimingBody','insTokensBody','insTimingBody'].includes(k)&&typeof x==='string'&&/^[\p{L} ()]+$/u.test(x)));
    const text=v=>typeof v==='string'?v.slice(0,1000):'';
    for(const entry of entries){
      if(!entry.key?.startsWith('session:') || !entry.value)continue;
      const v=entry.value;
      contextViews.set(entry.key.slice(8),{title:text(v.title),dna:['tree','dna','map'].includes(v.dna)?v.dna:'tree',trendMode:v.trendMode==='delta'?'delta':'total',snapshot:v.snapshot==='prev'?'prev':'live',catPick:Object.hasOwn(CAT_HEX,v.catPick)?v.catPick:null,browserQuery:text(v.browserQuery),trendKey:text(v.trendKey)||null,stripFocus:text(v.stripFocus)||null,agentPick:text(v.agentPick)||null,dnaLimit:Math.min(2000,Math.max(160,Number(v.dnaLimit)||160)),rowLimits:{},expanded:Array.isArray(v.expanded)?v.expanded.filter(k=>Object.hasOwn(CAT_HEX,k)):[],pins:pins(v.pins)});
    }
    const g=entries.find(e=>e.key==='global')?.value;
    if(g){
      state.tab=['usage','insights','context','agent'].includes(g.tab)?g.tab:'usage';
      state.sessionId=/^[a-zA-Z0-9_-]+$/.test(g.sessionId||'')?g.sessionId:null;state.sessionTitle=text(g.sessionTitle);
      state.range=['today','7d','30d'].includes(g.range)?g.range:'7d';
      for(const key of ['search','group','archive','day'])state[key]=text(g[key]);
      state.sortKey=['updated','tokens','context'].includes(g.sortKey)?g.sortKey:'updated';
      state.sessPage=Math.min(999,Math.max(1,Math.floor(Number(g.sessPage))||1));state.sessPageFor=state.sessionId;
      detailState.days=[1,7,30].includes(g.detailDays)?g.detailDays:7;detailState.tab=g.detailTab==='mcp'?'mcp':'model';healthState.days=[1,7,30].includes(g.healthDays)?g.healthDays:7;
      if(state.sessionId)restoreContextView(state.sessionId);
      document.getElementById('browserSearch').value=state.browserQuery;
      document.getElementById('sessSearch').value=state.search;document.getElementById('sessArchive').value=state.archive;syncSelect(document.getElementById('sessArchive'));
      for(const [id,attr,value] of [['rangeBar','r',state.range],['sessSort','k',state.sortKey],['detailDays','d',detailState.days],['detailTab','t',detailState.tab],['healthDays','d',healthState.days]])document.querySelectorAll('#'+id+' button').forEach(b=>b.classList.toggle('on',b.dataset[attr]===String(value)));
      pendingInsightPins=pins(g.pins);
    }
  } catch { toast('暂未恢复视图状态，本次使用默认视图'); }
  finally {persistentReady=true;}
}
let pendingInsightPins=null;
const originalRenderInsights=renderInsights;
renderInsights=function(){originalRenderInsights();if(pendingInsightPins){for(const id of ['insTokensBody','insTimingBody']){const w=document.getElementById(id)?.querySelector('.donutWrap');if(w&&pendingInsightPins[id]){w.dataset.pinned=pendingInsightPins[id];highlightDonut(w);}}pendingInsightPins=null;}};
// 视图状态防抖落盘：这些事件在连续输入时高频触发（搜索框每键一次），
// 签名必变 → 每键一次 save_view_state RPC + 原子文件写。延迟 600ms 合并，
// 并在页面隐藏/关闭时立即冲刷，避免丢最后一段输入。
let persistTimer=null;
function persistViewsSoon(){if(persistTimer)clearTimeout(persistTimer);persistTimer=setTimeout(()=>{persistTimer=null;persistViews();},600);}
function flushPersistViews(){if(persistTimer){clearTimeout(persistTimer);persistTimer=null;persistViews();}}
addEventListener('pagehide',flushPersistViews);
document.addEventListener('visibilitychange',()=>{if(document.hidden)flushPersistViews();});
for(const event of ['click','input','change','keydown'])document.addEventListener(event,persistViewsSoon);
