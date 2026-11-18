import fs from 'node:fs';
import { createHash } from 'node:crypto';

const MAX_LINE = 24 * 1024 * 1024;
const BLOCK = 256 * 1024;
const pages = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 24);

function metadata(line, start) {
  try {
    const entry = JSON.parse(line);
    if (!entry?.request?.body) return null;
    const usage = entry.response?.usage || {};
    return {
      input: Number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0),
      output: Number(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0),
      key: [start, line.length, digest(line)].join('.'),
      ts: Date.parse(entry.startedAt) || 0, model: entry.model?.modelId || entry.request.body.model || '',
      turn: entry.turnId || '', trace: entry.traceId || '', request: entry.requestId || '',
      attempt: entry.attempt ?? null
    };
  } catch { return null; }
}

// 游标指向上一页首行之前。按字节读取，UTF-8 仅在得到整行后解码。
export function snapshotPage(file, before) {
  if (!file) return { rows: [], before: null, skipped: 0 };
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (before != null && (!Number.isSafeInteger(before) || before < 0 || before > stat.size)) throw Error('历史日志已变化，请重新查看');
    const end = before ?? stat.size;
    const cacheKey = [file, stat.ino, stat.size, stat.mtimeMs, end].join('|');
    if (pages.has(cacheKey)) return pages.get(cacheKey);
    const rows = [];
    let pos = end, lineEnd = end, tail = [], tailSize = 0, skipped = 0, cursor = null;
    const finish = start => {
      if (tailSize && tailSize <= MAX_LINE) {
        const row = metadata(Buffer.concat(tail.reverse(), tailSize), start);
        if (row) rows.push(row);
      } else if (tailSize > MAX_LINE) skipped++;
      tail = []; tailSize = 0;
    };
    const append = part => {
      tailSize += part.length;
      if (tailSize <= MAX_LINE) tail.push(part);
      else tail = [];
    };
    scan: while (pos > 0 && end - pos < MAX_LINE + BLOCK) {
      const size = Math.min(BLOCK, pos);
      pos -= size;
      const buf = Buffer.alloc(size);
      if (fs.readSync(fd, buf, 0, size, pos) !== size) throw Error('日志读取期间发生变化');
      let right = size;
      while (right > 0) {
        const split = buf.lastIndexOf(10, right - 1);
        if (split < 0) { append(buf.subarray(0, right)); break; }
        append(buf.subarray(split + 1, right));
        finish(pos + split + 1);
        lineEnd = pos + split;
        if (rows.length >= 24 || end - lineEnd >= 2 * 1024 * 1024) { cursor = lineEnd || null; break scan; }
        right = split;
      }
    }
    if (cursor == null && pos === 0 && lineEnd > 0) finish(0);
    if (pos > 0 && cursor == null) {
      // 限制单次 I/O。下页从较早边界继续，截断的大记录不会被当作正文。
      cursor = lineEnd < end ? lineEnd : pos;
      if (lineEnd === end) skipped++;
    }
    const page = { rows, before: cursor, skipped };
    pages.set(cacheKey, page);
    if (pages.size > 96) pages.delete(pages.keys().next().value);
    return page;
  } finally { fs.closeSync(fd); }
}

export function readSnapshot(file, key) {
  if (!file || typeof key !== 'string' || !/^\d{1,16}\.\d{1,8}\.[0-9a-f]{24}$/.test(key)) throw Error('无效的快照标识');
  const [start, length, hash] = key.split('.');
  const offset = Number(start), size = Number(length);
  if (!Number.isSafeInteger(offset) || size <= 0 || size > MAX_LINE) throw Error('无效的快照位置');
  const fd = fs.openSync(file, 'r');
  try {
    if (offset + size > fs.fstatSync(fd).size) throw Error('历史快照已被清理');
    const buf = Buffer.alloc(size);
    if (fs.readSync(fd, buf, 0, size, offset) !== size || digest(buf) !== hash) throw Error('历史快照已变化，请重新选择');
    return JSON.parse(buf);
  } finally { fs.closeSync(fd); }
}

export function matchSnapshots(rows, step, peers = [step]) {
  const sameTurn = rows.filter(r => r.turn && r.turn === step.turn_id);
  const exact = sameTurn.filter(r => r.request && (r.request === step.id || r.request === step.logical_request_id && peers.filter(p => p.logical_request_id === r.request).length === 1));
  if (exact.length === 1) return { match: 'exact', rows: exact };
  const modelName = value => String(value || '').toLowerCase().split(/[/#]/).pop();
  const candidates = sameTurn.filter(r => !step.model_id || !r.model || modelName(step.model_id) === modelName(r.model));
  const corroborates = (r,p) => r.input > 0 && r.output > 0 && r.input === p.input_tokens && r.output === p.output_tokens &&
    modelName(p.model_id) === modelName(r.model) && Math.abs(r.ts - p.started_at) <= 1000;
  const supported = candidates.filter(r => corroborates(r,step) && peers.filter(p => corroborates(r,p)).length === 1);
  if (supported.length === 1) return { match:'correlated', rows:supported };
  candidates.sort((a, b) => Math.abs(a.ts - step.started_at) - Math.abs(b.ts - step.started_at));
  return { match: candidates.length ? 'candidate' : 'missing', rows: candidates };
}
