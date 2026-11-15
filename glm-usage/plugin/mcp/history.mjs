// 用量历史采样（~/.glm-usage/history.json，48h 窗口）。
// 独立模块（对齐 view-store.mjs 先例）：server.mjs 传路径与采样间隔，便于单测。
import fs from "node:fs";
import path from "node:path";

const HISTORY_WINDOW_SEC = 48 * 3600;

// 读缓存：文件 mtime+size 指纹未变时跳过磁盘读与 JSON.parse。
// 一次配额轮询会经 appendHistory/computeRates/historySeries 读同一文件 3 次，
// 48h 窗口封顶后约 600KB——避免每周期重复 parse 3 遍。
// 命中时返回防御性浅拷贝（元素对象与 values 均 copy），调用方可安全 mutate。
let _readMemo = null; // { file, mtimeMs, size, data }
function cloneSamples(data) {
  return data.map((x) => ({ t: x.t, values: { ...(x.values || {}) } }));
}

export function readHistory(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  if (_readMemo && _readMemo.file === file && _readMemo.mtimeMs === st.mtimeMs && _readMemo.size === st.size) {
    return cloneSamples(_readMemo.data);
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  if (!Array.isArray(data)) return [];
  _readMemo = { file, mtimeMs: st.mtimeMs, size: st.size, data };
  return cloneSamples(data);
}

// 点列步长封顶：超出 cap 时等距取样（首尾必含），时间范围保持全覆盖。
// 面板 sparkline 仅消费 90 个点（downsample(pts, 90)），服务端全量回传历史点
// 会随 48h 窗口无限膨胀（60s 采样 × 5 个额度位 → 1.4 万点 / 数百 KB 每次轮询）。
export function strideCap(pts, cap = 180) {
  if (!Array.isArray(pts) || pts.length <= cap) return pts;
  const out = [];
  const step = (pts.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

// 追加一个采样点。未跨采样间隔时合并进末条样本；配额值没变就不写盘——
// 面板轮询可低至 3s，避免值稳定期每个周期都重写文件。
export function appendHistory(file, values, { sampleSeconds = 60, now = Date.now() } = {}) {
  const t = Math.floor(now / 1000);
  const minGap = Math.max(10, Number(sampleSeconds) || 60);
  const h = readHistory(file);
  const last = h[h.length - 1];
  let changed = true;
  if (last && t - last.t < minGap) {
    changed = JSON.stringify(last.values) !== JSON.stringify(values);
    last.values = values;
  } else h.push({ t, values });
  if (!changed) return false;
  const pruned = h.filter((x) => x.t >= t - HISTORY_WINDOW_SEC);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pruned), { mode: 0o600 });
  } catch { /* 忽略 */ }
  return true;
}
