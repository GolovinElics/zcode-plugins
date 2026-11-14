#!/usr/bin/env node
/**
 * GLM Coding Plan 用量看板 v2.2 — 本地服务
 *
 * 数据来源（逆向自 ZCode 桌面版，非公开 API）：
 *   Coding Plan： GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *                 Authorization: <API Key（用户配置，优先）或 ZCode 内嵌浏览器的网页登录令牌>
 *   免费套餐：   GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=…&device_mid=…
 *                 Authorization: Bearer <zcodejwttoken>（~/.zcode/v2/credentials.json 就地解密）
 *
 * 仅监听 127.0.0.1；令牌只在内存中用于向上游请求，不会外泄。
 * 配置（config.json）：coding_plan_key / refresh_seconds / sample_seconds
 * 用法：node server.js [端口]   （默认 8791）
 */
"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

const HOME = os.homedir();
const CRED_FILE = path.join(HOME, ".zcode/v2/credentials.json");
const TELEMETRY_FILE = path.join(HOME, ".zcode/v2/telemetry-state.json");
const EMBEDDED_COOKIE_DB = path.join(HOME, "Library/Application Support/ZCode/session/Partitions/zcode-embedded-browser/Cookies");
const CONFIG_FILE = path.join(__dirname, "config.json");   // 用户配置（权限 600）
const HISTORY_FILE = path.join(__dirname, "history.json"); // 用量历史采样（48 小时）
const PORT = Number(process.argv[2] || process.env.PORT || 8791);
const APP_VERSION = "3.18.2";

// 出网白名单：只允许这两个公网主机（http/https 且拒绝内网/环回地址）
const ALLOWED_HOSTS = new Set(["zcode.z.ai", "open.bigmodel.cn"]);

const DEFAULTS = { refresh_seconds: 30, sample_seconds: 60 };

/* ---------- 配置 ---------- */

function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }; } catch { return { ...DEFAULTS }; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}
function configuredApiKey() {
  return String(process.env.GLM_CODING_PLAN_API_KEY || loadConfig().coding_plan_key || "").trim();
}

/* ---------- 凭据解密（与 zcode.cjs 的 enc:v1 方案一致） ---------- */

function legacyKeyCandidates() {
  const fallback = `zcode-credential-fallback:${os.platform()}:${HOME}:${os.userInfo().username}`;
  const secret = process.env.ZCODE_CREDENTIAL_SECRET;
  return [...new Set([secret || fallback, (secret || "").trim() || fallback, fallback])]
    .map((s) => crypto.createHash("sha256").update(s).digest());
}

function decryptV1(value) {
  if (!value || !value.startsWith("enc:v1:")) return value;
  const [iv, tag, ct] = value.slice("enc:v1:".length).split(".").map((x) => Buffer.from(x, "base64url"));
  for (const key of legacyKeyCandidates()) {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    } catch { /* 尝试下一个候选密钥 */ }
  }
  throw new Error("无法解密 credentials.json（enc:v1）");
}

function loadToken() {
  const cred = JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  const token = decryptV1(cred["zcodejwttoken"]);
  if (!token || token.startsWith("enc:")) throw new Error("zcodejwttoken 缺失或无法解密");
  return token;
}

function loadDeviceMid() {
  return JSON.parse(fs.readFileSync(TELEMETRY_FILE, "utf8")).deviceMid;
}

// 从 ZCode 内嵌浏览器的 Cookie 库读取 bigmodel.cn 登录令牌（该库中此值为明文）
function loadCodingPlanToken() {
  const { execFileSync } = require("node:child_process");
  const tmp = path.join(os.tmpdir(), `zcode-cookies-${process.pid}.db`);
  fs.copyFileSync(EMBEDDED_COOKIE_DB, tmp);
  try {
    const out = execFileSync("/usr/bin/sqlite3", [tmp,
      "select value from cookies where name='bigmodel_token_production' and host_key like '%bigmodel.cn' limit 1;",
    ], { encoding: "utf8", timeout: 5000 }).trim();
    if (!out) throw new Error("未找到网页登录令牌");
    return out;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 忽略清理失败 */ }
  }
}

/* ---------- 上游请求 ---------- */

function assertAllowedUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("仅允许 http/https");
  const h = u.hostname.toLowerCase();
  const blocked = h === "localhost" || h === "0.0.0.0" || h.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|::1|fc|fd|fe80)/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === "";
  if (blocked || !ALLOWED_HOSTS.has(h)) throw new Error(`主机不在白名单: ${h}`);
}

function httpsGetJson(url, headers) {
  assertAllowedUrl(url);
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", timeout: 15000, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error("上游响应不是合法 JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("上游请求超时")));
    req.on("error", reject);
    req.end();
  });
}

const CREDIT_WINDOW_LABELS = { "3x5": "5 小时窗口", "6x1": "每周额度" }; // unit=3(小时)×5 / unit=6(周)×1

async function fetchCodingPlan() {
  const apiKey = configuredApiKey(); // Key 优先，回退到内嵌浏览器网页登录态
  const token = apiKey || loadCodingPlanToken();
  const noCredHint = apiKey
    ? "API Key 无效或已失效（官网控制台可重新生成），请在设置里更新"
    : "未配置 API Key —— 在设置里填入 bigmodel.cn 的 API Key，或在 ZCode 内嵌浏览器登录 bigmodel.cn";
  const json = await httpsGetJson("https://open.bigmodel.cn/api/monitor/usage/quota/limit", { Authorization: token });
  if (!json.success) {
    const authRejected = json.code === 1001 || /身份验证|鉴权|令牌/.test(json.msg || "");
    throw new Error(authRejected ? noCredHint : json.msg || `接口返回 code=${json.code}`);
  }
  const limits = (json.data?.limits || []).map((l, i) => ({
    id: "cp:" + i,
    label: CREDIT_WINDOW_LABELS[`${l.unit}x${l.number}`] || `额度窗口(${l.unit}×${l.number})`,
    total: l.usage, used: l.currentValue, remaining: l.remaining,
    percent: typeof l.percentage === "number" ? l.percentage
      : (l.usage ? Math.round((l.currentValue / l.usage) * 1000) / 10 : 0),
    reset_at: l.nextResetTime ? Math.floor(l.nextResetTime / 1000) : null,
  }));
  return { level: json.data?.level || "unknown", limits };
}

