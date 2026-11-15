/* 模型价格：内置参考目录 + 多源同步归一 + 本地模型匹配推荐（纯逻辑，无 IO，便于测试）。
 * 价格统一口径：目录条目携带原币种（USD/CNY），应用/估价时换算为 CNY 每百万 tokens 的 [输入, 输出]，
 * 与 config.prices / costOf 的现行格式完全兼容。
 * 同步 ≠ 应用：sync 只刷新参考目录缓存（~/.glm-usage/pricing-cache.json），改写 config.prices 必须经用户显式应用。 */

export const PRICES_BUILTIN = {
  // GLM · bigmodel 国内站（CNY 牌价参考；Flash 按国际线牌价换算）
  "glm-5.3": { in: 8, out: 28, cur: "CNY", vendor: "GLM", note: "bigmodel 国内站参考价" },
  "glm-5.3-flash": { in: 1.1, out: 3.6, cur: "CNY", vendor: "GLM", note: "z.ai 国际线牌价换算" },
  "glm-4.7": { in: 2.9, out: 12.6, cur: "CNY", vendor: "GLM", note: "z-ai 直连线换算" },
  "glm-4.5": { in: 2, out: 8, cur: "CNY", vendor: "GLM", note: "bigmodel 牌价" },
  // DeepSeek · 官方（USD，官方文档峰值档；谷时约半价）
  "deepseek-v4-pro": { in: 1.32, out: 3.96, cur: "USD", vendor: "DeepSeek", note: "官方峰值档" },
  "deepseek-flash": { in: 0.3, out: 1.2, cur: "USD", vendor: "DeepSeek", note: "官方峰值档" },
  // OpenAI · 官方（USD）
  "gpt-5.2": { in: 1.75, out: 14, cur: "USD", vendor: "OpenAI" },
  "gpt-5.1": { in: 1.25, out: 10, cur: "USD", vendor: "OpenAI" },
  "gpt-5-mini": { in: 0.25, out: 2, cur: "USD", vendor: "OpenAI" },
  // Anthropic · 官方（USD）
  "claude-sonnet-4.6": { in: 3, out: 15, cur: "USD", vendor: "Anthropic" },
  "claude-opus-4.6": { in: 5, out: 25, cur: "USD", vendor: "Anthropic" },
  "claude-haiku-4.5": { in: 1, out: 5, cur: "USD", vendor: "Anthropic" },
};

/* ---- 键归一化与家族识别 ---- */
const FAMILY_ALIAS = {
  zai: "glm", zhipu: "glm", glm: "glm", chatglm: "glm",
  openai: "openai", gpt: "openai", o1: "openai", o3: "openai", o4: "openai", codex: "openai",
  anthropic: "anthropic", claude: "anthropic",
  deepseek: "deepseek", seek: "deepseek",
  google: "google", gemini: "google", qwen: "qwen", alibaba: "qwen", dashscope: "qwen",
  kimi: "moonshot", moonshot: "moonshot", grok: "xai", xai: "xai", xAI: "xai",
  llama: "meta", meta: "meta", mistral: "mistral", mistralai: "mistral", doubao: "doubao", minimax: "minimax",
};
// 版本数字权重最高（5≠4 是不同模型），档位词次之，其余词最低
const TIER_WORDS = new Set(["flash", "air", "pro", "mini", "ultra", "chat", "reasoner", "thinking", "sonnet", "opus", "haiku", "codex", "instant", "turbo", "latest", "preview", "exp", "x", "max"]);

