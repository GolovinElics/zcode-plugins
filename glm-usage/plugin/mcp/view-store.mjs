import fs from 'node:fs';
import path from 'node:path';
export function readViews(dir) {
  try { const data=JSON.parse(fs.readFileSync(path.join(dir,'views.json'),'utf8')); return data.version===1 && Array.isArray(data.entries) ? data.entries : []; } catch { return []; }
}
export function writeView(dir,key,value) {
  if (typeof key!=='string' || !/^(global|session:[a-zA-Z0-9_-]{1,160})$/.test(key)) throw Error('非法视图标识');
  if (!value || typeof value!=='object' || Array.isArray(value) || JSON.stringify(value).length>16000) throw Error('视图状态格式或大小无效');
  const entries=readViews(dir).filter(e=>e.key!==key);
  entries.push({key,value});
  const global=entries.find(e=>e.key==='global');
  const sessions=entries.filter(e=>e.key!=='global').slice(-32);
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'views.json'),tmp=file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({version:1,entries:[...(global?[global]:[]),...sessions]}),{mode:0o600});
  fs.renameSync(tmp,file);
}