async function fetchBalance() {
  const deviceMid = loadDeviceMid();
  const url = `https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}&device_mid=${encodeURIComponent(deviceMid)}`;
  const json = await httpsGetJson(url, { Authorization: "Bearer " + loadToken() });
  if (json.code !== 0) throw new Error(`接口返回 code=${json.code} ${json.msg || ""}`);
  return json.data || {};
}

/* ---------- 官方使用详情（token-usage/usage-detail，模型+工具） ---------- */

function fmtLocalDayHour(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let detailCache = { at: 0, days: 0, data: null }; // 5 分钟服务端缓存，避免高频打官方接口
async function fetchUsageDetail(days = 7) {
  days = [1, 7, 30].includes(days) ? days : 7;
  if (detailCache.data && detailCache.days === days && Date.now() - detailCache.at < 5 * 60 * 1000) {
    return detailCache.data;
  }
  const apiKey = configuredApiKey();
  const token = apiKey || loadCodingPlanToken();
  const end = new Date();
  const start = new Date(Date.now() - days * 86400 * 1000);
  const base = { startTime: fmtLocalDayHour(start), endTime: fmtLocalDayHour(end), type: 1 };

  async function one(usageType) {
    const url = "https://open.bigmodel.cn/api/monitor/token-usage/usage-detail?" +
      new URLSearchParams({ ...base, usageType }).toString();
    const json = await httpsGetJson(url, { Authorization: token });
    if (!json.success) throw new Error(json.msg || `usage-detail(${usageType}) code=${json.code}`);
    const d = json.data || {};
    const block = d.modelUsage || d.mcpUsage || null;
    if (!block) return null;
    // 按小时桶汇总各序列（uncached/cached/output 等）
    const n = (block.xTime || []).length;
    const totals = new Array(n).fill(0);
    for (const m of block.modelDataList || []) {
      for (const [k, arr] of Object.entries(m)) {
        if (k.endsWith("Usage") && Array.isArray(arr)) {
          for (let i = 0; i < n && i < arr.length; i++) totals[i] += arr[i] || 0;
        }
      }
    }
    const items = (block.modelSummaryList || (block.toolSummaryList || [])).map((x) => ({
      name: x.modelName || x.toolName || x.modelCode || x.toolCode || "?",
      total: x.totalTokens ?? x.totalCalls ?? 0,
    })).sort((a, b) => b.total - a.total);
    return {
      granularity: d.granularity || "HOUR",
      xTime: block.xTime || [],
      periodTypes: block.periodTypes || [],
      totals,
      items,
      summary: {
        total: Number(d.summary?.totalTokens?.value || block.totalUsage?.totalTokens || 0),
        daily: Number(d.summary?.averageDailyTokens?.value || 0),
        cacheHit: Number(d.summary?.cacheHitRate?.value || 0),
        peakRate: 1 - Number(d.summary?.offPeakUsageRate?.value || 0),
      },
    };
  }
  const [model, mcp] = await Promise.allSettled([one("MODEL"), one("MCP")]);
  const data = {
    model: model.status === "fulfilled" ? model.value : { error: model.reason?.message },
    mcp: mcp.status === "fulfilled" ? mcp.value : { error: mcp.reason?.message },
  };
  detailCache = { at: Date.now(), days, data };
  return data;
}

/* ---------- 历史采样与速率 ---------- */

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { return []; }
}

function appendHistory(values) { // values: {id: used}
  const t = Math.floor(Date.now() / 1000);
  const minGap = Math.max(10, Number(loadConfig().sample_seconds) || 60);
  const h = readHistory();
  const last = h[h.length - 1];
  if (last && t - last.t < minGap) last.values = values; // 间隔内的样本覆盖
  else h.push({ t, values });
  const cutoff = t - 48 * 3600;
  const pruned = h.filter((x) => x.t >= cutoff);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(pruned), { mode: 0o600 }); } catch { /* 忽略 */ }
}

// 依据历史样本计算燃烧速率（单位/小时）：取 5 分钟 ~ 6 小时前最久的样本作基线
function computeRates(current) { // current: Map<id, used>
  const h = readHistory();
  const now = Math.floor(Date.now() / 1000);
  const out = {};
  for (const [id, used] of current) {
    let base = null;
    for (let i = h.length - 1; i >= 0; i--) {
      const v = h[i].values?.[id];
      const dt = now - h[i].t;
      if (typeof v !== "number") continue;
      if (dt >= 300 && dt <= 6 * 3600) base = { t: h[i].t, v };
      if (dt > 6 * 3600) break;
    }
    if (base) {
      const delta = used - base.v;
      if (delta >= 0) {
        const rate = delta / ((now - base.t) / 3600);
        if (rate > 0) out[id] = { per_hour: Math.round(rate * 10) / 10, span_min: Math.round((now - base.t) / 60) };
      }
    }
  }
  return out;
}

function historySeries() { // 供前端画走势：{id: [[t, used], ...]}
  const h = readHistory();
  const out = {};
  for (const s of h) for (const [id, v] of Object.entries(s.values || {})) {
    (out[id] = out[id] || []).push([s.t, v]);
  }
  return out;
}

/* ---------- 前端页面（设计语言参考 CPAMC：纸感暖色 / 透明分层 / 等宽数字 / 语义色计量条） ---------- */

