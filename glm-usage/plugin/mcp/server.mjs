#!/usr/bin/env node
/**
 * glm-usage MCP 服务 — 提供 ZCode 应用内面板（ui:// 协议）与用量查询工具。
 *
 * 面板：ui://glm-usage/panel.html（iframe 壳，内嵌本地看板 http://127.0.0.1:8791）
 * 工具：open_dashboard（打开面板）/ get_usage（返回用量文本摘要）
 * 数据由 ~/glm-usage-dashboard/server.js 提供（LaunchAgent 常驻）。
 */
"use strict";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PANEL_URI = "ui://glm-usage/panel.html";
const DASHBOARD = "http://127.0.0.1:8791";
const VERSION = "1.3.0";

// 加载明/暗两枚自绘图标（MCP 标准 icons，data URI 内嵌）
const ICONS = [];
for (const theme of ["light", "dark"]) {
  try {
    const b64 = (await readFile(join(PLUGIN_ROOT, `icon-${theme}.png`))).toString("base64");
    ICONS.push({ src: `data:image/png;base64,${b64}`, mimeType: "image/png", sizes: ["256x256"], theme });
  } catch { /* 缺图则跳过 */ }
}

// 面板元数据：UI 偏好 + CSP（原生面板直连本地看板服务取数）
const PANEL_META = {
  ui: { prefersBorder: false, backgroundRetention: true },
  "zcode/csp": { connectDomains: [DASHBOARD] },
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
    name: "get_usage",
    description: "Fetch current GLM plan usage summary (coding plan limits, burn rate, free plan buckets) as text.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_usage_json",
    description: "Fetch the full usage dashboard payload as JSON text (for the in-app panel).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

async function fetchUsageText() {
  const res = await fetch(DASHBOARD + "/api/usage", { signal: AbortSignal.timeout(8000) });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "看板服务返回错误");
  const d = json.data;
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
  } else if (cp) {
    lines.push(`GLM Coding Plan: 获取失败（${cp.error}）`);
  }
  for (const p of d.plans || []) {
    lines.push(`${p.name}（${p.status === "active" ? "生效中" : p.status}）`);
    for (const b of (d.buckets || []).filter((x) => x.plan_id_raw === undefined || true)) {
      if (b.plan_id && d.plans.some((pl) => pl.plan_id_raw === b.plan_id && pl.name === p.name)) {
        lines.push(`  ${b.show_name}: ${b.used.toLocaleString()}/${b.total.toLocaleString()}（${b.percent}%）`);
      }
    }
  }
  if (!lines.length) lines.push("当前没有可显示的套餐数据");
  return lines.join("\n");
}

async function handleToolCall(name) {
  if (name === "open_dashboard") {
    return { content: [{ type: "text", text: `看板面板已打开；也可用浏览器访问 ${DASHBOARD}` }] };
  }
  if (name === "get_usage") {
    try {
      return { content: [{ type: "text", text: await fetchUsageText() }] };
    } catch (e) {
      return { content: [{ type: "text", text: `获取失败：${e.message}（看板服务可能未运行，可执行 node ~/glm-usage-dashboard/server.js）` }], isError: true };
    }
  }
  if (name === "get_usage_json") {
    // 面板数据源：服务端拉取本地看板 API（不受面板 CSP 限制），原样返回 JSON
    const res = await fetch(DASHBOARD + "/api/usage", { signal: AbortSignal.timeout(8000) });
    return { content: [{ type: "text", text: await res.text() }] };
  }
  throw new Error(`未知工具: ${name}`);
}

/* ---------- 极简 MCP stdio 服务（换行分隔的 JSON-RPC 2.0） ---------- */

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
        result = await handleToolCall(params?.name);
        break;
      case "resources/list":
        result = { resources: [
          { uri: PANEL_URI, name: "panel", mimeType: PANEL_MIME, _meta: PANEL_META },
          { uri: "ui://glm-usage/panel.js", name: "panel-script", mimeType: "text/javascript", _meta: PANEL_META },
        ] };
        break;
      case "resources/read": {
        const file = params?.uri === PANEL_URI ? "panel.html"
          : params?.uri === "ui://glm-usage/panel.js" ? "panel.js" : null;
        if (!file) throw new Error(`未知资源: ${params?.uri}`);
        result = {
          contents: [{
            uri: params.uri,
            mimeType: file.endsWith(".js") ? "text/javascript" : PANEL_MIME,
            _meta: PANEL_META,
            text: await readFile(join(PLUGIN_ROOT, file), "utf8"),
          }],
        };
        break;
      }
      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
    }
    send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}
