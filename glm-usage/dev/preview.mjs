import http from 'node:http';
import { readFileSync } from 'node:fs';
import { panelResource } from '../plugin/mcp/panel-resource.mjs';
import { fixtureCall } from './fixtures.mjs';
import { mcpClient } from './mcp-client.mjs';

const live = process.env.GLM_PREVIEW_LIVE === '1';
const client = live ? mcpClient() : null;
const readTools = new Set(['get_usage_json', 'get_config', 'get_usage', 'get_usage_detail', 'get_health', 'get_insights', 'get_sessions', 'list_sessions', 'get_session_context', 'get_context_browser', 'get_context_item', 'get_fleet', 'get_activity']);

const port = Number(process.env.GLM_PREVIEW_PORT || 8792);
const origin = `http://127.0.0.1:${port}`;
const audit = process.env.GLM_PREVIEW_AUDIT === '1' ? readFileSync(new URL('./preview-audit.js', import.meta.url), 'utf8') : 'function auditStart(){} function auditEnd(){}';
const shell = `<!doctype html><html><head><meta charset="utf-8"><title>GLM 插件交互预览</title><style>html,body{margin:0;height:100%;background:#141416}iframe{display:block;width:100%;height:calc(100% - 30px);border:0}header{height:30px;box-sizing:border-box;padding:5px 16px;font:12px system-ui;color:#aaa;background:#202023;display:flex;justify-content:space-between}a{color:#9cc4ff}</style></head><body><header><span>GLM 交互预览 · ${live ? 'ZCode 本地真实数据（只读）' : '演示数据'}</span><span>与 ZCode 相同的 MCP 面板资源</span></header><iframe id="panel" src="/panel" title="GLM 上下文洞察"></iframe><script>
const frame=document.getElementById('panel');
${audit}
addEventListener('message',async e=>{if(e.source!==frame.contentWindow||e.origin!==location.origin)return;const d=e.data;if(d?.jsonrpc!=='2.0'||d.id==null)return;
try{let result;if(d.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'local-preview'},hostCapabilities:{serverTools:{}}};
else if(d.method==='tools/call'){auditStart(d.id,d.params);const r=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d.params)});result=await r.json();if(!r.ok)throw Error(result.error);}
else return;frame.contentWindow.postMessage({jsonrpc:'2.0',id:d.id,result},location.origin);auditEnd(d.id);}catch(e){frame.contentWindow.postMessage({jsonrpc:'2.0',id:d.id,error:{message:e.message}},location.origin);}});
</script></body></html>`;
http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403).end(); return; }
  try {
    if (req.method === 'GET' && req.url === '/favicon.ico') { res.writeHead(204).end(); }
    else if (req.method === 'GET' && req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(shell); }
    else if (req.method === 'GET' && req.url === '/panel') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await panelResource()); }
    else if (req.method === 'POST' && req.url === '/rpc' && req.headers.origin === origin && req.headers['content-type'] === 'application/json') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16384) throw Error('请求过大'); }
      const { name, arguments: args } = JSON.parse(body);
      if (live && !readTools.has(name)) throw Error('真实数据预览只允许读取');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(live ? await client.request('tools/call', { name, arguments: args || {} }) : fixtureCall(name, args)));
    } else res.writeHead(404).end();
  } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message })); }
}).listen(port, '127.0.0.1', () => console.log(`GLM preview: ${origin}`));

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { client?.close(); process.exit(0); });