const HTML = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GLM 套餐用量看板</title>
<script>
/* 首帧前应用主题，避免闪变（?theme= 参数 > localStorage > 系统） */
(function(){ try {
  var q = new URLSearchParams(location.search).get("theme");
  var t = localStorage.getItem("glm-theme");
  if (q === "light" || q === "dark") { t = q; localStorage.setItem("glm-theme", t); }
  if (!t) t = (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
} catch(e){} })();
</script>
<style>
  /* ---------- 主题：纸感暖色（亮）/ 暖炭（暗），语义色计量 ---------- */
  :root {
    --mono:ui-monospace,"SF Mono","Cascadia Mono","JetBrains Mono",Menlo,Consolas,monospace;
    --ease:cubic-bezier(0.23,1,0.32,1);
    --radius-card:14px; --radius-inner:10px; --radius-full:9999px;
  }
  [data-theme="light"] {
    --bg:#faf9f5; --bg2:#f0eee8; --card:color-mix(in srgb,#f0eee8 82%,transparent); --card2:#e9e6df;
    --bd:#e3e1db; --bd2:#d5d2cb;
    --fg:#2d2a26; --sub:#6d6760; --dim:#948e87; --faint:#b5afa8;
    --prim:#8b8680; --prim2:#726d67;
    --ok:#10b981; --mid:#e0aa14; --bad:#c65746;
    --glow:none;
  }
  [data-theme="dark"] {
    --bg:#161513; --bg2:#1b1a17; --card:color-mix(in srgb,#f0eee8 4.5%,transparent); --card2:color-mix(in srgb,#f0eee8 8%,transparent);
    --bd:color-mix(in srgb,#e3e1db 10%,transparent); --bd2:color-mix(in srgb,#e3e1db 20%,transparent);
    --fg:#ece9e3; --sub:#b3ada5; --dim:#8a847c; --faint:#605b54;
    --prim:#b3ada5; --prim2:#d8d3cb;
    --ok:#3ddc97; --mid:#e6b422; --bad:#e5735f;
    --glow:0 10px 34px rgba(0,0,0,.35);
  }
  * { box-sizing:border-box; margin:0; }
  html { background:var(--bg); }
  body { color:var(--fg); font:13.5px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; padding:30px 22px 70px; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:920px; margin:0 auto; }

  /* ---------- 顶栏 ---------- */
  .top { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:4px; }
  .top h1 { font-size:18px; font-weight:650; letter-spacing:.2px; display:flex; align-items:center; gap:9px; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--ok); box-shadow:0 0 8px var(--ok); flex:none; animation:pulse 2.4s infinite; }
  .dot.bad { background:var(--bad); box-shadow:0 0 8px var(--bad); animation:none; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .chip { font-size:11px; color:var(--sub); border:1px solid var(--bd); background:var(--card); border-radius:var(--radius-full); padding:2px 10px; }
  .chip b { color:var(--fg); font-weight:600; }
  .topright { margin-left:auto; display:flex; align-items:center; gap:8px; font-size:12px; color:var(--sub); }
  .countdown { font-family:var(--mono); font-variant-numeric:tabular-nums; min-width:74px; text-align:right; color:var(--dim); font-size:11.5px; }
  button { background:var(--card2); color:var(--sub); border:1px solid var(--bd); border-radius:8px; padding:4px 13px; cursor:pointer; font-size:12px; font-weight:500; transition:all 150ms ease; }
  button:hover { border-color:var(--bd2); color:var(--fg); }
  button.icon { padding:4px 9px; font-size:13px; line-height:1.4; }
  select { background:var(--bg2); border:1px solid var(--bd); color:var(--fg); border-radius:8px; padding:4px 8px; font-size:12px; }
  .subline { font-size:11.5px; color:var(--faint); margin-bottom:20px; }
  .subline a { color:var(--dim); text-decoration:none; border-bottom:1px dashed var(--faint); }
  .subline a:hover { color:var(--sub); border-color:var(--dim); }

  /* ---------- 设置 ---------- */
  details.settings { margin:-6px 0 20px; }
  details.settings summary { list-style:none; cursor:pointer; color:var(--faint); font-size:11.5px; width:fit-content; transition:color 150ms; }
  details.settings summary::-webkit-details-marker { display:none; }
  details.settings[open] summary { color:var(--dim); margin-bottom:7px; }
  .setbox { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:12px; color:var(--sub); background:var(--card); border:1px solid var(--bd); border-radius:var(--radius-inner); padding:11px 14px; }
  .setbox .grp { display:flex; align-items:center; gap:6px; }
  .setbox input { background:var(--bg); border:1px solid var(--bd); color:var(--fg); border-radius:8px; padding:5px 10px; width:290px; font:12px var(--mono); }
  #keystatus { color:var(--dim); }

  /* ---------- 级联入场（CPAMC cardEnter） ---------- */
  .enter { animation:card-in .22s var(--ease) both; animation-delay:var(--delay,0ms); }
  @keyframes card-in { from { opacity:0; transform:translateY(5px); } }
  @media (prefers-reduced-motion: reduce) { .enter { animation:none; } }

  /* ---------- 卡片通用（statTile 配方：14px 圆角 / 1px 边框 / 透感纸面） ---------- */
  .card { position:relative; background:var(--card); border:1px solid var(--bd); border-radius:var(--radius-card); padding:16px; transition:border-color 160ms var(--ease), transform 160ms var(--ease); }
  @media (hover:hover) and (pointer:fine) { .card:hover { border-color:var(--bd2); } }

  /* ---------- Hero：Coding Plan ---------- */
  .hero { padding:18px 18px 16px; margin-bottom:14px; box-shadow:var(--glow); }
  .heroHead { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  .providerPill { display:inline-flex; align-items:center; gap:7px; padding:4px 12px; border-radius:12px; background:color-mix(in srgb,var(--fg) 6%,transparent); border:1px solid var(--bd); font-size:12.5px; font-weight:650; }
  .providerPill i { width:8px; height:8px; border-radius:3px; background:linear-gradient(135deg,var(--mid),var(--prim)); flex:none; }
  .levelPill { font-size:10.5px; font-weight:700; letter-spacing:1.2px; padding:2px 9px; border-radius:var(--radius-full); color:var(--prim2); background:color-mix(in srgb,var(--fg) 7%,transparent); border:1px solid var(--bd); }
  .heroStatus { font-size:11.5px; color:var(--dim); margin-left:auto; white-space:nowrap; }
  .quotaWrap { display:flex; flex-direction:column; gap:10px; }

  /* 配额区（CPAMC quotaSection：10px 圆角 / 70% 边 / 55% 底） */
  .quotaSection { display:flex; flex-direction:column; gap:7px; padding:11px 12px 10px; border-radius:var(--radius-inner); border:1px solid color-mix(in srgb,var(--bd) 70%,transparent); background:color-mix(in srgb,var(--bg2) 55%,transparent); }
  .quotaHead { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
  .qLabel { font-size:12px; font-weight:650; color:var(--sub); }
  .qMeta { display:inline-flex; align-items:baseline; gap:6px; font-family:var(--mono); font-size:11.5px; font-variant-numeric:tabular-nums; flex-shrink:0; }
  .qPct { font-weight:650; color:var(--fg); font-size:13px; }
  .qReset { color:var(--dim); font-weight:400; }
  .qReset::before { content:"·"; margin:0 3px; color:var(--faint); }
  .qReset.soon { color:var(--mid); font-weight:600; }

  /* 计量条（Meter 风 6px 轨道 / 语义色） */
  .meter { height:6px; border-radius:var(--radius-full); background:color-mix(in srgb,var(--fg) 8%,transparent); overflow:hidden; }
  .meter > i { display:block; height:100%; border-radius:var(--radius-full); transition:width 360ms var(--ease); }
  .lv-ok { background:var(--ok); } .lv-mid { background:var(--mid); } .lv-bad { background:var(--bad); }

  .qLine { font-family:var(--mono); font-size:11.5px; font-variant-numeric:tabular-nums; color:var(--dim); display:flex; flex-wrap:wrap; gap:2px 0; }
  .qLine b { color:var(--sub); font-weight:600; }
  .qLine .sep { margin:0 6px; color:var(--faint); }
  .qLine .safe { color:var(--ok); }
  .qLine .danger { color:var(--bad); font-weight:600; }

  .spark { margin-top:2px; }
  .spark svg { width:100%; height:26px; display:block; }
  .sparkCap { display:flex; justify-content:space-between; font-size:10px; color:var(--faint); margin-top:3px; font-family:inherit; }

  /* ---------- 免费套餐卡片 ---------- */
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(295px,1fr)); gap:12px; }

  /* 使用详情（官方数据） */
  .detail { margin-top:14px; }
  .detailHead { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  .detailHead h3 { font-size:13.5px; font-weight:650; margin-right:auto; }
  .seg { display:inline-flex; border:1px solid var(--bd); border-radius:9px; overflow:hidden; }
  .seg button { border:0; border-radius:0; padding:3px 12px; background:transparent; color:var(--dim); }
  .seg button.on { background:var(--card2); color:var(--fg); font-weight:600; }
  .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:8px; margin-bottom:12px; }
  .metric { background:color-mix(in srgb,var(--bg2) 55%,transparent); border:1px solid color-mix(in srgb,var(--bd) 70%,transparent); border-radius:var(--radius-inner); padding:8px 12px; }
  .metric .mv { font:650 15px var(--mono); font-variant-numeric:tabular-nums; }
  .metric .mk { font-size:10.5px; color:var(--dim); margin-top:1px; }
  .bars { display:flex; align-items:flex-end; gap:1px; height:88px; padding:2px 0; }
  .bars > i { flex:1; min-width:1px; border-radius:1px 1px 0 0; background:var(--acc); opacity:.75; transition:opacity .15s; }
  .bars > i.peak { background:var(--mid); }
  .bars > i:hover { opacity:1; }
  .barAxis { display:flex; justify-content:space-between; font-size:9.5px; color:var(--faint); margin-top:4px; font-family:var(--mono); }
  .legend { display:flex; gap:12px; font-size:10.5px; color:var(--dim); margin-top:6px; }
  .legend i { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:4px; vertical-align:-1px; }
  .items { margin-top:12px; display:flex; flex-direction:column; gap:6px; }
  .item { display:flex; align-items:center; gap:10px; font-size:12px; }
  .item .in { width:110px; color:var(--sub); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item .ib { flex:1; height:5px; border-radius:99px; background:color-mix(in srgb,var(--fg) 7%,transparent); overflow:hidden; }
  .item .ib > i { display:block; height:100%; border-radius:99px; background:var(--acc); }
  .item .iv { width:90px; text-align:right; font:500 11.5px var(--mono); color:var(--sub); font-variant-numeric:tabular-nums; }
  .detail .err2 { color:var(--bad); font-size:12px; padding:8px 0; }
  .plan h3 { font-size:13px; font-weight:650; display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-bottom:1px; }
  .plan .life { font-size:11px; color:var(--faint); margin-bottom:10px; }
  .badge { font-size:10.5px; padding:1px 8px; border-radius:var(--radius-full); border:1px solid var(--bd); color:var(--dim); font-weight:500; }
  .badge.active { color:var(--ok); border-color:color-mix(in srgb,var(--ok) 40%,transparent); }
  .badge.expired { color:var(--bad); border-color:color-mix(in srgb,var(--bad) 40%,transparent); }

  .footer { margin-top:24px; text-align:center; font-size:11px; color:var(--faint); }
  .err { background:color-mix(in srgb,var(--bad) 9%,transparent); border:1px solid color-mix(in srgb,var(--bad) 35%,transparent); color:var(--bad); border-radius:var(--radius-inner); padding:11px 15px; margin-bottom:13px; display:none; font-size:12.5px; }
  .empty { color:var(--dim); text-align:center; padding:36px 0; grid-column:1/-1; }
</style></head><body>
<div class="wrap">
  <div class="top">
    <h1><span class="dot" id="dot"></span>GLM 套餐用量看板</h1>
    <span class="chip">数据源 <b>本地实时</b></span>
    <div class="topright">
      <span class="countdown" id="countdown">—</span>
      <button onclick="load()">刷新</button>
      <button class="icon" id="themebtn" onclick="toggleTheme()" title="切换亮/暗主题">🌙</button>
    </div>
  </div>
  <div class="subline" id="subline">接口定时拉取 · 燃烧速率按最近 5 分钟～6 小时样本估算 · <a href="https://bigmodel.cn/coding-plan/personal/usage" target="_blank">官方用量页（含用量明细/健康度/额度重置/加油包）↗</a></div>

  <details class="settings">
    <summary>⚙ 设置（API Key · 刷新频率）</summary>
    <div class="setbox">
      <span class="grp">Key <input id="keyinput" type="password" placeholder="粘贴 bigmodel.cn 控制台的 API Key"></span>
      <button onclick="saveKey(0)">保存</button><button onclick="saveKey(1)">清除</button>
      <span class="grp">刷新 <select id="refreshsel" onchange="saveRefresh(this.value)">
        <option value="10">10 秒</option><option value="30">30 秒</option><option value="60">1 分钟</option>
        <option value="120">2 分钟</option><option value="300">5 分钟</option>
      </select></span>
      <span id="keystatus">检查中…</span>
    </div>
  </details>

  <div class="err" id="err"></div>
  <div id="hero"></div>
  <div class="cards" id="plans"></div>

  <section class="card detail enter" id="detailCard" style="--delay:180ms">
    <div class="detailHead">
      <h3>使用详情</h3>
      <div class="seg" id="detailDays">
        <button data-d="1">今天</button><button data-d="7" class="on">7 天</button><button data-d="30">30 天</button>
      </div>
      <div class="seg" id="detailTab">
        <button data-t="model" class="on">模型</button><button data-t="mcp">工具</button>
      </div>
    </div>
    <div id="detailBody"><div class="empty" style="padding:18px 0">加载中…</div></div>
  </section>
  <div class="footer">GLM Usage Dashboard · 本地服务 127.0.0.1:8791 · 历史采样保留 48 小时 · /glm-usage 随时唤起</div>
</div>

<script>
var REFRESH = 30, tick = REFRESH, timer = null;
var fmt = function(n){ return n == null ? "—" : n.toLocaleString("zh-CN"); };
var fmtK = function(n){
  if (n == null) return "—";
  if (n >= 1e8) return (n/1e8).toFixed(2) + " 亿";
  if (n >= 1e4) return (n/1e4).toFixed(1) + " 万";
  return fmt(n);
};
var until = function(sec, short){
  if (!sec) return "长期";
  var d = sec - Math.floor(Date.now()/1000);
  if (d <= 0) return "已到期";
  var dd = Math.floor(d/86400), hh = Math.floor(d%86400/3600), mm = Math.floor(d%3600/60), ss = d%60;
  if (short) return dd ? dd + "天" + hh + "时" : (hh ? hh + "时" + mm + "分" : mm + "分" + (ss<10?"0":"") + ss + "秒");
  return (dd ? dd + " 天 " : "") + hh + " 小时 " + mm + " 分";
};
var esc = function(s){ return String(s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); };
var lvClass = function(p){ return p >= 90 ? "lv-bad" : p >= 70 ? "lv-mid" : "lv-ok"; };
var lvColor = function(p){ return p >= 90 ? "var(--bad)" : p >= 70 ? "var(--mid)" : "var(--ok)"; };

function applyTheme(t){
  document.documentElement.setAttribute("data-theme", t);
  document.getElementById("themebtn").textContent = t === "dark" ? "🌙" : "☀️";
  try { localStorage.setItem("glm-theme", t); } catch(e){}
}
function toggleTheme(){
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
}

/* ---- 平滑走势：降采样 + 单调三次插值（Fritsch–Carlson，同 d3 curveMonotoneX：不过冲、不回折、无交叉） ---- */
function downsample(pts, n) {
  if (!pts || pts.length <= n) return pts || [];
  var out = [], step = (pts.length - 1) / (n - 1);
  for (var i = 0; i < n; i++) out.push(pts[Math.round(i * step)]);
  return out;
}
function monotonePath(xy) {
  if (xy.length < 3) return "M" + xy.map(function(q){ return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" L");
  var n = xy.length, m = new Array(n), d = new Array(n - 1), i;
  for (i = 0; i < n - 1; i++) d[i] = (xy[i + 1][1] - xy[i][1]) / (xy[i + 1][0] - xy[i][0]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
  for (i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    var a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { var t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  var out = "M" + xy[0][0].toFixed(1) + "," + xy[0][1].toFixed(1);
  for (i = 0; i < n - 1; i++) {
    var h = xy[i + 1][0] - xy[i][0];
    out += " C" + (xy[i][0] + h / 3).toFixed(1) + "," + (xy[i][1] + m[i] * h / 3).toFixed(1)
         + " " + (xy[i + 1][0] - h / 3).toFixed(1) + "," + (xy[i + 1][1] - m[i + 1] * h / 3).toFixed(1)
         + " " + xy[i + 1][0].toFixed(1) + "," + xy[i + 1][1].toFixed(1);
  }
  return out;
}
function sparkline(pts, color) {
  if (!pts || pts.length < 2) return '<div class="sparkCap"><span>走势将随采样积累显示（本机定时记录已用量）</span></div>';
  var W = 224, H = 26, pad = 3, pp = downsample(pts, 90);
  var vs = pp.map(function(p){ return p[1]; });
  var t0 = pp[0][0], t1 = pp[pp.length - 1][0], v0 = Math.min.apply(null, vs), v1 = Math.max.apply(null, vs);
  if (v1 === v0) v1 = v0 + 1;
  if (t1 === t0) t1 = t0 + 1;
  var xy = pp.map(function(p){ return [pad + (p[0] - t0) / (t1 - t0) * (W - pad * 2), H - pad - (p[1] - v0) / (v1 - v0) * (H - pad * 2)]; });
  var line = monotonePath(xy);
  var area = line + " L" + (W - pad) + "," + (H - pad) + " L" + pad + "," + (H - pad) + " Z";
  sparkline._n = (sparkline._n || 0) + 1;
  var gid = "sg" + sparkline._n;
  return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" style="width:100%;height:26px;display:block;overflow:hidden">'
    + '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="' + color + '" stop-opacity=".22"/><stop offset="1" stop-color="' + color + '" stop-opacity="0"/>'
    + '</linearGradient></defs>'
    + '<path d="' + area + '" fill="url(#' + gid + ')"/>'
    + '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>'
    + '<div class="sparkCap"><span>近 48 小时已用 · 本机采样</span><span>' + pp.length + ' 点</span></div>';
}

function etaParts(b, rate){
  if (!rate) return '速率 <b>采样中…</b><span class="sep">·</span>预计触顶 —';
  var eta = b.total > 0 ? (b.total - b.used) / rate.per_hour : 0;
  var toReset = b.reset_at ? (b.reset_at - Math.floor(Date.now()/1000)) : Infinity;
  var h = Math.floor(eta), m = Math.round((eta - h) * 60);
  var txt = eta >= 24 ? Math.floor(eta/24) + " 天后" : (h + " 时 " + m + " 分后");
  var danger = eta * 3600 < toReset;
  return '速率 <b>' + fmt(Math.round(rate.per_hour)) + "/时</b>（" + rate.span_min + " 分钟样本）"
    + '<span class="sep">·</span>预计触顶 <b class="' + (danger ? "danger" : "") + '">' + txt + "</b>"
    + (danger ? "" : ' <span class="safe">✓ 重置前够用</span>');
}

/* ---- 局部更新渲染：DOM 只建一次，之后按字段打补丁（刷新不闪烁）---- */
var built = { hero: false, heroErr: null, planN: -1, spark: {} };
function sectionHTML(b) {
  return '<div class="quotaSection">'
    + '<div class="quotaHead"><span class="qLabel">' + esc(b.label || b.show_name || "") + '</span>'
    + '<span class="qMeta"><span class="qPct"></span><span class="qReset"></span></span></div>'
    + '<div class="meter"><i style="width:0%"></i></div>'
    + '<div class="qLine l1"></div><div class="qLine l2"></div><div class="sparkBox"></div></div>';
}
function patchSection(el, b, l1html, l2html, sparkHtml, sparkKey) {
  if (!el) return;
  var pct = el.querySelector(".qPct"), reset = el.querySelector(".qReset"),
      bar = el.querySelector(".meter > i"), l1 = el.querySelector(".l1"),
      l2 = el.querySelector(".l2"), sb = el.querySelector(".sparkBox");
  pct.textContent = b.percent + "%";
  pct.style.color = lvColor(b.percent);
  reset.textContent = "重置 " + (b.reset_at ? until(b.reset_at, true) + "后" : "—");
  reset.className = "qReset" + (b.reset_at && b.reset_at - Math.floor(Date.now() / 1000) < 1800 ? " soon" : "");
  bar.style.width = b.percent + "%";
  bar.className = lvClass(b.percent);
  if (l1 && l1.innerHTML !== l1html) l1.innerHTML = l1html;
  if (l2 && l2 && l2html && l2.innerHTML !== l2html) l2.innerHTML = l2html;
  if (sb) { if (built.spark[sparkKey] !== sparkHtml) { built.spark[sparkKey] = sparkHtml; sb.innerHTML = sparkHtml; } }
}

async function load() {
  var err = document.getElementById("err");
  err.style.display = "none";
  try {
    var r = await fetch("/api/usage");
    var j = await r.json();
    if (!j.ok) throw new Error(j.error || "未知错误");
    var d = j.data;
    tick = REFRESH;
    document.getElementById("dot").className = "dot";
    var upd = document.getElementById("updated");
    if (upd) upd.textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN");

    /* Coding Plan hero：首建卡片，之后仅打补丁 */
    var hero = document.getElementById("hero");
    var cp = d.coding_plan;
    if (cp && !cp.error) {
      var rates = d.rates || {}, hist = d.history || {};
      if (built.heroErr !== null) { hero.innerHTML = ""; built.heroErr = null; }
      if (!built.hero) {
        hero.innerHTML = '<section class="card hero enter" style="--delay:0ms">'
          + '<div class="heroHead"><span class="providerPill"><i></i>GLM Coding Plan</span>'
          + '<span class="levelPill" id="cpLevel"></span>'
          + '<span class="heroStatus">付费编程套餐 · bigmodel.cn</span></div>'
          + '<div class="quotaWrap" id="heroWrap"></div></section>';
        built.hero = true;
      }
      document.getElementById("cpLevel").textContent = esc(cp.level).toUpperCase();
      var wrap = document.getElementById("heroWrap");
      if (wrap.children.length !== cp.limits.length) wrap.innerHTML = cp.limits.map(sectionHTML).join("");
      cp.limits.forEach(function (b, i) {
        patchSection(wrap.children[i], b,
          "已用 <b>" + fmt(b.used) + "</b> / " + fmt(b.total) + '<span class="sep">·</span>剩余 <b>' + fmt(b.remaining) + "</b>",
          etaParts(b, rates[b.id]),
          sparkline(hist[b.id], lvColor(b.percent)), b.id);
      });
    } else if (cp && cp.error) {
      if (built.heroErr !== cp.error) {
        built.hero = false; built.heroErr = cp.error; built.spark = {};
        hero.innerHTML = '<section class="card hero enter"><div class="heroHead"><span class="providerPill"><i></i>GLM Coding Plan</span></div><div class="quotaSection"><span class="qLine">⚠ ' + esc(cp.error) + "</span></div></section>";
      }
    } else { hero.innerHTML = ""; }

    /* 免费套餐：同策略 */
    var box = document.getElementById("plans");
    if (!d.plans.length && !d.buckets.length) {
      if (!built.emptyPlans) { box.innerHTML = '<div class="empty">无其他生效套餐</div>'; built.emptyPlans = true; }
    } else {
      built.emptyPlans = false;
      if (built.planN !== d.plans.length) {
        box.innerHTML = d.plans.map(function (p, pi) {
          return '<section class="card plan enter" style="--delay:' + (60 + pi * 60) + 'ms">'
            + '<h3><span class="pname"></span> <span class="badge"></span>'
            + (p.description ? '<span class="badge pdesc">' + esc(p.description) + "</span>" : "")
            + "</h3>" + '<div class="life"></div><div class="pwrap"></div></section>';
        }).join("");
        built.planN = d.plans.length;
      }
      d.plans.forEach(function (p, pi) {
        var card = box.children[pi];
        if (!card) return;
        var st = card.querySelector(".badge");
        st.className = "badge " + p.status;
        st.textContent = p.status === "active" ? "生效中" : p.status === "expired" ? "已到期" : esc(p.status);
        card.querySelector(".pname").textContent = p.name;
        card.querySelector(".life").textContent = "有效期至 " + (p.ends_at ? new Date(p.ends_at * 1000).toLocaleString("zh-CN") : "长期") + " · 剩 " + until(p.ends_at);
        var buckets = d.buckets.filter(function (b) { return b.plan_id === p.plan_id_raw; });
        var pw = card.querySelector(".pwrap");
        if (pw.children.length !== buckets.length) pw.innerHTML = buckets.map(function (b) { return sectionHTML(b); }).join("");
        buckets.forEach(function (b, bi) {
          patchSection(pw.children[bi], b,
            "已用 <b>" + fmtK(b.used) + "</b> / " + fmtK(b.total) + '<span class="sep">·</span>剩余 <b>' + fmtK(b.remaining) + "</b>（" + b.percent + "%）",
            "", "", b.id);
        });
      });
    }
  } catch (e) {
    document.getElementById("dot").className = "dot bad";
    err.textContent = "获取失败：" + e.message;
    err.style.display = "block";
  }
}

function schedule(){
  if (timer) clearInterval(timer);
  timer = setInterval(function(){
    tick--;
    var el = document.getElementById("countdown");
    if (el) el.textContent = Math.max(tick,0) + " 秒后刷新";
    if (tick <= 0) { tick = REFRESH; load(); }
  }, 1000);
}

async function keyStatus() {
  try {
    var j = await (await fetch("/api/config")).json();
    document.getElementById("keystatus").textContent =
      j.has_key ? "已配置 " + j.masked + "（优先使用）" : "未配置（用内嵌浏览器登录态兜底）";
    if (j.refresh_seconds) {
      REFRESH = j.refresh_seconds; tick = REFRESH;
      document.getElementById("refreshsel").value = String(j.refresh_seconds);
      document.getElementById("subline").textContent = "每 " + (j.refresh_seconds >= 60 ? (j.refresh_seconds/60) + " 分钟" : j.refresh_seconds + " 秒") + "自动拉取 · 燃烧速率按最近 5 分钟～6 小时样本估算 · ";
      document.getElementById("subline").insertAdjacentHTML("beforeend", '<a href="https://bigmodel.cn/coding-plan/personal/usage" target="_blank">官方用量页（含用量明细/健康度/额度重置/加油包）↗</a>');
    }
  } catch (e) {}
}
async function saveKey(clear) {
  var v = document.getElementById("keyinput").value;
  var r = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(clear ? { clear: true } : { key: v }) });
  var j = await r.json();
  document.getElementById("keystatus").textContent = j.ok ? "已保存 ✓" : "保存失败：" + j.error;
  if (j.ok) { document.getElementById("keyinput").value = ""; keyStatus(); load(); }
}
async function saveRefresh(v) {
  var r = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_seconds: Number(v) }) });
  var j = await r.json();
  if (j.ok) { REFRESH = Number(v); tick = REFRESH; schedule(); keyStatus(); }
}

/* ---- 使用详情（官方 token-usage/usage-detail 数据）---- */
var detailState = { days: 7, tab: "model", data: null };
function fmtTokD(n) {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
  return String(Math.round(n));
}
function renderDetail() {
  var body = document.getElementById("detailBody");
  var d = detailState.data;
  if (!d) { body.innerHTML = '<div class="empty" style="padding:18px 0">加载中…</div>'; return; }
  var sec = d[detailState.tab];
  if (!sec) { body.innerHTML = '<div class="empty" style="padding:18px 0">无数据</div>'; return; }
  if (sec.error) { body.innerHTML = '<div class="err2">⚠ ' + esc(sec.error) + "</div>"; return; }
  var s = sec.summary || {}, max = Math.max.apply(null, [1].concat(sec.totals || []));
  var bars = (sec.totals || []).map(function (v, i) {
    var h = Math.max(2, Math.round(v / max * 84));
    var peak = (sec.periodTypes || [])[i] === "PEAK";
    var t = (sec.xTime || [])[i] || "";
    return '<i class="' + (peak ? "peak" : "") + '" style="height:' + h + 'px" title="' + esc(t.slice(5, 16)) + " · " + fmtTokD(v) + ' token' + (peak ? " · 峰时" : " · 谷时") + '"></i>';
  }).join("");
  var items = (sec.items || []).slice(0, 8).map(function (it) {
    var top = sec.items[0] ? sec.items[0].total || 1 : 1;
    return '<div class="item"><span class="in" title="' + esc(it.name) + '">' + esc(it.name) + "</span>"
      + '<span class="ib"><i style="width:' + Math.max(2, Math.round((it.total || 0) / top * 100)) + '%"></i></span>'
      + '<span class="iv">' + fmtTokD(it.total) + "</span></div>";
  }).join("");
  body.innerHTML =
    '<div class="metrics">'
    + '<div class="metric"><div class="mv">' + fmtTokD(s.total) + '</div><div class="mk">总量 token</div></div>'
    + '<div class="metric"><div class="mv">' + fmtTokD(s.daily) + '</div><div class="mk">日均 token</div></div>'
    + '<div class="metric"><div class="mv">' + (s.cacheHit * 100).toFixed(1) + '%</div><div class="mk">缓存命中</div></div>'
    + '<div class="metric"><div class="mv">' + (s.peakRate * 100).toFixed(0) + '%</div><div class="mk">峰时占比</div></div>'
    + "</div>"
    + '<div class="bars">' + bars + "</div>"
    + '<div class="barAxis"><span>' + esc(((sec.xTime || [])[0] || "").slice(5, 10)) + "</span><span>" + esc(((sec.xTime || []).slice(-1)[0] || "").slice(5, 10)) + '</span></div>'
    + '<div class="legend"><span><i style="background:var(--acc)"></i>谷时</span><span><i style="background:var(--mid)"></i>峰时</span><span>按' + (sec.granularity === "HOUR" ? "小时" : sec.granularity) + "</span></div>"
    + '<div class="items">' + items + "</div>";
}
async function loadDetail() {
  try {
    var r = await fetch("/api/detail?days=" + detailState.days);
    var j = await r.json();
    if (!j.ok) throw new Error(j.error || "未知错误");
    detailState.data = j.data;
    renderDetail();
  } catch (e) {
    document.getElementById("detailBody").innerHTML = '<div class="err2">获取失败：' + esc(e.message) + "</div>";
  }
}
document.getElementById("detailDays").addEventListener("click", function (e) {
  var b = e.target.closest("button"); if (!b) return;
  detailState.days = Number(b.dataset.d);
  this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
  detailState.data = null; renderDetail(); loadDetail();
});
document.getElementById("detailTab").addEventListener("click", function (e) {
  var b = e.target.closest("button"); if (!b) return;
  detailState.tab = b.dataset.t;
  this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
  renderDetail();
});

applyTheme(document.documentElement.getAttribute("data-theme") || "dark");
keyStatus();
schedule();
load();
loadDetail();
</script></body></html>`;

/* ---------- HTTP 服务 ---------- */

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url.startsWith("/?")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(HTML);
  }
  if (req.url === "/api/usage") {
    Promise.allSettled([fetchBalance(), fetchCodingPlan()])
      .then(([bal, cp]) => {
        const out = bal.status === "fulfilled" ? normalizeBalance(bal.value) : { server_time: 0, plans: [], buckets: [] };
        out.plans = out.plans.map((p, i) => ({ ...p, plan_id_raw: (bal.value?.plans || [])[i]?.plan_id }));
        out.coding_plan = cp.status === "fulfilled" ? cp.value : { error: cp.reason?.message || "获取失败" };
        out.balance_error = bal.status === "rejected" ? bal.reason?.message : undefined;

        // 历史采样 + 速率（Coding Plan 为主；免费套餐桶一并记录）
        const current = new Map();
        for (const l of out.coding_plan.limits || []) current.set(l.id, l.used);
        for (const b of out.buckets) current.set(b.id, b.used);
        appendHistory(Object.fromEntries(current));
        out.rates = computeRates(current);
        out.history = historySeries();

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, data: out }));
      });
    return;
  }
  if (req.url === "/api/detail" || req.url.startsWith("/api/detail?")) {
    const days = Number(new URL(req.url, "http://x").searchParams.get("days")) || 7;
    fetchUsageDetail(days)
      .then((data) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, data }));
      })
      .catch((e) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
  }
  if (req.url === "/api/config" && req.method === "GET") {
    const key = configuredApiKey();
    const cfg = loadConfig();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      has_key: !!key, masked: key ? key.slice(0, 5) + "…" + key.slice(-4) : null,
      source: key ? "key" : "browser_session",
      refresh_seconds: cfg.refresh_seconds, sample_seconds: cfg.sample_seconds,
    }));
  }
  if (req.url === "/api/config" && req.method === "POST") {
    // 写接口校验：Host 必须是本服务地址（挡 DNS 重绑定），Origin 若存在必须是本站（挡跨站提交）
    const host = String(req.headers.host || "").toLowerCase();
    const origin = req.headers.origin;
    const hostOk = host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
    const originOk = !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
    if (!hostOk || !originOk) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "仅接受本机同源请求" }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const cfg = loadConfig();
        if (payload.clear) {
          delete cfg.coding_plan_key; // 清除后回退到内嵌浏览器登录态
        } else if (typeof payload.key === "string") {
          const submitted = payload.key.trim();
          if (submitted.length < 16 || submitted.length > 200) {
            throw new Error("Key 长度看起来不对（bigmodel 的 Key 是字母数字加点组成的字符串，约 49 个字符）");
          }
          cfg.coding_plan_key = submitted;
        } else if (payload.refresh_seconds != null) {
          const v = Math.floor(Number(payload.refresh_seconds));
          if (!(v >= 10 && v <= 3600)) throw new Error("刷新频率需在 10 秒 ~ 1 小时之间");
          cfg.refresh_seconds = v;
        } else if (payload.sample_seconds != null) {
          const v = Math.floor(Number(payload.sample_seconds));
          if (!(v >= 10 && v <= 3600)) throw new Error("采样间隔需在 10 秒 ~ 1 小时之间");
          cfg.sample_seconds = v;
        } else {
          throw new Error("没有可识别的配置项");
        }
        saveConfig(cfg);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});

function normalizeBalance(data) {
  const nowSec = Math.floor(Date.now() / 1000);
  const plans = (data.plans || []).map((p) => ({
    name: p.name || p.plan_id,
    description: p.description || "",
    status: p.status === "active" && p.ends_at && p.ends_at <= nowSec ? "expired" : (p.status || "unknown"),
    starts_at: p.starts_at,
    ends_at: p.ends_at,
  }));
  const buckets = (data.balances || []).map((b) => {
    const used = b.used_units || 0;
    const total = b.total_units || 0;
    return {
      id: "sp:" + b.plan_id + "/" + b.show_name,
      show_name: b.show_name,
      used, total,
      remaining: b.remaining_units ?? Math.max(total - used, 0),
      percent: total > 0 ? Math.min(100, Math.round((used / total) * 1000) / 10) : 0,
      expires_at: b.expires_at || b.period_end,
      plan_id: b.plan_id,
      priority: b.priority ?? 0,
    };
  }).sort((a, b2) => b2.priority - a.priority);
  return { server_time: data.server_time || nowSec, fetched_at: Date.now(), plans, buckets };
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`GLM 用量看板 v2.2 已启动: http://127.0.0.1:${PORT}  (Ctrl+C 停止)`);
});
