#!/usr/bin/env node
/**
 * glm-usage MCP 服务（自包含版 v2.0）
 *
 * 两大能力，取数全部在本进程完成，不依赖任何外部本地服务：
 *  ① 套餐用量：解密 ZCode 本地凭据 + 调用量接口 + 历史采样
 *  ② 上下文洞察（对标 dsh-context，适配 ZCode）：只读查询 ZCode 本地会话数据——
 *     ~/.zcode/cli/db/db.sqlite（session / turn_usage / model_usage / tool_usage / part）
 *     ~/.zcode/cli/rollout/model-io-sess_*.jsonl（每步模型请求的完整上下文，仅尾部按需读取）
 *
 * 用量数据来源（逆向自 ZCode 桌面版，非公开 API）：
 *   Coding Plan： GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *                 Authorization: <API Key（~/.glm-usage/config.json 或环境变量，优先）
 *                                 或 ZCode 内嵌浏览器的 bigmodel.cn 登录 Cookie（兜底）>
 *   免费套餐：   GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=…&device_mid=…
 *                 Authorization: Bearer <zcodejwttoken>（~/.zcode/v2/credentials.json 就地解密）
 *
 * 洞察数据为纯本地只读访问（sqlite 只读连接 + JSONL 尾部读取），不联网、不写入。
 * 用户级数据目录：~/.glm-usage/（config.json 权限 600，history.json 保留 48 小时）
 */
"use strict";

import { readViews, writeView } from './view-store.mjs';
import * as history from './history.mjs';
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { panelResource } from './panel-resource.mjs';
import { categorizeEntry } from './context-composition.mjs';

// node:sqlite（Node ≥22.5 内置）；缺失时回退 sqlite3 CLI，不影响用量工具
let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* 回退 CLI */ }

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PANEL_URI = "ui://glm-usage/panel.html";
const VERSION = "2.8.3";
const APP_VERSION = "3.18.2";
const DASHBOARD_ORIGIN = "http://127.0.0.1:8791"; // 仅当用户自建网页版时提示用，不作为依赖

const HOME = os.homedir();
const ZCODE_DIR = process.env.GLM_ZCODE_DIR || path.join(HOME, ".zcode");
const CRED_FILE = path.join(ZCODE_DIR, "v2/credentials.json");
const TELEMETRY_FILE = path.join(ZCODE_DIR, "v2/telemetry-state.json");
const EMBEDDED_COOKIE_DB = path.join(HOME, "Library/Application Support/ZCode/session/Partitions/zcode-embedded-browser/Cookies");
const DATA_DIR = process.env.GLM_USAGE_DATA_DIR || path.join(HOME, ".glm-usage");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const ACTIVITY_CACHE_FILE = path.join(DATA_DIR, "activity-cache.json"); // 命令/技能按天分桶物化

// 上下文洞察数据源（只读）
const ZCODE_DB = path.join(ZCODE_DIR, "cli/db/db.sqlite");
const ROLLOUT_DIR = path.join(ZCODE_DIR, "cli/rollout");

// 出网白名单：仅这两个公网主机（洞察数据全部本地，不出网）
const ALLOWED_HOSTS = new Set(["zcode.z.ai", "open.bigmodel.cn"]);
const DEFAULTS = {
  refresh_seconds: 30,
  sample_seconds: 60,
  // 模型上下文窗口（tokens），可按 model_id 覆盖
  context_windows: {},
  // 预估单价（¥ / 百万 tokens）：{ "glm-5.3": [输入价, 输出价] }，缺省不估价
  prices: {},
};

/* ---------- 用户配置 ---------- */

function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }; } catch { return { ...DEFAULTS }; }
}
function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}
function configuredApiKey() {
  return String(process.env.GLM_CODING_PLAN_API_KEY || loadConfig().coding_plan_key || "").trim();
}

/* ---------- 凭据解密 ----------
 * ZCode 自身的 enc:v1 方案：密钥 = SHA256("zcode-credential-fallback:{platform}:{homedir}:{username}")。
 * 逐字节复刻自官方 zcode.cjs，任何改动都会导致解密失败；强度由 ZCode 客户端设计决定。
 * 仅在本进程内解密使用，令牌不落盘、不出网（出网仅白名单两个官方域名）。 */

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
  throw new Error("无法解密 ZCode 凭据（enc:v1）");
}

function loadZcodeToken() {
  const cred = JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  const token = decryptV1(cred["zcodejwttoken"]);
  if (!token || token.startsWith("enc:")) throw new Error("zcodejwttoken 缺失或无法解密（需在本机登录 ZCode）");
  return token;
}

function loadDeviceMid() {
  return JSON.parse(fs.readFileSync(TELEMETRY_FILE, "utf8")).deviceMid;
}

