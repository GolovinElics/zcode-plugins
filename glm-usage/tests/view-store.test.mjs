import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readViews,writeView} from '../plugin/mcp/view-store.mjs';
import {mcpClient} from '../dev/mcp-client.mjs';
test('view persistence survives MCP restart and isolates session updates',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'glm-views-'));let client=mcpClient({GLM_USAGE_DATA_DIR:dir});
 try{
 await client.call('save_view_state',{key:'session:a',value:{browserQuery:'Bash',trendKey:'step-a'}});
 await client.call('save_view_state',{key:'session:b',value:{browserQuery:'Read'}});client.close();client=mcpClient({GLM_USAGE_DATA_DIR:dir});
 const entries=await client.call('get_view_state');assert.equal(entries.find(e=>e.key==='session:a').value.trendKey,'step-a');assert.equal(entries.find(e=>e.key==='session:b').value.trendKey,undefined);
 assert.equal(statSync(join(dir,'views.json')).mode&0o777,0o600);
 assert.throws(()=>writeView(dir,'../escape',{}));assert.throws(()=>writeView(dir,'global',{text:'x'.repeat(17000)}));
 for(let i=0;i<40;i++)writeView(dir,'session:s'+i,{});assert.equal(readViews(dir).length,32);
 writeFileSync(join(dir,'views.json'),'bad');assert.deepEqual(readViews(dir),[]);
 }finally{client.close();rmSync(dir,{recursive:true,force:true});}
});
