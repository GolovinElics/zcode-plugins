import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {snapshotPage,readSnapshot,matchSnapshots} from '../plugin/mcp/snapshots.mjs';

const entry = n => ({requestId:'io-'+n, turnId:'一轮', startedAt:new Date(1700000000000+n*2000).toISOString(),
  model:{modelId:'glm-5'},request:{body:{messages:[{role:'user',content:'正文 '+n}]}},response:{usage:{inputTokens:n+100,outputTokens:30}}});
test('多页 UTF-8 日志按字节定位，追加后原快照可读，轮换后拒绝错位内容', t=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'glm-snap-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'io.jsonl'),lines=Array.from({length:61},(_,n)=>JSON.stringify(entry(n)));
  fs.writeFileSync(file,lines.join('\n')+'\n');
  const first=snapshotPage(file),second=snapshotPage(file,first.before),third=snapshotPage(file,second.before);
  const all=[...first.rows,...second.rows,...third.rows];
  assert.equal(all.length,61);assert.equal(new Set(all.map(r=>r.key)).size,61);assert.equal(third.before,null);
  const chosen=second.rows[2];
  fs.appendFileSync(file,JSON.stringify(entry(61))+'\n');
  assert.equal(readSnapshot(file,chosen.key).requestId,chosen.request);
  fs.writeFileSync(file,'{}\n');
  assert.throws(()=>readSnapshot(file,chosen.key),/已被清理|已变化/);
  assert.throws(()=>readSnapshot(file,'9999999999999999.99999999.'+'a'.repeat(24)),/无效/);
});
test('直接标识、时间加用量、同轮候选、缺失和重试分别处理',()=>{
  const step={id:'step',turn_id:'turn',started_at:10000,model_id:'glm',input_tokens:197,output_tokens:43};
  const row={key:'key',turn:'turn',request:'different',model:'glm',input:197,output:43,ts:10012};
  assert.equal(matchSnapshots([{...row,request:'step'}],step).match,'exact');
  assert.equal(matchSnapshots([row],step).match,'correlated');
  assert.equal(matchSnapshots([row],step,[step,{...step,id:'retry'}]).match,'candidate');
  assert.equal(matchSnapshots([row,{...row,key:'another'}],step).match,'candidate');
  assert.equal(matchSnapshots([{...row,input:198}],step).match,'candidate');
  assert.equal(matchSnapshots([{...row,turn:'different-turn'}],step).match,'missing');
});