// 零配置兜底：读取"本机用户本人"在 ZCode 内嵌浏览器里的 bigmodel.cn 登录态（Cookie 库中该值为明文存储）。
// 意图与 ZCode 桌面版自身一致（它同样从该库取此 Cookie 调用同族接口）；令牌仅在本机进程内用于请求
// open.bigmodel.cn，不写日志、不外传。用户配置 API Key（set_coding_key）后本路径不会被调用。
//
// 进程内缓存：面板按 refresh_seconds（可低至 3s）轮询配额，若每次都整库拷贝 Chromium Cookie DB，
// 既浪费磁盘 I/O 也可能在浏览器写入瞬间拷出撕裂副本。令牌轮换频率远低于轮询频率，
// 成功缓存 10 分钟、失败（未登录）缓存 60 秒；上游判定令牌失效时由调用方 invalidateCodingPlanToken() 清除。
let _codingPlanTokenMemo = null; // { at, ok, value | error }
const TOKEN_MEMO_OK_MS = 10 * 60 * 1000;
const TOKEN_MEMO_ERR_MS = 60 * 1000;
function invalidateCodingPlanToken() { _codingPlanTokenMemo = null; }
function loadCodingPlanToken() {
  if (_codingPlanTokenMemo) {
    const age = Date.now() - _codingPlanTokenMemo.at;
    if (_codingPlanTokenMemo.ok && age < TOKEN_MEMO_OK_MS) return _codingPlanTokenMemo.value;
    if (!_codingPlanTokenMemo.ok && age < TOKEN_MEMO_ERR_MS) throw new Error(_codingPlanTokenMemo.error);
  }
  try {
    const value = readCodingPlanTokenFromCookieDb();
    _codingPlanTokenMemo = { at: Date.now(), ok: true, value };
    return value;
  } catch (e) {
    _codingPlanTokenMemo = { at: Date.now(), ok: false, error: e.message };
    throw e;
  }
}
function readCodingPlanTokenFromCookieDb() {
  if (process.platform !== "darwin") throw new Error("未找到网页登录令牌");
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
  if (u.protocol !== "https:") throw new Error("仅允许 https");
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

const CREDIT_WINDOW_LABELS = { "3x5": "5 小时窗口", "6x1": "每周额度" };

async function fetchCodingPlan() {
  const apiKey = configuredApiKey();
  const token = apiKey || loadCodingPlanToken();
  const noCredHint = apiKey
    ? "API Key 无效或已失效（bigmodel.cn 控制台可重新生成），请在面板设置里更新"
    : "未配置 API Key —— 在面板 ⚙ 设置里填入 bigmodel.cn 的 API Key，或在 ZCode 内嵌浏览器登录 bigmodel.cn";
  const json = await httpsGetJson("https://open.bigmodel.cn/api/monitor/usage/quota/limit", { Authorization: token });
  if (!json.success) {
    const authRejected = json.code === 1001 || /身份验证|鉴权|令牌/.test(json.msg || "");
    if (authRejected && !apiKey) invalidateCodingPlanToken(); // 登录态可能已轮换，下次轮询重读 Cookie
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
  const json = await httpsGetJson(url, { Authorization: "Bearer " + loadZcodeToken() });
  if (json.code !== 0) throw new Error(`接口返回 code=${json.code} ${json.msg || ""}`);
  return json.data || {};
}

/* ---------- 官方使用详情（token-usage/usage-detail） ----------
 * 合并自 glm-usage-dashboard v1.6.3（另一工作线的成果），带 5 分钟缓存 */

function fmtLocalDayHour(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let detailCache = { at: 0, days: 0, data: null };
async function fetchUsageDetail(days = 7) {
  days = [1, 7, 30].includes(days) ? days : 7;
  if (detailCache.data && detailCache.days === days && Date.now() - detailCache.at < 5 * 60 * 1000) {
    return detailCache.data;
  }
  const apiKey = configuredApiKey();
  const token = apiKey || loadCodingPlanToken();
  const base = {
    startTime: fmtLocalDayHour(new Date(Date.now() - days * 86400 * 1000)),
    endTime: fmtLocalDayHour(new Date()),
    type: 1,
  };
  async function one(usageType) {
    const url = "https://open.bigmodel.cn/api/monitor/token-usage/usage-detail?" +
      new URLSearchParams({ ...base, usageType }).toString();
    const json = await httpsGetJson(url, { Authorization: token });
    if (!json.success) throw new Error(json.msg || `usage-detail(${usageType}) code=${json.code}`);
    const d = json.data || {};
    const block = d.modelUsage || d.mcpUsage || null;
    if (!block) return null;
    const n = (block.xTime || []).length;
    const totals = new Array(n).fill(0);
    for (const m of block.modelDataList || []) {
      for (const [k, arr] of Object.entries(m)) {
        if (k.endsWith("Usage") && Array.isArray(arr)) {
          for (let i = 0; i < n && i < arr.length; i++) totals[i] += arr[i] || 0;
        }
      }
    }
    const items = (block.modelSummaryList || block.toolSummaryList || []).map((x) => ({
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

/* ---------- 官方系统健康度（model-performance-day） ---------- */

let healthCache = { at: 0, days: 0, data: null };
async function fetchHealth(days = 7) {
  days = [1, 7, 30].includes(days) ? days : 7;
  if (healthCache.data && healthCache.days === days && Date.now() - healthCache.at < 5 * 60 * 1000) {
    return healthCache.data;
  }
  const apiKey = configuredApiKey();
  const token = apiKey || loadCodingPlanToken();
  const url = "https://open.bigmodel.cn/api/monitor/usage/model-performance-day?" +
    new URLSearchParams({
      startTime: fmtLocalDayHour(new Date(Date.now() - days * 86400 * 1000)),
      endTime: fmtLocalDayHour(new Date()),
    }).toString();
  const json = await httpsGetJson(url, { Authorization: token });
  if (!json.success) throw new Error(json.msg || `health code=${json.code}`);
  const d = json.data || {};
  const data = {
    xTime: d.x_time || [],
    lite: d.liteDecodeSpeed || [],
    proMax: d.proMaxDecodeSpeed || [],
    liteOk: d.liteSuccessRate || [],
    proMaxOk: d.proMaxSuccessRate || [],
  };
  healthCache = { at: Date.now(), days, data };
  return data;
}

/* ---------- 数据整理 ---------- */

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

/* ---------- 历史采样与速率（~/.glm-usage/history.json，48h；实现见 history.mjs） ---------- */

const readHistory = () => history.readHistory(HISTORY_FILE);
function appendHistory(values) {
  history.appendHistory(HISTORY_FILE, values, { sampleSeconds: loadConfig().sample_seconds });
}

function computeRates(current) {
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

function historySeries() {
  const h = readHistory();
  const out = {};
  for (const s of h) for (const [id, v] of Object.entries(s.values || {})) {
    (out[id] = out[id] || []).push([s.t, v]);
  }
  // sparkline 只消费 90 点；按 id 步长封顶，避免 48h 窗口点数随采样无限膨胀
  for (const id of Object.keys(out)) out[id] = history.strideCap(out[id], 180);
  return out;
}

/* ---------- 完整用量载荷（面板与工具共用） ---------- */

async function buildUsagePayload() {
  const [bal, cp] = await Promise.allSettled([fetchBalance(), fetchCodingPlan()]);
  const out = bal.status === "fulfilled" ? normalizeBalance(bal.value) : { server_time: 0, fetched_at: Date.now(), plans: [], buckets: [] };
  out.plans = out.plans.map((p, i) => ({ ...p, plan_id_raw: (bal.value?.plans || [])[i]?.plan_id }));
  out.coding_plan = cp.status === "fulfilled" ? cp.value : { error: cp.reason?.message || "获取失败" };
  out.balance_error = bal.status === "rejected" ? bal.reason?.message : undefined;

  const current = new Map();
  for (const l of out.coding_plan.limits || []) current.set(l.id, l.used);
  for (const b of out.buckets) current.set(b.id, b.used);
  appendHistory(Object.fromEntries(current));
  out.rates = computeRates(current);
  out.history = historySeries();
  return out;
}

/* ================================================================
 *  上下文洞察（对标 dsh-context，适配 ZCode 本地数据；全部只读）
 * ================================================================ */

/* ---------- sqlite 只读访问：优先 node:sqlite，回退 sqlite3 CLI ---------- */

let _db = null;        // node:sqlite DatabaseSync
let _dbMode = null;    // "node" | "cli"
const _stmts = new Map();

function dbAvailable() { return fs.existsSync(ZCODE_DB); }

function openDb() {
  if (!dbAvailable()) {
    throw new Error("未找到 ZCode 本地会话数据库（~/.zcode/cli/db/db.sqlite）——请先在本机安装并使用过 ZCode");
  }
  if (_dbMode) return _dbMode;
  if (DatabaseSync) {
    try {
      _db = new DatabaseSync(ZCODE_DB, { readOnly: true });
      _dbMode = "node";
    } catch { _dbMode = "cli"; }
  } else {
    _dbMode = "cli";
  }
  return _dbMode;
}

function q(sql, params = []) {
  const mode = openDb();
  if (mode === "node") {
    let st = _stmts.get(sql);
    if (!st) { st = _db.prepare(sql); _stmts.set(sql, st); }
    return st.all(...params);
  }
  // CLI 回退：参数内联（仅本插件自身的只读查询使用）
  let i = 0;
  const inlined = sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    return "'" + String(v).replace(/'/g, "''") + "'";
  });
  const out = execFileSync("/usr/bin/sqlite3", ["-json", `-readonly`, ZCODE_DB, inlined],
    { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 }).trim();
  return out ? JSON.parse(out) : [];
}

/* ---------- 模型窗口与估价 ---------- */

const MODEL_WINDOWS_BUILTIN = {
  "glm-5.3": 1000000, "glm-5.3-flash": 1000000, "glm-5.2": 1000000, "glm-5.2-flash": 1000000,
  "glm-5-air": 1000000, "glm-5": 200000, "glm-4.7": 200000, "glm-4.6": 200000, "glm-4.5": 128000,
  "glm-4.5-air": 128000, "glm-4.5-flash": 128000,
};
function normModel(modelId) {
  return String(modelId || "").toLowerCase().replace(/^.*[/#]/, "").trim();
}
function windowFor(modelId) {
  const m = normModel(modelId);
  const cfg = loadConfig().context_windows || {};
  if (cfg[m]) return Number(cfg[m]) || null;
  if (cfg["*"]) return Number(cfg["*"]) || null;
  const keys = Object.keys(MODEL_WINDOWS_BUILTIN).sort((a, b) => b.length - a.length);
  for (const k of keys) if (m === k || m.startsWith(k)) return MODEL_WINDOWS_BUILTIN[k];
  return 200000;
}
function priceFor(modelId) {
  const m = normModel(modelId);
  const prices = loadConfig().prices || {};
  const hit = prices[m] || prices["*"];
  return Array.isArray(hit) && hit.length >= 2 ? hit : null;
}

// 单次调用的费用（¥）：[输入价, 输出价] 元/百万 tokens；未配置价格返回 null（对齐上游"仅计价模型显示费用"）
function costOf(modelId, inputT, outputT) {
  const pr = priceFor(modelId);
  if (!pr) return null;
  return Math.round(((Number(inputT || 0) * pr[0] + Number(outputT || 0) * pr[1]) / 1e6) * 10000) / 10000;
}

/* ---------- 时间范围 ---------- */

function rangeStart(range) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const midnight = d.getTime();
  switch (range) {
    case "today": return midnight;
    case "7d": return midnight - 6 * 864e5;
    case "30d": return midnight - 29 * 864e5;
    default: return 0; // all
  }
}

/* ---------- part 维度统计的增量物化框架（~/.glm-usage/activity-cache.json） ----------
 * part 全表 json_extract 是洞察页静默刷新（app.js 每 6 秒）的主要 CPU 开销：
 * 本机 3 万行 ~110ms，600 万行外推 ~15s。这里把 commands/skills 统计按天分桶物化：
 *   { version, watermark: 已处理的最大 part rowid, days: { "YYYY-MM-DD": { <store>: … } } }
 * 每次 fetchInsights/fetchActivity(pick) 先看 MAX(rowid)：水位持平直接用桶；有新行只扫
 * rowid > 水位的增量；缓存缺失/损坏/版本不符/水位回退（VACUUM 重建）时全量重建一次。
 * 桶常驻内存，仅在水位推进时原子替换写盘。
 * 注意口径：桶只增不减，会话删除后 all 范围可能轻微高估（近似口径，见 README）。
 * 任何读写异常都降级回原直查路径，绝不让 get_insights/get_activity 失败。
 *
 * ---- 新增 part 维度统计（如 comms 协作记录）的最小接入方式 ----
 * 1) 在 ACTIVITY_STORES 增加一个条目，例如：
 *      comms: { init: () => new Map(), toJ: m => Object.fromEntries(m),
 *               fromJ: o => { const m = new Map(); for (const [k, v] of Object.entries(o || {})) if (Number.isFinite(v)) m.set(k, v); return m; } }
 * 2) 在 ACTIVITY_SCANS 增加一条增量扫描（SQL 必须带 p.rowid > ? AND p.rowid <= ? 双占位）：
 *      { sql: `SELECT date(p.time_created/1000,'unixepoch','localtime') day, <键>, COUNT(*) n
 *              FROM part p WHERE p.rowid > ? AND p.rowid <= ? AND <你的谓词> GROUP BY day, <键>`,
 *        row: (r, b) => b.comms.set(r.键, (b.comms.get(r.键) || 0) + Number(r.n || 0)) }
 * 3) ACTIVITY_CACHE_VERSION +1（旧缓存自动全量重建），按需写聚合读取函数（参考 activityTop/activityPickSessions）
 */

const ACTIVITY_CACHE_VERSION = 2;
const ACTIVITY_NONE_DAY = "_none"; // time_created 为空的行无法按天分桶，仅在 insights 的 all 范围计入
const PICK_SESSIONS_DAY_CAP = 400; // 单日单键的会话集合上限（与旧 pick 直查 LIMIT 语义同级的截断保护）
let _activity = null;        // 常驻内存：{ version, watermark, days: Map<day, bucket> }
let _activityDirty = false;

function localDayStr(t) {
  const d = new Date(t); const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* 桶内存储：每类统计一个 store（init/toJ/fromJ 负责构造与 JSON 往返，键名即缓存 JSON 字段名） */
const _countStore = {
  init: () => new Map(),
  toJ: (m) => Object.fromEntries(m),
  fromJ: (o) => { const m = new Map(); for (const [k, v] of Object.entries(o || {})) { if (!Number.isFinite(v)) throw new Error("count 值非法"); m.set(String(k), v); } return m; },
};
const _idSetStore = {
  init: () => new Map(),
  toJ: (m) => Object.fromEntries([...m].map(([k, s]) => [k, [...s]])),
  fromJ: (o) => { const m = new Map(); for (const [k, arr] of Object.entries(o || {})) { if (!Array.isArray(arr)) throw new Error("id 集合格式非法"); m.set(String(k), new Set(arr.map(String))); } return m; },
};
const ACTIVITY_STORES = {
  commands: _countStore,        // 程序名 → 次数（洞察排行）
  skills: _countStore,          // 技能名 → 次数（洞察排行）
  skills_last: _countStore,     // 技能名 → 最后 time_created（排行 tiebreak）
  cmd_sessions: _idSetStore,    // 程序名 → 当日会话 id 集合（commands pick）
  skill_sessions: _idSetStore,  // 技能名 → 当日会话 id 集合（skills pick）
};

function emptyActivityDay() {
  const b = {};
  for (const [name, s] of Object.entries(ACTIVITY_STORES)) b[name] = s.init();
  return b;
}

function activityDayBucket(day) {
  let b = _activity.days.get(day);
  if (!b) { b = emptyActivityDay(); _activity.days.set(day, b); }
  return b;
}

function cmdProgramOf(cmd) {
  return String(cmd || "").trim().split(/[\s;|&]/)[0].replace(/^.*\//, "") || "(空)";
}

/* 增量扫描：SQL 一律 `WHERE p.rowid > ? AND p.rowid <= ?`（水位双边界），row() 把一行合并进当日桶 */
const ACTIVITY_SCANS = [
  { // 命令次数（洞察排行；谓词与旧直查一致：LIKE 预滤 + command 非空）
    sql: `SELECT date(p.time_created/1000,'unixepoch','localtime') day, json_extract(p.data,'$.state.input.command') cmd, COUNT(*) n
      FROM part p WHERE p.rowid > ? AND p.rowid <= ? AND p.data LIKE '%"type":"tool"%'
      AND json_extract(p.data,'$.state.input.command') IS NOT NULL GROUP BY day, cmd`,
    row: (r, b) => { const prog = cmdProgramOf(r.cmd); b.commands.set(prog, (b.commands.get(prog) || 0) + Number(r.n || 0)); },
  },
  { // 技能次数 + 最后时间（洞察排行；谓词与旧直查一致）
    sql: `SELECT date(p.time_created/1000,'unixepoch','localtime') day, COALESCE(json_extract(p.data,'$.state.input.skill'),'未知') name,
        COUNT(*) calls, MAX(p.time_created) last_at
      FROM part p WHERE p.rowid > ? AND p.rowid <= ? AND json_extract(p.data,'$.type')='tool'
      AND json_extract(p.data,'$.tool')='Skill' GROUP BY day, name`,
    row: (r, b) => {
      const name = String(r.name || "未知");
      b.skills.set(name, (b.skills.get(name) || 0) + Number(r.calls || 0));
      b.skills_last.set(name, Math.max(b.skills_last.get(name) || 0, Number(r.last_at || 0)));
    },
  },
  { // 命令 → 会话集合（commands pick；谓词与旧 pick 直查一致：type='tool' + command 非空）
    sql: `SELECT date(p.time_created/1000,'unixepoch','localtime') day, json_extract(p.data,'$.state.input.command') cmd, p.session_id sid
      FROM part p WHERE p.rowid > ? AND p.rowid <= ? AND json_extract(p.data,'$.type')='tool'
      AND json_extract(p.data,'$.state.input.command') IS NOT NULL GROUP BY day, cmd, sid`,
    row: (r, b) => {
      const prog = cmdProgramOf(r.cmd);
      let s = b.cmd_sessions.get(prog);
      if (!s) { s = new Set(); b.cmd_sessions.set(prog, s); }
      if (s.size < PICK_SESSIONS_DAY_CAP) s.add(String(r.sid || ""));
    },
  },
  { // 技能 → 会话集合（skills pick；谓词与旧 pick 直查一致）
    sql: `SELECT date(p.time_created/1000,'unixepoch','localtime') day, COALESCE(json_extract(p.data,'$.state.input.skill'),'未知') name, p.session_id sid
      FROM part p WHERE p.rowid > ? AND p.rowid <= ? AND json_extract(p.data,'$.type')='tool'
      AND json_extract(p.data,'$.tool')='Skill' AND json_extract(p.data,'$.state.input.skill') IS NOT NULL GROUP BY day, name, sid`,
    row: (r, b) => {
      const name = String(r.name || "未知");
      let s = b.skill_sessions.get(name);
      if (!s) { s = new Set(); b.skill_sessions.set(name, s); }
      if (s.size < PICK_SESSIONS_DAY_CAP) s.add(String(r.sid || ""));
    },
  },
];

// 增量扫描 rowid ∈ (watermark, target] 的 part 行并按天合并进内存桶；返回新水位。
// 上界 target 取扫描前的 MAX(rowid)：扫描期间新插入的行留给下一轮，保证每行只处理一次。
function scanActivityDelta(watermark, target) {
  for (const spec of ACTIVITY_SCANS) {
    for (const r of q(spec.sql, [watermark, target])) spec.row(r, activityDayBucket(r.day || ACTIVITY_NONE_DAY));
  }
  return target;
}

// 从持久化文件载入内存桶；缺失/损坏/版本不符返回 null（调用方全量重建）
function loadActivityCache() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(ACTIVITY_CACHE_FILE, "utf8")); }
  catch (e) {
    if (e.code !== "ENOENT") console.error(`[glm-usage] activity-cache.json 读取失败，全量重建: ${e.message}`);
    return null;
  }
  try {
    if (!raw || raw.version !== ACTIVITY_CACHE_VERSION || !Number.isSafeInteger(raw.watermark) ||
        raw.watermark < 0 || !raw.days || typeof raw.days !== "object") return null;
    const days = new Map();
    for (const [day, b] of Object.entries(raw.days)) {
      if ((!/^\d{4}-\d{2}-\d{2}$/.test(day) && day !== ACTIVITY_NONE_DAY) || !b || typeof b !== "object") return null;
      const bucket = {};
      for (const [name, store] of Object.entries(ACTIVITY_STORES)) bucket[name] = store.fromJ(b[name]);
      days.set(day, bucket);
    }
    return { version: ACTIVITY_CACHE_VERSION, watermark: raw.watermark, days };
  } catch (e) {
    console.error(`[glm-usage] activity-cache.json 解析失败，全量重建: ${e.message}`);
    return null;
  }
}

// 原子替换写（对齐 view-store 写法）；失败保留内存桶与脏标记，下次水位推进时重试
function saveActivityCache() {
  if (!_activityDirty || !_activity) return;
  const days = {};
  for (const [day, b] of _activity.days) {
    const out = {};
    for (const [name, store] of Object.entries(ACTIVITY_STORES)) out[name] = store.toJ(b[name]);
    days[day] = out;
  }
  const payload = JSON.stringify({ version: ACTIVITY_CACHE_VERSION, watermark: _activity.watermark, days });
  const tmp = ACTIVITY_CACHE_FILE + ".tmp";
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, ACTIVITY_CACHE_FILE);
    _activityDirty = false;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    console.error(`[glm-usage] activity-cache.json 写盘失败（内存桶继续用，下次重试）: ${e.message}`);
  }
}

// fetchInsights 入口调用：保证内存桶与 part 水位一致后返回
function ensureActivityBuckets() {
  const maxRowid = Number(q(`SELECT MAX(rowid) m FROM part`)[0]?.m || 0);
  if (!_activity) {
    _activity = loadActivityCache();
    if (_activity && maxRowid < _activity.watermark) _activity = null; // 库被重建/回退，旧桶不可信
  }
  if (!_activity) {
    _activity = { version: ACTIVITY_CACHE_VERSION, watermark: 0, days: new Map() };
    _activityDirty = true;
  }
  if (maxRowid > _activity.watermark) {
    _activity.watermark = scanActivityDelta(_activity.watermark, maxRowid);
    _activityDirty = true;
  }
  saveActivityCache();
  return _activity;
}

// 从按天桶聚合出范围 top 列表。from 为本地零点毫秒，与旧 SQL time_created >= from 等价于 day >= dayCut
function activityTop(buckets, from) {
  const dayCut = from > 0 ? localDayStr(from) : null;
  const cmds = new Map(), skills = new Map(), lastAt = new Map();
  for (const [day, b] of buckets.days) {
    if (dayCut && (day === ACTIVITY_NONE_DAY || day < dayCut)) continue;
    for (const [p, n] of b.commands) cmds.set(p, (cmds.get(p) || 0) + n);
    for (const [name, c] of b.skills) skills.set(name, (skills.get(name) || 0) + c);
    for (const [name, ts] of b.skills_last) lastAt.set(name, Math.max(lastAt.get(name) || 0, ts));
  }
  return {
    commands: [...cmds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([program, count]) => ({ program, count })),
    skills: [...skills.entries()].sort((a, b) => b[1] - a[1] || (lastAt.get(b[0]) || 0) - (lastAt.get(a[0]) || 0)).slice(0, 12)
      .map(([name, calls]) => ({ name, calls, last_at: lastAt.get(name) || 0 })),
  };
}

// 从按天桶聚合 pick 的会话 id 集合（commands/skills 单击筛选）。
// 语义对齐旧 pick 直查：time_created >= from（from=0 时同样排除无时间戳行，故 _none 一律跳过）；
// 单日单键 400 上限由扫描侧保证，聚合后以 4000 总量界报 truncated（对齐旧 LIMIT 4000 口径）。
function activityPickSessions(kind, name, from) {
  const dayCut = from > 0 ? localDayStr(from) : null;
  const store = kind === "commands" ? "cmd_sessions" : "skill_sessions";
  const ids = new Set(); let capped = false;
  for (const [day, b] of _activity.days) {
    if (day === ACTIVITY_NONE_DAY || (dayCut && day < dayCut)) continue;
    const s = b[store].get(name);
    if (!s) continue;
    if (s.size >= PICK_SESSIONS_DAY_CAP) capped = true;
    for (const id of s) ids.add(id);
  }
  return { session_ids: [...ids], truncated: capped || ids.size >= 4000 };
}

/* ---------- model-io JSONL 尾部读取（反向分块：从文件末尾按需向前扩块，大文件安全） ---------- */

// 反向分块尾读：从文件末尾按 256KB 步长向前读块（凑不齐时 ×4 扩块：256KB→1MB→4MB→…），
// 在已读窗口里自后向前找完整行（以 \n 界定），凑齐 want 条含 request.body 的完整 entry 即停；
// 累计读取量不超过 capBytes（与旧整段尾读的上限一致，单行超块/找不到完整行时自然回退到大读）。
// 窗口未达文件头时首行视为截断半行丢弃。返回 { entries（最新在前）, bytes（entry 行 UTF-8 字节合计）}。
function readTailIoEntries(f, size, want, capBytes) {
  const fd = fs.openSync(f, "r");
  try {
    const chunks = [];
    let consumed = 0, step = 256 * 1024;
    let entries = [], bytes = 0;
    while (consumed < Math.min(size, capBytes)) {
      const len = Math.min(step, size - consumed, capBytes - consumed);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - consumed - len);
      chunks.unshift(buf);
      consumed += len;
      const text = Buffer.concat(chunks).toString("utf8");
      const lines = text.split("\n");
      const head = size - consumed > 0 ? 1 : 0; // 窗口未达文件头时 lines[0] 是截断半行
      entries = []; bytes = 0;
      for (let i = lines.length - 1; i >= head && entries.length < want; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e && e.request && e.request.body) { entries.push(e); bytes += Buffer.byteLength(line, "utf8"); }
        } catch { /* 半行或非请求行 */ }
      }
      if (entries.length >= want) break;
      step *= 4; // 本块凑不齐（完整行不足或单行超块），扩块再向前读
    }
    return { entries, bytes };
  } finally { fs.closeSync(fd); }
}

const _ioCache = new Map(); // file -> { size, mtimeMs, at, entries, bytes }（最新在尾部，LRU 逐出）
const IO_TAIL_BYTES = 24 * 1024 * 1024; // 单条 entry 可能包含完整上下文，上限放宽
const IO_CACHE_MAX_ENTRIES = 8;
const IO_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 估算字节（按源 JSON 行 UTF-8 长度）
let _ioCacheBytes = 0;

// 命中即刷新 LRU 位次（delete+set 移到尾部）
function ioCacheTouch(f) {
  const c = _ioCache.get(f);
  if (c) { _ioCache.delete(f); _ioCache.set(f, c); }
}

function ioCachePut(f, entry) {
  const old = _ioCache.get(f);
  if (old) { _ioCacheBytes -= old.bytes || 0; _ioCache.delete(f); }
  _ioCache.set(f, entry);
  _ioCacheBytes += entry.bytes || 0;
  // 超出条目数 / 估算字节上限时从最旧端逐出；至少保留刚写入的一条
  while (_ioCache.size > 1 && (_ioCache.size > IO_CACHE_MAX_ENTRIES || _ioCacheBytes > IO_CACHE_MAX_BYTES)) {
    const oldest = _ioCache.keys().next().value;
    if (oldest === f) break;
    _ioCacheBytes -= _ioCache.get(oldest).bytes || 0;
    _ioCache.delete(oldest);
  }
}

// 会话 ID 仅允许安全字符：既防止 rollout 文件名路径穿越，也收敛 sqlite CLI 回退路径的注入面
function validSessionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(id);
}

function sessionIoFile(sessionId) {
  if (!validSessionId(sessionId)) return null;
  const f = path.join(ROLLOUT_DIR, `model-io-${sessionId}.jsonl`);
  return fs.existsSync(f) ? f : null;
}

function readIoEntries(sessionId, want = 2) {
  const f = sessionIoFile(sessionId);
  if (!f) return [];
  const st = fs.statSync(f);
  const c = _ioCache.get(f);
  if (c) ioCacheTouch(f);
  // size+mtime 指纹未变即命中：条目是文件内容的纯函数，追加写入必然推进 mtime。
  // 不设 TTL——上下文页每 4s 轮询，TTL 会让未变化的文件也周期性重读+重解析
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) {
    return c.entries.slice(0, want);
  }
  const got = readTailIoEntries(f, st.size, Math.max(want, 2), IO_TAIL_BYTES);
  ioCachePut(f, { size: st.size, mtimeMs: st.mtimeMs, at: Date.now(), entries: got.entries, bytes: got.bytes });
  return got.entries.slice(0, want);
}

/* ---------- 上下文构成解析（七类，对标 dsh-context） ---------- */

function liveComposition(sessionId) {
  const entries = readIoEntries(sessionId, 2);
  if (!entries.length) return null;
  const cur = categorizeEntry(entries[0]);
  const prev = entries[1] ? categorizeEntry(entries[1]) : null;
  const model = normModel(entries[0]?.model?.modelId || entries[0]?.request?.body?.model);
  return {
    ts: Date.parse(entries[0].completedAt || entries[0].startedAt) || Date.now(),
    model,
    window: windowFor(model),
    cats: cur.cats,
    actual_input: cur.actualInput,
    actual_output: cur.actualOutput,
    total: cur.total,
    estimated: cur.estimated, method: cur.method,
    prev_total: prev && prev.actualInput > 0 ? prev.actualInput : (prev ? prev.total : null),
    request_id: entries[0].requestId || null,
    turn_id: entries[0].turnId || null,
  };
}

// 会话卡构成专用：只取最新一条（反向分块，常态 <1MB；上限与 readIoEntries 对齐 24MB，
// 单条 entry 超 8MB 的大会话卡片构成不再恒为空——只在真需要时才多读，缓存键 size+mtime 兜住重复读）
function readLatestIoEntry(sessionId, maxBytes = IO_TAIL_BYTES) {
  const f = sessionIoFile(sessionId);
  if (!f) return null;
  const st = fs.statSync(f);
  return readTailIoEntries(f, st.size, 1, maxBytes).entries[0] || null;
}

/* ---------- 聚合查询 ---------- */

function ms(v) { return v ? Number(v) : 0; }

function fetchInsights(range) {
  openDb();
  const from = rangeStart(range);
  const rng = from > 0 ? "mu.started_at >= ?" : "1=1";
  const params = from > 0 ? [from] : [];

  // ---- KPI ----
  const k = q(`SELECT
      COUNT(*) steps,
      COUNT(DISTINCT session_id) sessions,
      SUM(computed_total_tokens) tokens,
      SUM(input_tokens) input_t,
      SUM(output_tokens) output_t,
      SUM(reasoning_tokens) reasoning_t,
      SUM(cache_read_input_tokens) cache_read,
      SUM(cache_creation_input_tokens) cache_write,
      SUM(duration_ms) model_ms,
      SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN time_to_first_token_ms ELSE 0 END) ttft_ms,
      SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN 1 ELSE 0 END) ttft_n,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors
    FROM model_usage mu WHERE ${rng} AND mu.query_source != 'session_title'`, params)[0] || {};

  const t = q(`SELECT COUNT(*) turns,
      SUM(CASE WHEN cancelled_by_user=1 THEN 1 ELSE 0 END) cancels,
      SUM(CASE WHEN context_exceeded=1 THEN 1 ELSE 0 END) overflows,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors
    FROM turn_usage tu WHERE ${rng.replace(/mu\./g, "tu.")}`, params)[0] || {};

  const tl = q(`SELECT COUNT(*) calls,
      SUM(duration_ms) tool_ms,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors
    FROM tool_usage tu WHERE ${rng.replace(/mu\./g, "tu.")}`, params)[0] || {};

  const archived = q(`SELECT COUNT(*) n FROM session s WHERE time_archived IS NOT NULL AND time_deleted IS NULL
    AND EXISTS (SELECT 1 FROM model_usage mu WHERE mu.session_id=s.id AND ${rng} AND mu.query_source != 'session_title')`, params)[0]?.n || 0;

  const kpis = {
    sessions: Number(k.sessions || 0), archived,
    turns: Number(t.turns || 0), steps: Number(k.steps || 0),
    tool_calls: Number(tl.calls || 0), tool_errors: Number(tl.errors || 0), tool_ms: ms(tl.tool_ms),
    tokens: Number(k.tokens || 0), input: Number(k.input_t || 0), output: Number(k.output_t || 0),
    reasoning: Number(k.reasoning_t || 0), cache_read: Number(k.cache_read || 0), cache_write: Number(k.cache_write || 0),
    cache_hit: Number(k.input_t || 0) > 0 ? Math.round((Number(k.cache_read || 0) / Number(k.input_t)) * 10000) / 100 : 0,
    model_ms: ms(k.model_ms), ttft_ms: ms(k.ttft_ms), ttft_n: Number(k.ttft_n || 0),
    active_ms: ms(k.model_ms) + ms(tl.tool_ms),
    errors: Number(t.errors || 0) + Number(k.errors || 0),
    cancels: Number(t.cancels || 0),
    tps: (ms(k.model_ms) - ms(k.ttft_ms)) > 0 ? Math.round(Number(k.output_t || 0) / ((ms(k.model_ms) - ms(k.ttft_ms)) / 1000)) : 0,
    priced: false, cost: null,
  };
  // KPI 费用：仅当范围内每个用到的模型都配置了价格时才给出（部分计价会误导，对齐上游 priced-session 口径）
  {
    const perModel = q(`SELECT mu.model_id, SUM(mu.input_tokens) input_t, SUM(mu.output_tokens) output_t
      FROM model_usage mu WHERE ${rng} AND mu.query_source != 'session_title'
      GROUP BY mu.model_id`, params);
    let total = 0;
    const allPriced = perModel.length > 0 && perModel.every((r) => {
      const c = costOf(r.model_id, r.input_t, r.output_t);
      if (c == null) return false;
      total += c;
      return true;
    });
    if (allPriced) { kpis.priced = true; kpis.cost = Math.round(total * 10000) / 10000; }
  }

  // ---- 逐日（活跃度 + 走势 + 近 7 天卡）：一次按天聚合，起点取范围起点与 7 天起点中更早者 ----
  const mergedFrom = from > 0 ? Math.min(from, rangeStart("7d")) : 0;
  const mRng = mergedFrom > 0 ? "mu.started_at >= ?" : "1=1";
  const mParams = mergedFrom > 0 ? [mergedFrom] : [];
  const dailyRowsAll = (() => {
    const rows = q(`SELECT date(mu.started_at/1000,'unixepoch','localtime') day,
        SUM(mu.computed_total_tokens) tokens, SUM(mu.input_tokens) input_t, SUM(mu.output_tokens) output_t,
        SUM(mu.cache_read_input_tokens) cache_read, COUNT(*) steps, COUNT(DISTINCT mu.session_id) sessions,
        SUM(mu.duration_ms) model_ms, SUM(mu.time_to_first_token_ms) ttft_ms
      FROM model_usage mu WHERE ${mRng} AND mu.query_source != 'session_title'
      GROUP BY day ORDER BY day`, mParams);
    // 逐日费用：仅累计配置了价格的模型，未计价模型不计入也不清零当日（对齐上游"仅含支持计价映射的模型"口径）
    const costMap = new Map();
    for (const r of q(`SELECT date(mu.started_at/1000,'unixepoch','localtime') day, mu.model_id model_id,
        SUM(mu.input_tokens) input_t, SUM(mu.output_tokens) output_t
      FROM model_usage mu WHERE ${mRng} AND mu.query_source != 'session_title'
      GROUP BY day, mu.model_id`, mParams)) {
      const c = costOf(r.model_id, r.input_t, r.output_t);
      if (c != null) costMap.set(r.day, (costMap.get(r.day) || 0) + c);
    }
    return rows.map((r) => ({ day: r.day, tokens: Number(r.tokens || 0), input_t: Number(r.input_t || 0), output_t: Number(r.output_t || 0), cache_read: Number(r.cache_read || 0), steps: Number(r.steps || 0), sessions: Number(r.sessions || 0), cost: Math.round((costMap.get(r.day) || 0) * 10000) / 10000 }));
  })();
  // 近 7 天用量卡固定展示最近 7 天，不随全局范围筛选变化（对齐上游 dsh-context）
  const daily7 = dailyRowsAll.filter((r) => r.day >= localDayStr(rangeStart("7d")));
  const dayCut = from > 0 ? localDayStr(from) : null;
  const daily = dayCut ? dailyRowsAll.filter((r) => r.day >= dayCut) : dailyRowsAll;

  // ---- 按模型 ----
  const models = q(`SELECT mu.model_id,
      COUNT(*) steps, SUM(mu.input_tokens) input_t, SUM(mu.output_tokens) output_t,
      SUM(mu.cache_read_input_tokens) cache_read, SUM(mu.computed_total_tokens) tokens,
      SUM(mu.duration_ms) model_ms, SUM(mu.time_to_first_token_ms) ttft_ms
    FROM model_usage mu WHERE ${rng} AND mu.query_source != 'session_title'
    GROUP BY mu.model_id ORDER BY tokens DESC LIMIT 12`, params).map((r) => ({
      ...r, tokens: Number(r.tokens || 0),
      cost: costOf(r.model_id, r.input_t, r.output_t),
    }));

  // ---- 按工具 ----
  const tools = q(`SELECT tool_name name, COUNT(*) calls, SUM(duration_ms) tool_ms,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors, SUM(output_bytes) out_bytes
    FROM tool_usage tu WHERE ${rng.replace(/mu\./g, "tu.")}
    GROUP BY tool_name ORDER BY calls DESC LIMIT 14`, params).map((r) => ({ ...r, calls: Number(r.calls || 0) }));

  // ---- 命令执行 / 技能加载（按天分桶增量物化，读写异常降级回下面的直查路径） ----
  let commands = [], skills = [];
  try {
    ({ commands, skills } = activityTop(ensureActivityBuckets(), from));
  } catch (e) {
    console.error(`[glm-usage] 命令/技能分桶不可用，回退直查: ${e.message}`);
    try {
      const prng = from > 0 ? "p.time_created >= ?" : "1=1";
      const rows = q(`SELECT json_extract(p.data,'$.state.input.command') cmd, COUNT(*) n
        FROM part p WHERE ${prng} AND p.data LIKE '%"type":"tool"%'
        AND json_extract(p.data,'$.state.input.command') IS NOT NULL
        GROUP BY 1 ORDER BY n DESC LIMIT 1500`, params);
      const agg = new Map();
      for (const r of rows) {
        const first = String(r.cmd || "").trim().split(/[\s;|&]/)[0];
        const prog = first.replace(/^.*\//, "") || "(空)";
        agg.set(prog, (agg.get(prog) || 0) + Number(r.n || 0));
      }
      commands = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([program, count]) => ({ program, count }));
    } catch { /* part 结构变化时降级 */ }
    try {
      const prng = from > 0 ? "p.time_created >= ?" : "1=1";
      skills = q(`SELECT COALESCE(json_extract(p.data,'$.state.input.skill'),'未知') name,
          COUNT(*) calls, MAX(p.time_created) last_at
        FROM part p WHERE ${prng} AND json_extract(p.data,'$.type')='tool'
        AND json_extract(p.data,'$.tool')='Skill'
        GROUP BY 1 ORDER BY calls DESC, last_at DESC LIMIT 12`, params)
        .map((r) => ({ name: String(r.name || "未知"), calls: Number(r.calls || 0), last_at: Number(r.last_at || 0) }));
    } catch { /* part 结构变化时降级 */ }
  }

  // ---- 活跃度热力图（固定近 84 天，不受 range 影响；展示取 8 周对齐 dsh） ----
  const heatmap = q(`SELECT date(mu.started_at/1000,'unixepoch','localtime') day,
      SUM(mu.computed_total_tokens) tokens, COUNT(*) steps, COUNT(DISTINCT mu.session_id) sessions
    FROM model_usage mu
    WHERE mu.started_at >= ? AND mu.query_source != 'session_title'
    GROUP BY day ORDER BY day`, [Date.now() - 84 * 864e5]).map((r) => ({ day: r.day, tokens: Number(r.tokens || 0), steps: Number(r.steps || 0), sessions: Number(r.sessions || 0) }));

  // ---- 会话卡片 ----
  const srng = (alias) => (from > 0 ? `AND ${alias}.started_at >= ?` : "");
  const sessParams = from > 0 ? Array(5).fill(from) : []; // 与 SQL 中 5 个 ? 占位符一一对应
  const sessions = q(`SELECT s.id, s.title, s.directory, s.parent_id, s.task_type,
      s.time_created, s.time_updated, s.time_archived, s.time_compacting,
      (SELECT COUNT(*) FROM turn_usage tu WHERE tu.session_id = s.id) turns,
      (SELECT COUNT(*) FROM model_usage m2 WHERE m2.session_id = s.id AND m2.query_source != 'session_title' ${srng("m2")}) steps,
      (SELECT SUM(m3.computed_total_tokens) FROM model_usage m3 WHERE m3.session_id = s.id ${srng("m3")}) tokens,
      (SELECT SUM(m4.output_tokens) FROM model_usage m4 WHERE m4.session_id = s.id ${srng("m4")}) output_t,
      (SELECT SUM(m5.duration_ms) FROM model_usage m5 WHERE m5.session_id = s.id ${srng("m5")}) model_ms,
      -- 最近请求优先取 completed（取消/出错行用量全零，会让会话卡上下文显示 0）；id 兜底保证 model/ctx 取同一行
      (SELECT m6.model_id FROM model_usage m6 WHERE m6.session_id = s.id AND m6.query_source != 'session_title' ORDER BY (m6.status='completed') DESC, m6.started_at DESC, m6.id DESC LIMIT 1) last_model,
      (SELECT m7.input_tokens FROM model_usage m7 WHERE m7.session_id = s.id AND m7.query_source != 'session_title' ORDER BY (m7.status='completed') DESC, m7.started_at DESC, m7.id DESC LIMIT 1) last_ctx,
      (SELECT m8.id FROM message m8 WHERE m8.session_id = s.id AND COALESCE(json_extract(m8.data,'$.metadata.visibility'),'') != 'model-only' ORDER BY m8.time_created DESC LIMIT 1) last_msg_id,
      (SELECT json_extract(m9.data,'$.role') FROM message m9 WHERE m9.session_id = s.id AND COALESCE(json_extract(m9.data,'$.metadata.visibility'),'') != 'model-only' ORDER BY m9.time_created DESC LIMIT 1) last_msg_role
    FROM session s
    WHERE s.time_deleted IS NULL AND EXISTS (SELECT 1 FROM model_usage mu WHERE mu.session_id = s.id ${srng("mu")})
    ORDER BY s.time_updated DESC LIMIT 200`, sessParams);

  // 会话卡上下文构成（对齐 dsh：卡片环为最近请求的七类构成）。
  // 只解析最近 24 个会话；按 size+mtime 缓存，未变化的 rollout 不重复读取。
  const partsCache = globalThis.__glmCardParts || (globalThis.__glmCardParts = new Map());
  const partsFor = (sessionId) => {
    try {
      const f = sessionIoFile(sessionId);
      if (!f) return null;
      const st = fs.statSync(f);
      const ck = `${st.size}:${st.mtimeMs}`;
      const hit = partsCache.get(sessionId);
      if (hit && hit.ck === ck) return hit.parts;
      const entry = readLatestIoEntry(sessionId);
      const parts = entry ? (() => {
        const parsed = categorizeEntry(entry);
        return parsed.total > 0 ? parsed.cats.map((c) => ({ key: c.key, label: c.label, color: c.color, tokens: c.tokens })) : null;
      })() : null;
      if (partsCache.size > 400) partsCache.clear();
      partsCache.set(sessionId, { ck, parts });
      return parts;
    } catch { return null; }
  };
  const partsById = new Map();
  for (const s of sessions.slice(0, 24)) {
    const parts = partsFor(s.id);
    if (parts) partsById.set(s.id, parts);
  }

  const sessOut = sessions.map((s) => {
    let lastMsg = null;
    if (s.last_msg_id) {
      // 消息正文存于 part 表；取该消息最后一个 text part 的前 40 字符
      try {
        const pr = q(`SELECT data d FROM part WHERE message_id = ? AND json_extract(data,'$.type')='text'
          ORDER BY sequence DESC LIMIT 1`, [s.last_msg_id])[0];
        const txt = pr ? String(JSON.parse(pr.d).text || "") : "";
        lastMsg = txt.replace(/\s+/g, " ").slice(0, 40) || (s.last_msg_role !== "user" ? "(工具/思考)" : null);
      } catch { lastMsg = null; }
    }
    return {
      id: s.id, title: s.title, directory: s.directory, parent_id: s.parent_id || null,
      created: Number(s.time_created || 0), updated: Number(s.time_updated || 0),
      archived: s.time_archived != null, compacting: s.time_compacting != null,
      turns: Number(s.turns || 0), steps: Number(s.steps || 0),
      tokens: Number(s.tokens || 0), output: Number(s.output_t || 0),
      model_ms: ms(s.model_ms), model: s.last_model ? normModel(s.last_model) : null,
      context: Number(s.last_ctx || 0), window: windowFor(s.last_model),
      cost: null, last_msg: lastMsg, parts: partsById.get(s.id) || null,
    };
  });

  return { range: range || "all", from, to: Date.now(), generated_at: Date.now(), kpis, daily, daily7, heatmap, models, tools, commands, skills, sessions: sessOut, current_id: (sessions.find((s) => !s.parent_id) || {}).id || null };
}

function fetchSessionsList() {
  openDb();
  const rows = q(`SELECT id, title, time_updated, parent_id FROM session
    WHERE time_deleted IS NULL ORDER BY time_updated DESC LIMIT 60`);
  return rows.map((r) => ({ id: r.id, title: r.title, updated: Number(r.time_updated || 0), parent_id: r.parent_id || null }));
}

function fetchSessionContext(sessionId) {
  openDb();
  const s = q(`SELECT * FROM session WHERE id = ? AND time_deleted IS NULL`, [sessionId])[0];
  if (!s) throw new Error("会话不存在（可能已被删除）");

  const steps = q(`SELECT id, started_at, completed_at, turn_id, model_id, status, query_source,
      input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens,
      computed_total_tokens, duration_ms, time_to_first_token_ms, error_type, finish_reason, attempt_index
    FROM model_usage WHERE session_id = ? AND query_source != 'session_title'
    ORDER BY started_at DESC, id DESC LIMIT 600`, [sessionId]).reverse().map((r) => ({
    id: r.id,
    ts: Number(r.started_at || 0),
    turn: r.turn_id ? String(r.turn_id).slice(-8) : null,
    model: normModel(r.model_id),
    status: r.status,
    source: r.query_source,
    input: Number(r.input_tokens || 0), output: Number(r.output_tokens || 0),
    reasoning: Number(r.reasoning_tokens || 0), cache_read: Number(r.cache_read_input_tokens || 0),
    cache_write: Number(r.cache_creation_input_tokens || 0),
    total: Number(r.computed_total_tokens || 0),
    dur: ms(r.duration_ms), ttft: ms(r.time_to_first_token_ms),
    error: r.error_type || null,
  }));

  // 汇总
  const sumRow = q(`SELECT COUNT(*) steps, SUM(input_tokens) input, SUM(output_tokens) output,
    SUM(reasoning_tokens) reasoning,
    SUM(cache_read_input_tokens) cache_read, SUM(cache_creation_input_tokens) cache_write,
    SUM(duration_ms) model_ms, SUM(time_to_first_token_ms) ttft_ms,
    SUM(CASE WHEN time_to_first_token_ms IS NOT NULL THEN 1 ELSE 0 END) ttft_n,
    SUM(computed_total_tokens) tokens,
    SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors
    FROM model_usage WHERE session_id = ? AND query_source != 'session_title'`, [sessionId])[0] || {};
  const sum = Object.fromEntries(Object.entries(sumRow).map(([key, value]) => [key, Number(value || 0)]));
  const tl = q(`SELECT COUNT(*) calls, SUM(duration_ms) tool_ms, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors
    FROM tool_usage WHERE session_id = ?`, [sessionId])[0] || {};
  const timing = {
    model_ms: sum.model_ms, ttft_ms: sum.ttft_ms,
    gen_ms: Math.max(sum.model_ms - sum.ttft_ms, 0),
    tool_ms: ms(tl.tool_ms), tool_calls: Number(tl.calls || 0), tool_errors: Number(tl.errors || 0),
    active_ms: sum.model_ms + ms(tl.tool_ms),
    tps: (sum.model_ms - sum.ttft_ms) > 0 ? Math.round(sum.output / ((sum.model_ms - sum.ttft_ms) / 1000)) : 0,
    cache_hit: sum.input > 0 ? Math.round((sum.cache_read / sum.input) * 10000) / 100 : 0,
  };

  // 事件：压缩 / 超限 / 模型切换 / 错误 / 取消 / 子代理
  const events = [];
  if (s.time_compacting) events.push({ type: "compact", ts: Number(s.time_compacting), label: "上下文压缩", detail: "会话触发自动压缩" });
  const tu = q(`SELECT started_at, cancelled_by_user, context_exceeded, status, error_type FROM turn_usage
    WHERE session_id = ? ORDER BY started_at ASC`, [sessionId]);
  for (const r of tu) {
    if (Number(r.context_exceeded || 0)) events.push({ type: "overflow", ts: Number(r.started_at || 0), label: "上下文超限", detail: "该轮请求超出模型窗口" });
    if (Number(r.cancelled_by_user || 0)) events.push({ type: "cancel", ts: Number(r.started_at || 0), label: "用户取消", detail: "该轮被手动中断" });
  }
  let lastModel = null;
  steps.forEach((r, i) => {
    if (lastModel && r.model && r.model !== lastModel) events.push({ type: "switch", ts: r.ts, label: "切换模型", detail: `${lastModel} → ${r.model}` });
    lastModel = r.model || lastModel;
    if (r.status === "error") events.push({ type: "error", ts: r.ts, label: "请求失败", detail: r.error || "模型调用出错" });
  });
  const kids = q(`SELECT id, title, time_created FROM session WHERE parent_id = ? AND time_deleted IS NULL`, [sessionId]);
  for (const c of kids) events.push({ type: "spawn", ts: Number(c.time_created || 0), label: "派出子代理", detail: c.title || c.id });
  events.sort((a, b) => a.ts - b.ts);

  const turns = tu.length || new Set(steps.map((r) => r.turn).filter(Boolean)).size;
  const live = liveComposition(sessionId);
  const lastModelId = steps.length ? steps[steps.length - 1].model : null;

  // ---- Context Stats 卡片（对齐 dsh-context 会话页） ----
  const toolRows = q(`SELECT tool_name name, COUNT(*) count FROM tool_usage WHERE session_id = ?
    GROUP BY tool_name ORDER BY count DESC LIMIT 12`, [sessionId]).map((r) => ({ name: r.name, count: Number(r.count || 0) }));
  let commands = [];
  try {
    const cmdRows = q(`SELECT json_extract(data,'$.state.input.command') cmd, COUNT(*) n FROM part
      WHERE session_id = ? AND data LIKE '%"type":"tool"%' AND json_extract(data,'$.state.input.command') IS NOT NULL
      GROUP BY 1 ORDER BY n DESC LIMIT 800`, [sessionId]);
    const agg = new Map();
    for (const r of cmdRows) {
      const first = String(r.cmd || "").trim().split(/[\s;|&]/)[0].replace(/^.*\//, "") || "(空)";
      agg.set(first, (agg.get(first) || 0) + Number(r.n || 0));
    }
    commands = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([program, count]) => ({ program, count }));
  } catch { /* 降级 */ }
  const commandCalls = Number(q(`SELECT COUNT(*) n FROM part WHERE session_id = ?
    AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.state.input.command') IS NOT NULL`, [sessionId])[0]?.n || 0);
  const userMsgs = q(`SELECT COUNT(*) n FROM message WHERE session_id = ? AND json_extract(data,'$.role')='user'
    AND COALESCE(json_extract(data,'$.metadata.visibility'),'') != 'model-only'
    AND COALESCE(json_extract(data,'$.metadata.runtimeMessage'),'') = ''`, [sessionId])[0]?.n || 0;
  const answers = q(`SELECT COUNT(*) n FROM part p JOIN message m ON p.message_id = m.id
    WHERE m.session_id = ? AND json_extract(m.data,'$.role')='assistant' AND json_extract(p.data,'$.type')='text'`, [sessionId])[0]?.n || 0;
  const skills = q(`SELECT COUNT(*) n FROM message WHERE session_id = ? AND json_extract(data,'$.role')='user'
    AND (data LIKE '%SKILL.md%' OR data LIKE '%skills/%')`, [sessionId])[0]?.n || 0;
  const injectN = q(`SELECT COUNT(*) n FROM message WHERE session_id = ? AND json_extract(data,'$.role')='user'
    AND json_extract(data,'$.metadata.visibility')='model-only'`, [sessionId])[0]?.n || 0;
  const lastMsgRow = q(`SELECT json_extract(data,'$.role') role, id FROM message WHERE session_id = ?
    AND COALESCE(json_extract(data,'$.metadata.visibility'),'') != 'model-only'
    ORDER BY time_created DESC LIMIT 1`, [sessionId])[0];
  let lastMsg = null;
  if (lastMsgRow) {
    // 消息正文存于 part 表（message.data 无 content），取该消息最后一个 text part
    try {
      const pr = q(`SELECT data d FROM part WHERE message_id = ? AND json_extract(data,'$.type')='text'
        ORDER BY sequence DESC LIMIT 1`, [lastMsgRow.id])[0];
      const txt = pr ? String(JSON.parse(pr.d).text || "") : "";
      lastMsg = txt.replace(/\s+/g, " ").slice(0, 60) || (lastMsgRow.role === "user" ? null : "(工具/思考)");
    } catch { lastMsg = null; }
  }

  return {
    session: {
      id: s.id, title: s.title, directory: s.directory, parent_id: s.parent_id || null,
      created: Number(s.time_created || 0), updated: Number(s.time_updated || 0),
      archived: s.time_archived != null, compacting: s.time_compacting != null,
      turns, steps: sum.steps, tokens: sum.tokens, timing, token_sums: sum,
      model: lastModelId, window: windowFor(lastModelId),
      cost: costOf(lastModelId, sum.input, sum.output), last_msg: lastMsg,
    },
    stats: {
      user_msgs: Number(userMsgs || 0), answers: Number(answers || 0), skills: Number(skills || 0),
      injects: Number(injectN || 0), compacts: events.filter((e) => e.type === "compact").length,
      overflows: events.filter((e) => e.type === "overflow").length,
      tool_calls: Number(tl.calls || 0), tools: toolRows,
      commands, command_calls: commandCalls,
    },
    steps,
    steps_offset: Math.max(0, sum.steps - steps.length),
    steps_truncated: sum.steps > steps.length,
    events,
    live,
    has_io: !!sessionIoFile(sessionId),
  };
}

function fetchContextBrowser(sessionId, opts = {}) {
  openDb();
  const entries = readIoEntries(sessionId, 2);
  if (!entries.length) throw new Error("该会话没有可读的 model-io 记录（可能过旧或被清理）");
  const idx = opts.prev ? 1 : 0;
  const entry = entries[idx];
  if (!entry) throw new Error("没有上一条请求记录");
  const parsed = categorizeEntry(entry);
  const model = normModel(entry?.model?.modelId || entry?.request?.body?.model);
  return {
    session_id: sessionId,
    ts: Date.parse(entry.completedAt || entry.startedAt) || Date.now(),
    model, window: windowFor(model),
    request_id: entry.requestId || null,
    turn_id: entry.turnId || null,
    actual_input: parsed.actualInput, actual_output: parsed.actualOutput,
    total: parsed.total, estimated: parsed.estimated, method: parsed.method, has_previous: entries.length > 1,
    cats: parsed.cats,
    messages: (entry.request?.body?.messages || []).length,
    tools: (entry.request?.body?.tools || []).length,
  };
}

function fetchFleet(sessionId) {
  openDb();
  let root = sessionId
    ? q(`SELECT * FROM session WHERE id = ?`, [sessionId])[0]
    : q(`SELECT * FROM session WHERE parent_id IS NULL AND time_deleted IS NULL ORDER BY time_updated DESC LIMIT 1`)[0];
  if (!root) throw new Error("没有可用会话");
  const visited = new Set();
  while (root.parent_id && !visited.has(root.id)) {
    visited.add(root.id);
    const parent = q(`SELECT * FROM session WHERE id = ? AND time_deleted IS NULL`, [root.parent_id])[0];
    if (!parent) break;
    root = parent;
  }
  const nowMs = Date.now();
  const kidRows = q(`SELECT * FROM session WHERE parent_id = ? AND time_deleted IS NULL ORDER BY time_created ASC`, [root.id]);
  // 家族成员：递归收集全部后代——子代理（或 side chat）再派生的代理也纳入编队
  const memberRows = [];
  const seen = new Set([root.id]);
  const queue = [...kidRows];
  while (queue.length) {
    const row = queue.shift();
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    memberRows.push(row);
    for (const grand of q(`SELECT * FROM session WHERE parent_id = ? AND time_deleted IS NULL ORDER BY time_created ASC`, [row.id])) queue.push(grand);
  }
  const ids = [root.id, ...memberRows.map((k) => k.id)];
  // 编队成员用量批量聚合：每成员 2 条查询合并为整个家族 2 条 IN 查询（消除 N+1；>400 分片）
  const aggById = new Map();  // session_id -> { steps, tokens, model_ms, input_t, output_t }
  const lastById = new Map(); // session_id -> { model_id, input_tokens }
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const cph = chunk.map(() => "?").join(",");
    for (const r of q(`SELECT session_id, COUNT(*) steps, SUM(computed_total_tokens) tokens, SUM(duration_ms) model_ms,
        SUM(input_tokens) input_t, SUM(output_tokens) output_t
      FROM model_usage WHERE session_id IN (${cph}) AND query_source != 'session_title' GROUP BY session_id`, chunk)) {
      aggById.set(r.session_id, r);
    }
    // 各成员最近一次模型请求：先按会话取 MAX(started_at)，再 JOIN 回取该行的 model_id/input_tokens（不依赖窗口函数）。
    // 优先取成功（completed）请求——取消/出错/运行中的行用量全零，直接取最近一行会把卡片上下文显示成 0
    // （如子代理被中止后卡片从 85.7k 变成 0 / 1.0M）；无成功请求的会话再回退取最近一行。
    const lastSql = (cond, ph) => `SELECT m.session_id session_id, m.model_id model_id, m.input_tokens input_tokens
      FROM model_usage m
      JOIN (SELECT session_id, MAX(started_at) last_at FROM model_usage
            WHERE session_id IN (${ph}) AND query_source != 'session_title'${cond} GROUP BY session_id) t
        ON t.session_id = m.session_id AND t.last_at = m.started_at
      WHERE m.query_source != 'session_title'${cond}`;
    for (const r of q(lastSql(" AND status = 'completed'", cph), chunk)) {
      lastById.set(r.session_id, r); // 同一 started_at 并列时任取一行（与旧 ORDER BY DESC LIMIT 1 的非确定性一致）
    }
    const missed = chunk.filter((id) => !lastById.has(id));
    if (missed.length) {
      const mph = missed.map(() => "?").join(",");
      for (const r of q(lastSql("", mph), missed)) lastById.set(r.session_id, r);
    }
  }
  const member = (row) => {
    const agg = aggById.get(row.id) || {};
    const lastM = lastById.get(row.id) || {};
    return {
      id: row.id, title: row.title, parent_id: row.parent_id || null,
      created: Number(row.time_created || 0), updated: Number(row.time_updated || 0),
      steps: Number(agg.steps || 0), tokens: Number(agg.tokens || 0), model_ms: ms(agg.model_ms),
      context: Number(lastM.input_tokens || 0), window: windowFor(lastM.model_id),
      model: lastM.model_id ? normModel(lastM.model_id) : null,
      cost: lastM.model_id ? costOf(lastM.model_id, agg.input_t, agg.output_t) : null,
      running: nowMs - Number(row.time_updated || 0) < 3 * 60000,
    };
  };
  const members = memberRows.map(member);
  // 家族汇总（对齐 dsh-context Fleet 头部：Agents / Running / Work items / Messages，覆盖全部后代）
  const ph = ids.map(() => "?").join(",");
  // messages = 各成员请求数之和（与原 COUNT(*) IN 同口径，直接复用上面的批量结果）
  let inMsg = 0;
  for (const id of ids) inMsg += Number(aggById.get(id)?.steps || 0);
  const inTodos = q(`SELECT COUNT(*) n FROM todo WHERE session_id IN (${ph}) AND status != 'completed'`, ids)[0]?.n || 0;
  const running = [root, ...memberRows].filter((s) => nowMs - Number(s.time_updated || s.updated || 0) < 3 * 60000).length;
  // 跨 Agent 协作：Agent 派发 / SendMessage 消息；Agent 输出中的 agentId 可精确关联派生出的子会话
  const comms = [];
  for (const r of q(`SELECT p.session_id sid, p.time_created at, p.data
      FROM part p WHERE p.session_id IN (${ph}) AND json_extract(p.data,'$.tool') IN ('Agent','SendMessage')
      ORDER BY p.time_created DESC LIMIT 200`, ids)) {
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    const input = d.state?.input || {};
    const to = (String(d.state?.output || '').match(/agentId:\s*agent_([0-9a-f-]+)/) || [])[1];
    comms.push({
      from: r.sid, to: to ? `sess_subagent_agent_${to}` : null,
      kind: d.tool === 'Agent' ? 'delegate' : 'message',
      description: String(input.description || input.content || input.message || input.text || '').slice(0, 160) || '(无描述)',
      status: String(d.state?.status || 'unknown'), at: Number(r.at),
    });
  }
  comms.reverse();
  // 协作任务：全家族待办（三态与任务分相对齐）
  const works = q(`SELECT t.session_id sid, t.content, t.status, t.priority, t.time_updated at
      FROM todo t WHERE t.session_id IN (${ph}) ORDER BY t.time_updated DESC LIMIT 300`, ids)
    .map((r) => ({ sid: r.sid, content: String(r.content || '').slice(0, 200), status: String(r.status || 'pending'), priority: String(r.priority || ''), at: Number(r.at) }));
  return {
    lead: member(root), members, comms, works,
    summary: { agents: ids.length, running, work_items: Number(inTodos || 0), messages: Number(inMsg || 0) },
  };
}

