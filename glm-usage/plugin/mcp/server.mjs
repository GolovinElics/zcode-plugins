#!/usr/bin/env node
/**
 * glm-usage MCP 服务（自包含版 v1.4.0）
 *
 * 取数层内置：解密 ZCode 本地凭据 + 调用用量接口 + 历史采样，全部在本进程完成，
 * 不依赖任何外部本地服务。面板（ui://glm-usage/panel.html）经 MCP 桥调用工具取数。
 *
 * 数据来源（逆向自 ZCode 桌面版，非公开 API）：
 *   Coding Plan： GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *                 Authorization: <API Key（~/.glm-usage/config.json 或环境变量，优先）
 *                                 或 ZCode 内嵌浏览器的 bigmodel.cn 登录 Cookie（兜底）>
 *   免费套餐：   GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=…&device_mid=…
 *                 Authorization: Bearer <zcodejwttoken>（~/.zcode/v2/credentials.json 就地解密）
 *
 * 用户级数据目录：~/.glm-usage/（config.json 权限 600，history.json 保留 48 小时）
 */
"use strict";

import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PANEL_URI = "ui://glm-usage/panel.html";
const VERSION = "1.4.1";
const APP_VERSION = "3.18.2";
const DASHBOARD_ORIGIN = "http://127.0.0.1:8791"; // 仅当用户自建网页版时提示用，不作为依赖

const HOME = os.homedir();
const ZCODE_DIR = path.join(HOME, ".zcode");
const CRED_FILE = path.join(ZCODE_DIR, "v2/credentials.json");
const TELEMETRY_FILE = path.join(ZCODE_DIR, "v2/telemetry-state.json");
const EMBEDDED_COOKIE_DB = path.join(HOME, "Library/Application Support/ZCode/session/Partitions/zcode-embedded-browser/Cookies");
const DATA_DIR = path.join(HOME, ".glm-usage");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

// 出网白名单：仅这两个公网主机
const ALLOWED_HOSTS = new Set(["zcode.z.ai", "open.bigmodel.cn"]);
const DEFAULTS = { refresh_seconds: 30, sample_seconds: 60 };

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

// 从 ZCode 内嵌浏览器的 Cookie 库读取 bigmodel.cn 登录令牌（macOS，明文存储；非 macOS 返回空）
function loadCodingPlanToken() {
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

/* ---------- 历史采样与速率（~/.glm-usage/history.json，48h） ---------- */

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { return []; }
}

function appendHistory(values) {
  const t = Math.floor(Date.now() / 1000);
  const minGap = Math.max(10, Number(loadConfig().sample_seconds) || 60);
  const h = readHistory();
  const last = h[h.length - 1];
  if (last && t - last.t < minGap) last.values = values;
  else h.push({ t, values });
  const pruned = h.filter((x) => x.t >= t - 48 * 3600);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(pruned), { mode: 0o600 });
  } catch { /* 忽略 */ }
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
    description: "Open the GLM usage dashboard as an in-app panel (5h/weekly quota, burn rate, ETA).",
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
    name: "set_coding_key",
    description: "Save the bigmodel.cn Coding Plan API key for this machine (stored in ~/.glm-usage/config.json, mode 600). Pass empty string to clear.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_config",
    description: "Read local glm-usage config (key masked, refresh/sample intervals).",
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

async function handleToolCall(name, args) {
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
  if (name === "set_coding_key") {
    const key = String(args?.key ?? "").trim();
    const cfg = loadConfig();
    if (!key) delete cfg.coding_plan_key;
    else if (key.length < 16 || key.length > 200) throw new Error("Key 长度看起来不对（bigmodel 的 Key 约 49 个字符）");
    else cfg.coding_plan_key = key;
    saveConfig(cfg);
    return { content: [{ type: "text", text: key ? "已保存 ✓（优先使用）" : "已清除（回退浏览器登录态）" }] };
  }
  if (name === "get_config") {
    const key = configuredApiKey();
    const cfg = loadConfig();
    return { content: [{ type: "text", text: JSON.stringify({
      has_key: !!key, masked: key ? key.slice(0, 5) + "…" + key.slice(-4) : null,
      source: key ? "key" : "browser_session",
      refresh_seconds: cfg.refresh_seconds, sample_seconds: cfg.sample_seconds,
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
            text: await readFile(join(PLUGIN_ROOT, "panel.html"), "utf8"),
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