export function normKey(id) {
  let s = String(id || "").toLowerCase().trim();
  s = s.replace(/^.*[/#]/, ""); // 去厂商/中转前缀（zai-api/、z-ai/、cloudflare/@cf/xx/、azure# 等最后一段之前全部去掉，与 normModel 同口径）
  return s.replace(/[:].*$/, "").trim(); // 去 :batch/:free 等变体后缀
}
export function tokenize(key) {
  return String(key || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
export function familyOf(tokens) {
  for (const t of tokens) { const f = FAMILY_ALIAS[t]; if (f) return f; }
  return null;
}
function weightOf(t) { return /^\d+$/.test(t) ? 3 : TIER_WORDS.has(t) ? 2 : 1; }

/* 匹配分（0~1）：家族（glm/deepseek/gpt/claude/…）不一致直接 0；
 * 版本号命中权重最高，flash/air/pro 等档位词次之；互为前缀给保底分。 */
export function matchScore(localKey, catalogKey) {
  const a = tokenize(normKey(localKey)), b = tokenize(normKey(catalogKey));
  if (!a.length || !b.length) return 0;
  const ja = a.join("-"), jb = b.join("-");
  if (ja === jb) return 1;
  const fa = familyOf(a), fb = familyOf(b);
  if (!fa || !fb || fa !== fb) return 0;
  const setB = new Set(b);
  let common = 0, wa = 0, wb = 0;
  for (const t of a) { wa += weightOf(t); if (setB.has(t)) common += weightOf(t); }
  for (const t of b) wb += weightOf(t);
  let score = wa + wb > 0 ? (2 * common) / (wa + wb) : 0;
  if (ja.startsWith(jb) || jb.startsWith(ja)) score = Math.max(score, 0.8);
  return Math.min(1, score);
}

/* ---- 同步源归一（每条：{ in, out, cur:"USD", vendor, tier }；tier 2=官方/直连，1=中转参考） ---- */
const OFFICIAL_LITELLM_PREFIXES = new Set(["deepseek", "zai", "zhipu", "openai", "anthropic", "google", "gemini", "meta", "mistralai", "xai", "qwen", "moonshot", "ai21", "cohere", "perplexity"]);
const OFFICIAL_OR_PREFIXES = new Set(["openai", "anthropic", "google", "meta", "mistralai", "deepseek", "z-ai", "qwen", "moonshotai", "x-ai"]);

function putBest(map, key, rec, name) {
  const prev = map.get(key);
  if (!prev || rec.tier > prev.tier) map.set(key, { ...rec, name: name || key });
  else if (rec.tier === prev.tier && !prev.name.includes("/")) map.get(key).name = name || prev.name; // 同级保留带厂商的展示名
}

// LiteLLM model_prices_and_context_window.json：{ "zai/glm-5.3": { input_cost_per_token, output_cost_per_token, … } }
export function normalizeLitellm(raw) {
  const out = new Map();
  for (const [k, v] of Object.entries(raw || {})) {
    if (!v || typeof v !== "object") continue;
    if (v.input_cost_per_token == null || v.output_cost_per_token == null) continue;
    const i = Number(v.input_cost_per_token), o = Number(v.output_cost_per_token);
    if (!Number.isFinite(i) || !Number.isFinite(o) || (i <= 0 && o <= 0)) continue;
    const slash = k.indexOf("/");
    const vendor = slash > 0 ? k.slice(0, slash) : guessVendor(k);
    const bare = normKey(k);
    if (!bare) continue;
    const tier = slash > 0 && !OFFICIAL_LITELLM_PREFIXES.has(vendor) ? 1 : 2;
    putBest(out, bare, { in: pm(i), out: pm(o), cur: "USD", vendor, tier }, k);
  }
  return out;
}
// OpenRouter /api/v1/models：{ data: [{ id: "z-ai/glm-5.3", pricing: { prompt, completion, … } }] }
export function normalizeOpenRouter(raw) {
  const out = new Map();
  for (const m of (raw && raw.data) || []) {
    const id = String(m && m.id || "");
    if (!id || id.includes(":")) continue; // 跳过 :batch/:free/:nitro 变体
    if (!m.pricing || m.pricing.prompt == null || m.pricing.completion == null) continue;
    const i = Number(m.pricing.prompt), o = Number(m.pricing.completion);
    if (!Number.isFinite(i) || !Number.isFinite(o) || (i <= 0 && o <= 0)) continue;
    const slash = id.indexOf("/");
    const vendor = slash > 0 ? id.slice(0, slash) : guessVendor(id);
    const bare = normKey(id);
    if (!bare) continue;
    const tier = slash > 0 && !OFFICIAL_OR_PREFIXES.has(vendor) ? 1 : 2;
    putBest(out, bare, { in: pm(i), out: pm(o), cur: "USD", vendor, tier }, id);
  }
  return out;
}
const pm = (perToken) => Math.round(perToken * 1e6 * 1e6) / 1e6; // 每百万价（$），6 位小数内取整避免浮点尾差
function guessVendor(key) {
  const f = familyOf(tokenize(key));
  return { glm: "zai", openai: "openai", anthropic: "anthropic", deepseek: "deepseek", google: "google", qwen: "qwen", moonshot: "moonshot", xai: "xai", meta: "meta", mistral: "mistral" }[f] || "";
}

/* ---- 目录合并与推荐 ---- */
export function mergeCatalog(cacheSources) {
  // 同键去重优先级：内置（官方 CNY 参考）> litellm > openrouter
  const merged = new Map();
  const add = (key, rec, source) => {
    const prev = merged.get(key);
    if (prev && prev.source !== "builtin" && source === "builtin") { merged.set(key, { ...rec, source }); return; }
    if (!prev) merged.set(key, { ...rec, source });
  };
  for (const [key, rec] of Object.entries(PRICES_BUILTIN)) add(key, { ...rec, tier: 2 }, "builtin");
  for (const source of ["litellm", "openrouter"]) {
    for (const [key, rec] of Object.entries((cacheSources || {})[source] || {})) add(key, rec, source);
  }
  return merged;
}
export function toCny(entry, usdCny) {
  const rate = entry.cur === "USD" ? (Number(usdCny) || 7.2) : 1;
  const r4 = (n) => Math.round(n * rate * 1e4) / 1e4;
  return [r4(entry.in), r4(entry.out)];
}
/* 给本地模型推荐目录条目（top n，按 置信 > 官方tier > 来源优先级 排序） */
export function recommendFor(localModel, catalog, usdCny, n = 3) {
  const norm = normKey(localModel);
  const prio = { builtin: 3, litellm: 2, openrouter: 1 };
  return [...catalog.entries()]
    .map(([key, rec]) => ({ key, ...rec, score: matchScore(norm, key) }))
    .filter((r) => r.score >= 0.5)
    .sort((a, b) => b.score - a.score || b.tier - a.tier || (prio[b.source] || 0) - (prio[a.source] || 0))
    .slice(0, n)
    .map((r) => ({ key: r.key, name: r.name || r.key, source: r.source, vendor: r.vendor || "", tier: r.tier, cur: r.cur, in: r.in, out: r.out, note: r.note || "", price_cny: toCny(r, usdCny), confidence: Math.round(r.score * 100) }));
}
