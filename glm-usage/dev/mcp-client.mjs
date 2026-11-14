import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function mcpClient(env = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../plugin/mcp/server.mjs', import.meta.url))], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0;
  const pending = new Map();
  child.stderr.resume();
  createInterface({ input: child.stdout }).on('line', line => {
    const data = JSON.parse(line), entry = pending.get(data.id); if (!entry) return;
    pending.delete(data.id); clearTimeout(entry.timeout);
    if (data.error) entry.reject(new Error(data.error.message)); else entry.resolve(data.result);
  });
  child.on('exit', () => { for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error('MCP process exited')); } pending.clear(); });
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timeout = setTimeout(() => { pending.delete(key); reject(new Error('MCP request timed out')); }, 20000);
      pending.set(key, { resolve, reject, timeout });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
    });
  }
  return { request, async call(name, args = {}) {
    const result = await request('tools/call', { name, arguments: args });
    const json = JSON.parse(result.content[0].text); if (!json.ok) throw new Error(json.error); return json.data;
  }, close() { child.kill(); } };
}