function fetchActivity(args = {}) {
  const kind = ["commands", "tools", "files", "skills"].includes(args.kind) ? args.kind : "tools";
  const sid = args.session_id;
  if (sid && !validSessionId(sid)) throw new Error("非法的 session_id");
  const from = rangeStart(["today", "7d", "30d", "all"].includes(args.range) ? args.range : "7d");
  // 轻量路径：排行行单击筛选只需要去重后的 session_id 集合。
  // 不走明细的逐行 part JOIN（part 无 callID 索引，4.5k 行也要数秒），三个 kind 各用直查：
  // tools 走 tool_usage 索引（毫秒级）；skills/commands 直接扫 part（全库 2.6k 行 ~50-300ms）
  if (typeof args.pick === "string" && args.pick) {
    if (kind === "tools") {
      const ids = q(`SELECT DISTINCT session_id FROM tool_usage WHERE tool_name = ? AND started_at >= ? LIMIT 4000`, [args.pick, from]);
      return { kind, pick: args.pick, session_ids: ids.map((r) => r.session_id), truncated: ids.length >= 4000 };
    }
    // skills/commands 的 pick 优先走物化日分桶（毫秒级，part 无 time_created 索引的直查在
    // 大库窄范围会退化成全表扫）；任何异常降级回原直查路径
    if (kind === "skills" || kind === "commands") {
      try {
        ensureActivityBuckets();
        const r = activityPickSessions(kind, kind === "commands" ? cmdProgramOf(args.pick) : args.pick, from);
        return { kind, pick: args.pick, session_ids: r.session_ids, truncated: r.truncated };
      } catch (e) {
        console.error(`[glm-usage] pick(${kind}) 物化路径失败，降级直查: ${e.message}`);
      }
      if (kind === "skills") {
        const ids = q(`SELECT DISTINCT session_id FROM part WHERE json_extract(data,'$.type')='tool'
            AND json_extract(data,'$.tool')='Skill' AND json_extract(data,'$.state.input.skill') = ? AND time_created >= ? LIMIT 4000`, [args.pick, from]);
        return { kind, pick: args.pick, session_ids: ids.map((r) => r.session_id), truncated: ids.length >= 4000 };
      }
      const rows = q(`SELECT DISTINCT session_id, json_extract(data,'$.state.input.command') cmd FROM part
          WHERE json_extract(data,'$.type')='tool' AND json_extract(data,'$.state.input.command') IS NOT NULL AND time_created >= ? LIMIT 20000`, [from]);
      const ids = [];
      for (const r of rows) {
        const first = String(r.cmd || "").trim().split(/[\s;|&]/)[0].replace(/^.*\//, "");
        if (first === args.pick) ids.push(r.session_id);
      }
      return { kind, pick: args.pick, session_ids: ids, truncated: rows.length >= 20000 };
    }
  }
  // 两段式：第一步仅查 tool_usage（started_at / session 索引，毫秒级）；
  // 第二步只对这 ≤501 行涉及的会话集合 + 时间窗批量取 part 明细（走 part_session_idx），
  // JS 侧按 (session_id, callID) 关联、同 callID 多 part 去重取一。
  // 避免旧实现的全表 part LEFT JOIN json_extract（30 天范围约 4 秒）。
  const where = sid ? "tu.session_id = ?" : "tu.started_at >= ?";
  const params = [sid || from];
  const rows = q(`SELECT tu.id, tu.session_id, tu.tool_call_id, tu.tool_name name, tu.status, tu.started_at ts,
      tu.duration_ms dur, tu.exit_code, tu.error_type, tu.output_bytes
    FROM tool_usage tu WHERE ${where} ${kind === "skills" ? "AND tu.tool_name='Skill'" : ""}
    ORDER BY tu.started_at DESC LIMIT 501`, params);
  const enrich = new Map(); // "session_id|callID" -> { command, file, skill, background }
  if (rows.length) {
    let minTs = Infinity, maxTs = -Infinity;
    for (const r of rows) { const t = Number(r.ts) || 0; if (t < minTs) minTs = t; if (t > maxTs) maxTs = t; }
    const win = 30 * 60000; // part 创建时间与工具调用相近，±30 分钟窗口足够覆盖偏差
    const sessions = [...new Set(rows.map((r) => r.session_id))];
    const cmd = "json_extract(p.data,'$.state.input.command')";
    const file = "coalesce(json_extract(p.data,'$.state.input.file_path'),json_extract(p.data,'$.state.input.path'))";
    const skill = "json_extract(p.data,'$.state.input.skill')";
    for (let i = 0; i < sessions.length; i += 200) {
      const chunk = sessions.slice(i, i + 200);
      const ph = chunk.map(() => "?").join(",");
      for (const p of q(`SELECT p.session_id session_id, json_extract(p.data,'$.callID') call_id,
          ${cmd} command, ${file} file, ${skill} skill,
          json_extract(p.data,'$.state.input.run_in_background') background
        FROM part p WHERE p.session_id IN (${ph}) AND p.time_created >= ? AND p.time_created <= ?
          AND p.data LIKE '%callID%'`, [...chunk, minTs - win, maxTs + win])) {
        if (!p.call_id) continue;
        const key = p.session_id + "|" + p.call_id;
        if (!enrich.has(key)) enrich.set(key, p); // 同 callID 多 part 去重取一
      }
    }
  }
  const joined = rows.map((r) => {
    const e = enrich.get(r.session_id + "|" + (r.tool_call_id ?? "")) || {};
    const { tool_call_id, ...rest } = r; // 输出字段与旧结构一致，不外泄 join 键
    return { ...rest, command: e.command ?? null, file: e.file ?? null, skill: e.skill ?? null, background: !!e.background };
  });
  // 原 SQL 对 commands / files / skills 三类按 part 明细过滤，关联后在 JS 侧保持同一口径
  const filtered = kind === "commands" ? joined.filter((r) => r.command != null)
    : kind === "files" ? joined.filter((r) => r.file != null)
    : kind === "skills" ? joined.filter((r) => r.skill != null)
    : joined;
  return { kind, truncated: filtered.length > 500, limit: 500,
    rows: filtered.slice(0, 500).map(r => ({ ...r, ts: Number(r.ts), dur: Number(r.dur || 0),
      command: r.command ? String(r.command).slice(0, 2000) : null,
      program: r.command ? String(r.command).trim().split(/[\s;|&]/)[0].replace(/^.*\//, "") : r.name,
      background: !!r.background })) };
}

// 某一天（本地时区）有 model_usage 记录的去重会话 id 列表（排除 query_source='session_title'）。
// 按 started_at 索引做当日范围扫描，毫秒级；daily/heatmap 不再返回 session_ids 明细，前端按天补查走这里。
function fetchDaySessions(day) {
  const ds = String(day || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) throw new Error("day 需为 YYYY-MM-DD（本地日期）");
  const [y, m, d] = ds.split("-").map(Number);
  const dt = new Date(2000, m - 1, d); // 先用安全年份构造，再 setFullYear 避开两位数年份映射
  dt.setFullYear(y);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) throw new Error("无效日期");
  openDb();
  const start = dt.getTime(); // 本地当日零点
  const rows = q(`SELECT DISTINCT session_id FROM model_usage
    WHERE started_at >= ? AND started_at < ? AND query_source != 'session_title'`, [start, start + 864e5]);
  return { day: ds, session_ids: rows.map((r) => r.session_id) };
}

/* ---------- 面板与图标 ---------- */

// 加载明/暗两枚自绘图标（MCP 标准 icons，data URI 内嵌）
const ICONS = [];
for (const theme of ["light", "dark"]) {
  try {
    const b64 = (await readFile(join(PLUGIN_ROOT, `icon-${theme}.png`))).toString("base64");
    ICONS.push({ src: `data:image/png;base64,${b64}`, mimeType: "image/png", sizes: ["256x256"], theme });
  } catch { /* 缺图则跳过 */ }
}

const PANEL_META = {
  ui: { prefersBorder: false, backgroundRetention: true },
  "zcode/csp": { connectDomains: [DASHBOARD_ORIGIN] },
};
const PANEL_MIME = "text/html;profile=mcp-app";

const TOOLS = [
  {
    name: "open_dashboard",
    description: "Open the GLM usage & context-insight dashboard as an in-app panel (quota, burn rate, context stats, context browser, trends).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: PANEL_URI, surface: "editor", visibility: ["model", "app"] } },
  },
  {
    name: "get_usage_json",
    description: "Fetch the full usage dashboard payload as JSON text (for the in-app panel).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_usage",
    description: "Fetch current GLM plan usage summary (coding plan limits, burn rate, free plan buckets) as text.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_usage_detail",
    description: "Fetch official usage detail (hourly totals with peak/off-peak, per-model/per-tool breakdown, cache hit rate) for the last N days (1/7/30). Returns JSON text.",
    inputSchema: { type: "object", properties: { days: { type: "number", description: "1, 7 or 30" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_health",
    description: "Fetch official system health daily snapshot (Max&Pro vs Lite decode speed and success rate) for the last N days (1/7/30). Returns JSON text.",
    inputSchema: { type: "object", properties: { days: { type: "number", description: "1, 7 or 30" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_insights",
    description: "Aggregate local ZCode session analytics for a time range: KPIs (sessions/turns/steps/tokens/cache hit/active time), daily activity, per-model and per-tool stats, top skills, commands and files, and a session list. Read-only, local.",
    inputSchema: { type: "object", properties: { range: { type: "string", enum: ["today", "7d", "30d", "all"], description: "Time range preset, default 7d" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_session_context",
    description: "Deep view of one local ZCode session: per-step token trend, timing stats, context events (compact/switch/error/cancel), and the live context composition of the latest model request. Read-only, local.",
    inputSchema: { type: "object", properties: { session_id: { type: "string", description: "Session id (sess_...); defaults to the most recent session" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_context_browser",
    description: "Break down one model request's full context into 7 categories (system prompt, tool schemas, user messages, injected content, skill injections, assistant messages, tool results) with per-item token estimates and previews. Read-only, local.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id; defaults to the most recent session" },
        prev: { type: "boolean", description: "Use the previous request instead of the latest (for delta view)" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_activity",
    description: "Read recent local tool, command or file activity. Returns at most 500 execution records for filtering and inspection; never executes commands.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["commands", "tools", "files", "skills"] }, session_id: { type: "string" }, range: { type: "string", enum: ["today", "7d", "30d", "all"] }, pick: { type: "string", description: "只返回使用该项的会话 id 集合（排行行筛选联动轻量路径）" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_day_sessions",
    description: "List deduplicated local session ids that have model usage records on one calendar day (local time). Read-only, local.",
    inputSchema: { type: "object", properties: { day: { type: "string", description: "Local calendar day in YYYY-MM-DD" } }, required: ["day"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_context_item",
    description: "Read one context item's text from the latest or previous local request. Bounded to 32k characters, read-only.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" }, item_id: { type: "string" }, prev: { type: "boolean" } }, required: ["session_id", "item_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_fleet",
    description: "Agent family view for local ZCode sessions: lead session plus its subagent sessions with per-agent token/context usage. Read-only, local.",
    inputSchema: { type: "object", properties: { session_id: { type: "string", description: "Lead session id; defaults to the most recent root session" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "set_coding_key",
    description: "Save the bigmodel.cn Coding Plan API key for this machine (stored in ~/.glm-usage/config.json, mode 600). NOTE: tool arguments may persist in conversation history — for a human user, prefer the panel's settings input which bypasses the conversation. Pass empty string to clear.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "set_refresh",
    description: "Set the usage auto-refresh interval in seconds (3-600). Persisted in ~/.glm-usage/config.json.",
    inputSchema: { type: "object", properties: { seconds: { type: "number", description: "Refresh interval in seconds (3-600)" } }, required: ["seconds"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_view_state",
    description: "Read saved local dashboard view state.",
    inputSchema: {type:"object",properties:{},additionalProperties:false},
    annotations:{readOnlyHint:true,openWorldHint:false},
  },
  {
    name: "save_view_state",
    description: "Persist one dashboard view locally, isolated by session identifier.",
    inputSchema: {type:"object",properties:{key:{type:"string"},value:{type:"object"}},required:["key","value"],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },
  {
    name: "get_config",
    description: "Read local glm-usage config (key masked, refresh/sample intervals, context windows, pricing).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

async function usageText() {
  const d = await buildUsagePayload();
  const lines = [];
  const cp = d.coding_plan;
  if (cp && !cp.error) {
    lines.push(`GLM Coding Plan · ${String(cp.level).toUpperCase()}`);
    for (const l of cp.limits) {
      const rate = d.rates?.[l.id];
      lines.push(`  ${l.label}: ${l.used.toLocaleString()}/${l.total.toLocaleString()}（${l.percent}%）剩余 ${l.remaining.toLocaleString()}` +
        (rate ? ` · 速率 ${Math.round(rate.per_hour)}/时` : "") +
        (l.reset_at ? ` · 重置 ${new Date(l.reset_at * 1000).toLocaleString("zh-CN")}` : ""));
    }
  } else if (cp) lines.push(`GLM Coding Plan: 获取失败（${cp.error}）`);
  for (const p of d.plans || []) {
    lines.push(`${p.name}（${p.status === "active" ? "生效中" : p.status}）`);
    for (const b of (d.buckets || []).filter((x) => x.plan_id && d.plans.some((pl) => pl.plan_id_raw === x.plan_id && pl.name === p.name))) {
      lines.push(`  ${b.show_name}: ${b.used.toLocaleString()}/${b.total.toLocaleString()}（${b.percent}%）`);
    }
  }
  if (!lines.length) lines.push("当前没有可显示的套餐数据");
  return lines.join("\n");
}

function defaultSessionId() {
  const r = q(`SELECT id FROM session WHERE time_deleted IS NULL ORDER BY time_updated DESC LIMIT 1`)[0];
  if (!r) throw new Error("本地没有可用会话（db.sqlite 为空）");
  return r.id;
}

async function handleToolCall(name, args) {
  if (name === "get_view_state" || name === "save_view_state") {
    if (name === "save_view_state") writeView(DATA_DIR,args.key,args.value);
    return {content:[{type:"text",text:JSON.stringify({ok:true,data:name === "get_view_state" ? readViews(DATA_DIR) : true})}]};
  }
  if (name === "get_activity") {
    try { return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: fetchActivity(args) }) }] }; }
    catch (e) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }], isError: true }; }
  }
  if (name === "get_day_sessions") {
    try { return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: fetchDaySessions(args?.day) }) }] }; }
    catch (e) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }], isError: true }; }
  }
  if (name === "get_context_item") {
    try {
      if (!validSessionId(args.session_id) || typeof args.item_id !== "string" || args.item_id.length > 160) throw new Error("无效的条目标识");
      const entry = readIoEntries(args.session_id, 2)[args.prev ? 1 : 0];
      if (!entry) throw new Error("该请求已不可用，请刷新后重试");
      const data = categorizeEntry(entry, { contentId: args.item_id }).detail;
      if (!data) throw new Error("上下文已更新，请重新选择条目");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
    }
  }

  if (name === "open_dashboard") {
    return { content: [{ type: "text", text: "看板面板已打开" }] };
  }
  if (name === "get_usage_json") {
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: await buildUsagePayload() }) }] };
  }
  if (name === "get_usage") {
    try {
      return { content: [{ type: "text", text: await usageText() }] };
    } catch (e) {
      return { content: [{ type: "text", text: `获取失败：${e.message}` }], isError: true };
    }
  }
  if (name === "get_usage_detail") {
    try {
      const days = [1, 7, 30].includes(Number(args?.days)) ? Number(args.days) : 7;
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: await fetchUsageDetail(days) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
    }
  }
  if (name === "get_health") {
    try {
      const days = [1, 7, 30].includes(Number(args?.days)) ? Number(args.days) : 7;
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: await fetchHealth(days) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
    }
  }
  if (name === "get_insights") {
    try {
      const range = ["today", "7d", "30d", "all"].includes(args?.range) ? args.range : "7d";
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: fetchInsights(range) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
    }
  }
  if (name === "get_session_context") {
    try {
      const sid = args?.session_id || defaultSessionId();
      if (!validSessionId(sid)) throw new Error("非法的 session_id");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: fetchSessionContext(sid) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
    }
  }
  if (name === "get_context_browser") {
    try {
      const sid = args?.session_id || defaultSessionId();
      if (!validSessionId(sid)) throw new Error("非法的 session_id");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: fetchContextBrowser(sid, { prev: !!args?.prev }) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
    }
  }
  if (name === "get_fleet") {
    try {
      const sid = args?.session_id || defaultSessionId();
      if (!validSessionId(sid)) throw new Error("非法的 session_id");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: fetchFleet(sid) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
    }
  }
  if (name === "set_coding_key") {
    const key = String(args?.key ?? "").trim();
    const cfg = loadConfig();
    if (!key) delete cfg.coding_plan_key;
    else if (key.length < 16 || key.length > 200) throw new Error("Key 长度看起来不对（bigmodel 的 Key 约 49 个字符）");
    else cfg.coding_plan_key = key;
    saveConfig(cfg);
    return { content: [{ type: "text", text: key ? "已保存 ✓（优先使用）" : "已清除（回退浏览器登录态）" }] };
  }
  if (name === "set_refresh") {
    const n = Math.round(Number(args?.seconds));
    if (!Number.isFinite(n) || n < 3 || n > 600) throw new Error("seconds 需在 3~600 之间");
    const cfg = loadConfig();
    cfg.refresh_seconds = n;
    saveConfig(cfg);
    return { content: [{ type: "text", text: `已设为每 ${n >= 60 ? (n / 60) + " 分钟" : n + " 秒"}刷新` }] };
  }
  if (name === "get_config") {
    const key = configuredApiKey();
    const cfg = loadConfig();
    return { content: [{ type: "text", text: JSON.stringify({
      has_key: !!key, masked: key ? key.slice(0, 5) + "…" + key.slice(-4) : null,
      source: key ? "key" : "browser_session",
      refresh_seconds: cfg.refresh_seconds, sample_seconds: cfg.sample_seconds,
      context_windows: cfg.context_windows, prices: cfg.prices || {},
      insights_available: dbAvailable(),
    }) }] };
  }
  throw new Error(`未知工具: ${name}`);
}

/* ---------- 极简 MCP stdio 服务（换行分隔 JSON-RPC 2.0） ---------- */

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) dispatch(line);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function dispatch(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // 通知，无需应答
  try {
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: "glm-usage", title: "GLM 用量", version: VERSION, icons: ICONS },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call":
        result = await handleToolCall(params?.name, params?.arguments || {});
        break;
      case "resources/list":
        result = { resources: [{ uri: PANEL_URI, name: "panel", mimeType: PANEL_MIME, _meta: PANEL_META }] };
        break;
      case "resources/read":
        if (params?.uri !== PANEL_URI) throw new Error(`未知资源: ${params?.uri}`);
        result = {
          contents: [{
            uri: PANEL_URI,
            mimeType: PANEL_MIME,
            _meta: PANEL_META,
            text: await panelResource(PLUGIN_ROOT),
          }],
        };
        break;
      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
    }
    send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}

/* ---------- 测试与基准辅助导出（不影响 MCP stdio 协议） ---------- */
export const __internals = {
  readIoEntries, readLatestIoEntry, readTailIoEntries,
  fetchInsights, fetchFleet, ensureActivityBuckets, activityTop, activityPickSessions, q, openDb,
};
