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
  try { localStorage.setItem("glm-theme", t); } catch(e){}
}
var themeRot = 0;
function toggleTheme(){
  themeRot += 180;
  var svg = document.querySelector("#themebtn svg");
  if (svg) svg.style.transform = "rotate(" + themeRot + "deg)";
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
}
function cnum(n){
  if (n == null) return "—";
  if (n >= 1e8) return (n/1e8).toFixed(1) + "亿";
  if (n >= 1e6) return (n/1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n/1e3).toFixed(1) + "k";
  return String(Math.round(n));
}
function durMs(ms){
  if (ms == null) return "—";
  if (ms >= 3600000) return Math.floor(ms/3600000) + "h" + Math.round(ms%3600000/60000) + "m";
  if (ms >= 60000) return Math.floor(ms/60000) + "m" + Math.round(ms%60000/1000) + "s";
  if (ms >= 1000) return (ms/1000).toFixed(1) + "s";
  return Math.round(ms) + "ms";
}
function agoTs(ts){
  if (!ts) return "—";
  var d = Date.now() - ts;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return Math.floor(d/60000) + " 分钟前";
  if (d < 86400000) return Math.floor(d/3600000) + " 小时前";
  return new Date(ts).toLocaleDateString("zh-CN");
}

/* ---- 光带骨架屏（SK）：与各区块最终布局同构的加载占位。骨架复用真实内容的 class/网格，
   加载期与数据期同尺寸；数据到位由 patchElement 原位替换（首载不重排、不闪烁）。
   光带为纯 transform 动画且有限次（~25s 后静止，失败态不无限闪）；行内 --sk-d 做波次错峰 ---- */
var SK = (function () {
  function b(w, h, i, x) {
    return '<i class="sk' + (x ? " " + x : "") + '" style="width:' + w + ";height:" + h
      + ";--sk-d:" + ((i || 0) * 0.09).toFixed(2) + 's"></i>';
  }
  function quota(i, full) { /* 套餐配额区：head + meter + 用量行（full 含速率行与走势） */
    return '<div class="quotaSection">'
      + '<div class="quotaHead">' + b("36%", "13px", i) + b("24%", "13px", i) + "</div>"
      + '<div class="meter"><i class="sk" style="width:46%;height:100%;--sk-d:' + ((i + 1) * 0.09).toFixed(2) + 's"></i></div>'
      + '<div class="qLine">' + b("64%", "10px", i + 2) + "</div>"
      + (full ? '<div class="qLine">' + b("46%", "10px", i + 3) + "</div>" + '<div class="sparkBox spark">' + b("100%", "38px", i + 4) + "</div>" : "")
      + "</div>";
  }
  var R = {
    hero: function () {
      return '<section class="card hero"><div class="heroHead">' + b("170px", "26px", 0) + b("58px", "20px", 1) + b("150px", "14px", 2) + "</div>"
        + '<div class="quotaWrap" id="heroWrap">' + quota(1, true) + quota(5, true) + "</div></section>";
    },
    plans: function () {
      function card(i) {
        return '<section class="card plan"><h3>' + b("40%", "14px", i) + b("52px", "16px", i) + "</h3>"
          + '<div class="life">' + b("56%", "11px", i) + "</div>"
          + '<div class="pwrap">' + quota(i, false) + "</div></section>";
      }
      return card(0) + card(3);
    },
    kpis: function () {
      return [0, 1, 2, 3, 4, 5].map(function (i) {
        return '<div class="kpi">' + b("38%", "11px", i) + b("56%", "22px", i) + b("76%", "12px", i) + "</div>";
      }).join("");
    },
    daily: function () { /* 与真实日图同构：左右轴 + 7 组幽灵柱（Token 三段 + 费用柱） */
      var hs = [42, 58, 36, 66, 50, 78, 60];
      return '<div class="dailyAxis">' + [0, 1, 2, 3, 4].map(function (i) { return b("30px", "9px", i); }).join("") + "</div>"
        + '<div class="dailyPlot">' + hs.map(function (h, i) {
          return '<span class="col"><span class="pair"><span class="bar"><i class="skFlat" style="height:' + h + '%"></i></span><span class="bar cost"><i class="skFlat" style="height:' + Math.round(h * .5) + '%"></i></span></span></span>';
        }).join("") + "</div>"
        + '<div class="dailyAxis costAxis">' + [0, 1, 2, 3, 4].map(function (i) { return b("34px", "9px", i); }).join("") + "</div>";
    },
    donut: function (n) {
      var rows = "";
      for (var i = 0; i < n; i++) rows += '<span class="lgRow">' + b("8px", "8px", i) + b("34%", "10px", i) + b("38px", "10px", i) + b("44px", "10px", i) + "</span>";
      return '<div class="donutWrap"><i class="sk skCircle" style="width:118px;height:118px"></i><div class="legendGrid">' + rows + "</div></div>";
    },
    barList: function (n) {
      var rows = "";
      for (var i = 0; i < n; i++) rows += '<span class="barRow">' + b("7px", "7px", i) + b(30 + (i * 13) % 42 + "%", "10px", i) + b("26px", "10px", i) + "</span>";
      return rows;
    },
    heat: function () { /* 周列同构：静态格 + 每列一条光带 */
      var wds = ""; for (var i = 0; i < 7; i++) wds += '<span class="hwd"></span>';
      var cols = "";
      for (var c = 0; c < 8; c++) {
        var cells = ""; for (var r = 0; r < 7; r++) cells += '<span class="hcell"></span>';
        cols += '<div class="hcol skCol" style="--sk-d:' + (c * 0.12).toFixed(2) + 's">' + cells + "</div>";
      }
      return '<div class="hwds">' + wds + '</div><div class="hcols">' + cols + "</div>";
    },
    sessions: function () {
      function card(i) {
        return '<div class="sCard" style="min-height:170px">'
          + '<div class="sHead">' + b("58%", "14px", i) + b("64px", "22px", i) + "</div>"
          + '<div class="sCrumb">' + b("76px", "17px", i + 1) + b("52px", "17px", i + 1) + "</div>"
          + '<div class="sBody"><i class="sk skCircle" style="width:76px;height:76px;flex:none"></i><div class="sStats">' + b("86%", "11px", i + 2) + b("70%", "11px", i + 2) + b("78%", "11px", i + 2) + "</div></div>"
          + '<div class="sPreview">' + b("44px", "10px", i + 3) + b("64%", "10px", i + 3) + "</div></div>";
      }
      return [0, 1, 2, 3, 4, 5].map(card).join("");
    },
    groups: function () {
      var out = ""; for (var i = 0; i < 3; i++) out += '<span class="gchip">' + b("48px", "10px", i) + "</span>";
      return out;
    },
    ctxStats: function () {
      var cells = ""; for (var i = 0; i < 4; i++) cells += '<div class="csCell">' + b("60%", "17px", i) + b("44%", "10px", i) + "</div>";
      var rows = ""; for (var j = 0; j < 4; j++) rows += '<div><div class="csRow">' + b("34%", "12px", j + 5) + b("40px", "12px", j + 5) + '</div><div class="chipRow">' + b("76px", "14px", j + 5) + b("60px", "14px", j + 6) + b("88px", "14px", j + 6) + "</div></div>";
      return '<div class="csKpis">' + cells + '</div><div class="csEvents">' + b("72%", "11px", 4) + '</div><div class="csRows">' + rows + "</div>";
    },
    ctxInfo: function () {
      var rows = ""; for (var i = 0; i < 8; i++) rows += '<div class="row">' + b("52px", "11px", i) + b("46%", "11px", i) + "</div>";
      return rows;
    },
    trend: function () { return '<i class="sk" style="height:230px"></i><div class="trendHint">' + b("30%", "10px", 2) + "</div>"; },
    events: function () {
      var rows = ""; for (var i = 0; i < 5; i++) rows += '<span class="evRow">' + b("14px", "14px", i) + b("44px", "14px", i) + b("52%", "11px", i) + b("40px", "10px", i) + "</span>";
      return rows;
    },
    browser: function () {
      function cat(i) {
        return '<section class="brCat"><div class="brCatHead">' + b("12px", "12px", i) + b("10px", "10px", i) + b("34%", "12px", i) + b("48px", "10px", i) + b("34px", "10px", i) + "</div></section>";
      }
      return '<div class="brCats">' + cat(0) + cat(1) + cat(2) + cat(3) + "</div>";
    },
    fleetStats: function () {
      var out = ""; for (var i = 0; i < 4; i++) out += '<div class="st">' + b("56%", "18px", i) + b("64%", "10px", i) + "</div>";
      return out;
    },
    fleetTree: function () {
      function card(i) {
        return '<div class="agentCard"><div class="ah">' + b("8px", "8px", i) + b("52%", "12px", i) + b("46px", "16px", i) + "</div>"
          + '<div class="am">' + b("64%", "10px", i + 1) + "</div>"
          + '<div class="agentValue">' + b("70%", "24px", i + 1) + "</div>"
          + '<div class="abar"><i class="skFlat" style="height:100%;width:52%"></i></div>'
          + '<div class="af">' + b("44%", "10px", i + 2) + b("44%", "10px", i + 2) + "</div></div>";
      }
      return '<div class="treeBranch treeRoot">' + card(0) + '<div class="treeKids"><div class="treeBranch">' + card(2) + '</div><div class="treeBranch">' + card(4) + "</div></div></div>";
    },
    members: function () {
      var rows = "";
      for (var i = 0; i < 4; i++) rows += '<span class="fleetRow"><i class="sk skCircle" style="width:30px;height:30px;flex:none"></i>'
        + '<span class="fleetInfo">' + b("46%", "13px", i) + b("66%", "10px", i) + "</span>"
        + '<span class="fleetCtx">' + b("100%", "10px", i) + '<span class="bar"><i class="skFlat" style="height:100%;width:40%"></i></span></span></span>';
      return rows;
    },
    comms: function () {
      var rows = "";
      for (var i = 0; i < 3; i++) rows += '<span class="commsRow">' + b("40px", "16px", i) + '<span class="cBody">' + b("82%", "12px", i) + b("58%", "10px", i) + "</span>" + b("7px", "7px", i, "skCircle") + "</span>";
      return rows;
    },
    inspector: function () {
      var cells = ""; for (var i = 0; i < 4; i++) cells += "<span>" + b("56%", "10px", i + 2) + b("64%", "12px", i + 2) + "</span>";
      return '<div class="agentInspectorHead"><div>' + b("44px", "10px", 0) + b("58%", "13px", 0) + "</div>" + b("86px", "12px", 1) + "</div>"
        + '<div class="stepMetrics">' + cells + "</div>"
        + '<div class="stepNote">' + b("76%", "10px", 6) + "</div>";
    }
  };
  var MAP = { /* detailBody/healthBody 不在此列：由 ensureDetailSkeleton/ensureHealthSkeleton 负责（同结构骨架+原位补值，含真实标签） */
    hero: R.hero, plans: R.plans,
    insKpis: R.kpis, insDailyChart: R.daily,
    insTokensBody: function () { return R.donut(5); }, ctxTokensBody: function () { return R.donut(5); },
    insTimingBody: function () { return R.donut(3); }, ctxTimingBody: function () { return R.donut(3); },
    insHeatGrid: R.heat, insSkillsList: function () { return R.barList(6); }, insToolsList: function () { return R.barList(6); }, insCmdsList: function () { return R.barList(6); },
    insSessions: R.sessions, sessGroups: R.groups,
    ctxStats: R.ctxStats, ctxInfo: R.ctxInfo, ctxTrend: R.trend, trendLegend: function () { return b("46%", "10px", 0); },
    ctxEvents: R.events, ctxBrowser: R.browser,
    fleetStats: R.fleetStats, fleetNodes: R.fleetTree, fleetMembers: R.members,
    fleetComms: R.comms, fleetWork: R.comms, agentInspector: R.inspector
  };
  return {
    region: function (id) { return MAP[id] ? MAP[id]() : null; },
    /* 启动即挂载：各标签页首次进入数据未到时直接呈现同构骨架（不等待 bridge-ready） */
    mountAll: function () {
      Object.keys(MAP).forEach(function (id) {
        var el = document.getElementById(id), html = SK.region(id);
        if (el && html) { el.innerHTML = html; el.dataset.sk = "1"; }
      });
      var strip = document.getElementById("browserStrip");
      if (strip) strip.innerHTML = '<i class="sk" style="flex:1;height:100%"></i>';
      /* 使用详情/健康度：铺 ensure*Skeleton 的同结构骨架（真实标签 + 占位值，数据到达原位补值） */
      var db = document.getElementById("detailBody"); if (db) ensureDetailSkeleton(db);
      var hb = document.getElementById("healthBody"); if (hb) ensureHealthSkeleton(hb);
    }
  };
})();

/* ---- dsh 同构环形图：42 viewBox / r15.9155 / stroke4 / 字号随尺寸缩放 / 中心省略 ---- */
var SEG_GAP = 0.5;
function monotonePath(xy) {
  if (xy.length < 3) return "M" + xy.map(function(q){ return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" L");
  var n = xy.length, m = new Array(n), d = new Array(n - 1), i;
  for (i = 0; i < n - 1; i++) d[i] = (xy[i + 1][1] - xy[i][1]) / (xy[i + 1][0] - xy[i][0]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
  for (i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    var a = m[i] / d[i], b = m[i + 1] / d[i], sq = a * a + b * b;
    if (sq > 9) { var t = 3 / Math.sqrt(sq); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
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
/* ---- 平滑曲线 ---- */
function downsample(pts, n) {
  if (!pts || pts.length <= n) return pts || [];
  var out = [], step = (pts.length - 1) / (n - 1);
  for (var i = 0; i < n; i++) out.push(pts[Math.round(i * step)]);
  return out;
}
function smoothPath(xy) {
  if (!xy.length) return "";
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
function sparkline(pts, color, key) {
  if (!pts || pts.length < 2) return '<div class="sparkCap"><span>走势将随采样积累显示（本机定时记录已用量）</span></div>';
  var W = 224, H = 26, pad = 3, pp = downsample(pts, 90);
  var vs = pp.map(function(p){ return p[1]; });
  var t0 = pp[0][0], t1 = pp[pp.length - 1][0], v0 = Math.min.apply(null, vs), v1 = Math.max.apply(null, vs);
  if (v1 === v0) v1 = v0 + 1;
  if (t1 === t0) t1 = t0 + 1;
  var xy = pp.map(function(p){ return [pad + (p[0] - t0) / (t1 - t0) * (W - pad * 2), H - pad - (p[1] - v0) / (v1 - v0) * (H - pad * 2)]; });
  var line = monotonePath(xy);
  var area = line + " L" + (W - pad) + "," + (H - pad) + " L" + pad + "," + (H - pad) + " Z";
  var gid = "sg" + Math.abs(hash(String(key || "usage")));
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

/* ---- 用量页 ---- */
var built = { hero: false, heroErr: null, planN: -1, spark: {} };
function sectionHTML(b) {
  return '<div class="quotaSection">'
    + '<div class="quotaHead"><span class="qLabel">' + esc(b.label || b.show_name || "") + '</span>'
    + '<span class="qMeta"><span class="qPct"></span><span class="qReset"></span></span></div>'
    + '<div class="meter"><i style="width:0%"></i></div>'
    + '<div class="qLine l1"></div><div class="qLine l2"></div><div class="sparkBox spark"></div></div>';
}
function patchSection(el, b, l1html, l2html, sparkHtml, sparkKey) {
  if (!el) return;
  var pct = el.querySelector(".qPct"), reset = el.querySelector(".qReset"),
      bar = el.querySelector(".meter > i"), l1 = el.querySelector(".l1"),
      l2 = el.querySelector(".l2"), sb = el.querySelector(".sparkBox");
  // 首次补丁：先渲染 0% 再放行过渡，让进度条有从零增长的首载动画（之后刷新为平滑过渡到新值）
  if (el.dataset.mInit !== "1" && bar) {
    el.dataset.mInit = "1";
    bar.style.transition = "none";
    bar.style.width = "0%";
    void bar.offsetWidth;
    bar.style.transition = "";
  }
  el.querySelector(".qLabel").textContent = b.label || b.show_name || "";
  pct.textContent = b.percent + "%";
  pct.style.color = lvColor(b.percent);
  reset.hidden = !b.reset_at;
  reset.textContent = "重置 " + (b.reset_at ? until(b.reset_at, true) + "后" : "—");
  reset.className = "qReset" + (b.reset_at && b.reset_at - Math.floor(Date.now() / 1000) < 1800 ? " soon" : "");
  if (bar.dataset.pct !== String(b.percent)) {
    bar.style.width = b.percent + "%";
    bar.dataset.pct = String(b.percent);
    bar.classList.remove("sweep"); void bar.offsetWidth; bar.classList.add("sweep"); // 刷新扫光
  }
  bar.className = lvClass(b.percent) + (bar.classList.contains("sweep") ? " sweep" : "");
  if (l1) patchElement(l1, l1html);
  if (l2) patchElement(l2, l2html || "");
  if (sb && built.spark[sparkKey] !== sparkHtml) { built.spark[sparkKey] = sparkHtml; patchElement(sb, sparkHtml); }
}
var usageLoading = false;
async function load() {
  if (usageLoading) return;
  usageLoading = true;
  var err = document.getElementById("err");
  err.style.display = "none";
  try {
    var r = await window.__bridgeCall("tools/call", { name: "get_usage_json", arguments: {} });
    var j = JSON.parse(r.content[0].text);
    if (!j.ok) throw new Error(j.error || "未知错误");
    var d = j.data;
    tick = REFRESH;
    document.getElementById("dot").className = "dot";

    var hero = document.getElementById("hero");
    var cp = d.coding_plan;
    if (cp && !cp.error) {
      var rates = d.rates || {}, hist = d.history || {};
      if (built.heroErr !== null) { hero.innerHTML = ""; built.heroErr = null; }
      if (!built.hero) {
        hero.innerHTML = '<section class="card hero" style="--delay:0ms">'
          + '<div class="heroHead"><span class="providerPill"><i></i>GLM Coding Plan</span>'
          + '<span class="levelPill" id="cpLevel"></span>'
          + '<span class="heroStatus">付费编程套餐 · bigmodel.cn</span></div>'
          + '<div class="quotaWrap" id="heroWrap"></div></section>';
        built.hero = true;
        animateSwap(hero); /* 骨架→内容首次落位轻柔沉降 */
      }
      document.getElementById("cpLevel").textContent = esc(cp.level).toUpperCase();
      var wrap = document.getElementById("heroWrap");
      if (wrap.children.length !== cp.limits.length) wrap.innerHTML = cp.limits.map(sectionHTML).join("");
      cp.limits.forEach(function (b, i) {
        patchSection(wrap.children[i], b,
          "已用 <b>" + fmt(b.used) + "</b> / " + fmt(b.total) + '<span class="sep">·</span>剩余 <b>' + fmt(b.remaining) + "</b>",
          etaParts(b, rates[b.id]),
          sparkline(hist[b.id], lvColor(b.percent), b.id), b.id);
      });
    } else if (cp && cp.error) {
      if (built.heroErr !== cp.error) {
        built.hero = false; built.heroErr = cp.error; built.spark = {};
        hero.innerHTML = '<section class="card hero"><div class="heroHead"><span class="providerPill"><i></i>GLM Coding Plan</span></div><div class="quotaSection"><span class="qLine">⚠ ' + esc(cp.error) + "</span></div></section>";
      }
    } else { hero.innerHTML = ""; built.hero = false; }

    var box = document.getElementById("plans");
    if (!d.plans.length && !d.buckets.length) {
      if (!built.emptyPlans) { box.innerHTML = '<div class="empty">无其他生效套餐</div>'; built.emptyPlans = true; built.planN = -1; }
    } else {
      built.emptyPlans = false;
      if (built.planN !== d.plans.length) {
        box.innerHTML = d.plans.map(function (p, pi) {
          return '<section class="card plan" style="--delay:' + (60 + pi * 60) + 'ms">'
            + '<h3><span class="pname"></span> <span class="badge"></span>'
            + (p.description ? '<span class="badge pdesc">' + esc(p.description) + "</span>" : "")
            + "</h3>" + '<div class="life"></div><div class="pwrap"></div></section>';
        }).join("");
        built.planN = d.plans.length;
      }
      d.plans.forEach(function (p, pi) {
        var card = box.children[pi];
        if (!card) return;
        /* 待生效判定：套餐期已开始（status=active）但权益 effective_at 未到且 balances 尚无用量桶 */
        var nowSec = Math.floor(Date.now() / 1000);
        var effs = (p.entitlements || []).map(function (e) { return e.effective_at; }).filter(function (t) { return typeof t === "number" && t; });
        var bucketed = d.buckets.some(function (b) { return b.plan_id === p.plan_id; });
        var pendingAt = (!bucketed && effs.length && Math.min.apply(null, effs) > nowSec) ? Math.min.apply(null, effs) : null;
        var st = card.querySelector(".badge");
        st.className = "badge " + (pendingAt ? "pending" : p.status);
        st.textContent = pendingAt ? "待生效" : p.status === "active" ? "生效中" : p.status === "expired" ? "已到期" : esc(p.status);
        card.querySelector(".pname").textContent = p.name;
        var entitlementText = (p.entitlements || []).map(function (e) {
          return e.show_name + " " + fmtK(e.grant_units) + (e.unit_type === "token" || !e.unit_type ? " tokens" : " " + e.unit_type);
        }).join(" · ");
        card.querySelector(".life").textContent = pendingAt
          ? entitlementText + " · " + new Date(pendingAt * 1000).toLocaleString("zh-CN") + " 起生效 · 有效期至 " + (p.ends_at ? new Date(p.ends_at * 1000).toLocaleString("zh-CN") : "长期") + " · 剩 " + until(p.ends_at)
          : "有效期至 " + (p.ends_at ? new Date(p.ends_at * 1000).toLocaleString("zh-CN") : "长期") + " · 剩 " + until(p.ends_at);
        var buckets = d.buckets.filter(function (b) { return b.plan_id === p.plan_id; });
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
  } finally { usageLoading = false; }
}

/* ================= 洞察 / 上下文 / Agent ================= */
var CAT_COLORS = { system_prompt:"var(--c-sys)", tool_schemas:"var(--c-schema)", user_messages:"var(--c-user)", injected:"var(--c-inject)", skill:"var(--c-skill)", assistant:"var(--c-asst)", tool_results:"var(--c-tool)" };
var CAT_HEX = { system_prompt:"#6366f1", tool_schemas:"#f59e0b", user_messages:"#22c55e", injected:"#a855f7", skill:"#f97316", assistant:"#3b82f6", tool_results:"#14b8a6" };
var state = {
  tab: "usage", range: "7d", insights: null, insightsAt: 0,
  sessions: [], sortKey: "updated", search: "", group: "",
  sessionId: null, ctx: null, browser: null, dna: "tree", trendMode: "total",
  fleet: null, trendSel: -1, lastActivity: 0, silent: false,
  expanded: new Set(), catPick: null, browserQuery: "", snapshot: "live", archive: "", day: null, trendKey: null, inspectorId: null, heatMode: "tokens", pick: null,
  sessPage: 1, sessPageFor: null, commsKind: "all", workPhase: "all"
};
function callTool(name, args) {
  return window.__bridgeCall("tools/call", { name: name, arguments: args || {} }).then(function (r) {
    var j = JSON.parse(r.content[0].text);
    if (!j.ok) throw new Error(j.error || "未知错误");
    return j.data;
  });
}
function animateSwap(el) { if (!el) return; el.classList.remove("swapAnim"); void el.offsetWidth; el.classList.add("swapAnim"); }
function showErr(id, msg) {
  var el = document.getElementById(id);
  if (msg) { el.textContent = msg; el.style.display = "block"; } else el.style.display = "none";
}
/* 平滑 DOM：内容没变就不动（实时刷新不闪烁、滚动位置不丢）；返回是否真的更新 */
function patchHTML(id, html) { return patchElement(document.getElementById(id), html); }
function patchElement(el, html) {
  if (!el || el._sourceHTML === html) return false;
  el._sourceHTML = html;
  var template = document.createElement('template');
  var svg = el.namespaceURI === 'http://www.w3.org/2000/svg';
  template.innerHTML = svg ? '<svg>' + html + '</svg>' : html;
  morphChildren(el, svg ? template.content.firstElementChild : template.content);
  if (window.restoreHover) restoreHover(el);
  /* 骨架首载落位：真实内容替换骨架时轻柔沉降一下（仅一次，实时刷新不受影响） */
  if (el.dataset && el.dataset.sk) { delete el.dataset.sk; animateSwap(el); }
  return true;
}

/* ---------- 实时刷新（跟随对话进度：会话活跃时秒级，空闲时降频） ---------- */
var liveTimer = null;
function sessionActive() {
  // 当前会话 3 分钟内有更新视为活跃（model-io 尾部解析 / 会话 updated 均会刷新该值）
  return state.lastActivity && (Date.now() - state.lastActivity < 3 * 60000);
}
function liveInterval(base) { return sessionActive() ? base : base * 6; }
function stopLive() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}
function startLive() {
  stopLive();
  if (state.tab === "context") {
    liveTimer = setInterval(function () {
      if (document.hidden || !state.sessionId) return;
      if (Date.now() - (state.contextAt || 0) >= liveInterval(2200)) loadContext(true);
      if (!liveBrowserAt || Date.now() - liveBrowserAt > liveInterval(4000)) { liveBrowserAt = Date.now(); loadBrowser(true); }
    }, 2200);
  } else if (state.tab === "insights") {
    liveTimer = setInterval(function () {
      if (document.hidden) return;
      if (Date.now() - state.insightsAt < liveInterval(6000)) return;
      loadInsights(true);
    }, 2000);
  } else if (state.tab === "agent") {
    liveTimer = setInterval(function () {
      if (document.hidden) return;
      if (Date.now() - (state.fleetAt || 0) < liveInterval(5000)) return;
      ensureFleet(true);
    }, 2000);
  }
}
var liveBrowserAt = 0;

/* ---------- 标签页 ---------- */
document.getElementById("tabs").addEventListener("click", function (ev) {
  var b = ev.target.closest("button[data-tab]");
  if (!b) return;
  switchTab(b.dataset.tab);
});
function switchTab(tab) {
  if (window.hideTip) hideTip();
  var topright = document.querySelector(".topright"); if (topright) topright.hidden = false; /* 视图恢复前隐藏启动控件，恢复后随首次 switchTab 显示 */
  const changed = state.tab !== tab;
  state.tab = tab;
  document.getElementById('countdown').textContent = tab === 'usage' ? (REFRESH ? tick + ' 秒后刷新' : '刷新已暂停') : '自动同步';
  state.hoverCat = null; state.trendHover = null; state.agentHover = null;
  stopLive();
  document.getElementById("refreshsel").closest(".selectbox").hidden = tab !== "usage";
  document.querySelectorAll("#tabs button").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === tab); b.setAttribute("aria-selected", b.dataset.tab === tab); b.tabIndex = b.dataset.tab === tab ? 0 : -1; });
  document.querySelectorAll(".tabpage").forEach(function (p) { p.hidden = p.id !== "tab-" + tab; });
  if (changed) animateSwap(document.getElementById("tab-" + tab));
  if (tab === "usage") refreshUsage();
  if (tab === "insights") { ensureInsights(); startLive(); }
  if (tab === "context") { ensureContext(); startLive(); }
  if (tab === "agent") { ensureFleet(); startLive(); }
}

/* ---------- 洞察页 ---------- */
document.getElementById("rangeBar").addEventListener("click", function (ev) {
  var b = ev.target.closest("button[data-r]");
  if (!b) return;
  state.range = b.dataset.r; state.day = null; state.pick = null;
  document.querySelectorAll("#rangeBar button").forEach(function (x) { x.classList.toggle("on", x === b); });
  loadInsights();
});
document.getElementById("sessSort").addEventListener("click", function (ev) {
  var b = ev.target.closest("button[data-k]");
  if (!b) return;
  state.sortKey = b.dataset.k;
  document.querySelectorAll("#sessSort button").forEach(function (x) { x.classList.toggle("on", x === b); });
  renderSessions();
});
document.getElementById("insHeatMetric").addEventListener("click", function (ev) {
  var b = ev.target.closest("button[data-m]");
  if (!b) return;
  state.heatMode = b.dataset.m;
  document.querySelectorAll("#insHeatMetric button").forEach(function (x) { x.classList.toggle("on", x === b); });
  renderHeatmap(state.insights);
});
/* 排行行筛选联动（对齐 dsh：单击行 → 筛选下方会话列表，再次单击取消；双击 → 明细弹窗）
   渲染纪律：行高亮只 toggle class、chip 直接更新，列表只在拿到会话集后重排一次，避免二次跳动 */
function setInsightDay(day) {
  state.day = day;
  const pick = state.pick;
  state.pick = null;
  if (pick) togglePick(pick.kind, pick.name);
  if (state.insights) { renderDaily(state.insights); renderHeatmap(state.insights); }
  loadInsights();
}
function markPickRows() {
  document.querySelectorAll("#insSkillsList .barRow, #insToolsList .barRow, #insCmdsList .barRow").forEach(function (row) {
    var on = !!state.pick && row.dataset.activity === state.pick.kind && row.dataset.pick === state.pick.name;
    row.classList.toggle("on", on);
    row.setAttribute("aria-pressed", String(on));
  });
}
function updatePickChip() {
  var chip = document.getElementById("pickChip");
  if (!chip) return;
  chip.hidden = !state.pick;
  if (state.pick) chip.textContent = ({ tools: "工具 ", commands: "命令 ", skills: "技能 " }[state.pick.kind] || "") + state.pick.name + (state.pick.sessions == null ? " …" : " ×");
}
function clearPick() { state.pick = null; markPickRows(); updatePickChip(); renderSessions(); }
function togglePick(kind, name) {
  if (state.pick && state.pick.kind === kind && state.pick.name === name) { clearPick(); return; }
  const pick = state.pick = { kind: kind, name: name, sessions: null };
  markPickRows(); updatePickChip();
  callTool("get_activity", { kind: kind, range: state.range, ...(state.day ? { day: state.day } : {}), pick: name }).then(function (data) {
    if (state.pick !== pick) return;
    state.pick.sessions = new Set((data || {}).session_ids || []);
    renderSessions();
  }).catch(function () {
    if (state.pick === pick) clearPick();
  });
}
["insSkillsList", "insToolsList", "insCmdsList"].forEach(function (id) {
  var box = document.getElementById(id);
  box.addEventListener("click", function (ev) {
    var row = ev.target && ev.target.closest ? ev.target.closest(".pickRow") : null;
    if (!row) return;
    togglePick(row.dataset.activity, row.dataset.pick);
  });
});
document.getElementById("sessSearch").addEventListener("input", function (ev) {
  state.search = ev.target.value.trim().toLowerCase();
  renderSessions();
});
function ensureInsights() {
  if (!state.insights || Date.now() - state.insightsAt > 60000) loadInsights();
  else { renderInsights(); renderSessions(); }
}
var requestTickets = { insights: 0, context: 0, browser: 0, fleet: 0 };
var inFlight = {};
async function loadInsights(silent) {
  if (silent && inFlight.insights) return;
  var ticket = ++requestTickets.insights, range = state.range, day = state.day;
  inFlight.insights = true;
  if (!silent) { showErr('insErr', null); setBusy('tab-insights', true); }
  try {
    var data = await callTool('get_insights', { range: range, ...(day ? { day } : {}) });
    if (ticket !== requestTickets.insights || range !== state.range || day !== state.day) return;
    state.insights = data; state.insightsAt = Date.now();
    state.sessions = data.sessions || [];
    invalidateDaySessions(); /* get_insights 刷新：当日会话集缓存整体失效，随后的 renderSessions 按需经 get_day_sessions 重建 */
    renderInsights(); fillSessionSelect(); renderSessions();
    if (!silent) animateSwap(document.getElementById('insKpis'));
    showErr('insErr', null);
  } catch (e) { if (ticket === requestTickets.insights) showErr('insErr', '洞察获取失败：' + e.message); }
  finally { if (ticket === requestTickets.insights) { inFlight.insights = false; setBusy('tab-insights', false); } }
}
function renderInsights() {
  var d = state.insights; if (!d) return;
  document.getElementById("dayScope").innerHTML = d.day ? '<button class="gchip on" data-clear-day>日期 ' + esc(d.day) + ' ×</button> <button class="textButton" data-show-sessions>查看匹配会话 ↓</button>' : '';
  var k = d.kpis;
  // KPI（3×2，对齐 dsh 总览）
  var kpis = [
    { l: "全部会话", v: k.sessions, s: "其中归档 " + k.archived + " 个", dim: false },
    { l: "Token 消耗", v: cnum(k.tokens), s: "轮次 " + k.turns, dim: false },
    k.cost != null
      ? { l: "预估费用", v: "¥" + (Math.round(k.cost * 100) / 100), s: "已计价 · 按 prices 配置", dim: false }
      : { l: "预估费用", v: "—", s: "已计价 " + (k.priced_models || 0) + " / " + (k.total_models || 0) + " 个模型 · 点击配置", dim: true },
    { l: "缓存命中", v: k.cache_hit + "%", s: "含 " + k.sessions + " 个会话", dim: false },
    { l: "工具调用", v: k.tool_calls, s: "工具执行 " + durMs(k.tool_ms), dim: false },
    { l: "活跃时长", v: durMs(k.active_ms), s: "模型调用 " + k.steps, dim: false },
  ];
  patchHTML("insKpis", kpis.map(function (x, i) {
    return '<button class="kpi" data-kpi="' + i + '" data-tip="' + esc(x.s) + '"><div class="kl">' + x.l + '</div>'
      + '<div class="kv' + (x.dim ? " dim2" : "") + '">' + x.v + '</div><div class="ks">' + x.s + "</div></button>";
  }).join(""));
  document.getElementById("insCacheSub").textContent = "缓存读 " + cnum(k.cache_read) + " · 写 " + cnum(k.cache_write);
  renderDaily(d);
  // Token 统计环形（缓存读/写 + 新输入，输出拆为思考/回复，对齐 dsh 分类口径）
  var tokSegs = [
    { n: "缓存读取", v: k.cache_read, c: "#22c55e" },
    { n: "缓存写入", v: k.cache_write, c: "#a855f7" },
    { n: "新输入", v: Math.max(k.input - k.cache_read - k.cache_write, 0), c: "#3b82f6" },
    { n: "模型思考", v: k.reasoning, c: "#ec4899" },
    { n: "模型回复", v: Math.max(k.output - k.reasoning, 0), c: "#f59e0b" },
  ].filter(function (x) { return x.v > 0; });
  patchHTML("insTokensBody", donutLegendBlock(tokSegs, cnum(k.tokens), "总用量", 108));
  document.getElementById("insTpsSub").textContent = "会话累计 · 输出速度 " + k.tps + " tok/s";
  var timSegs = [
    { n: "模型等待", v: k.ttft_ms, c: "#6366f1", sub: cnum(k.ttft_n) + "次" },
    { n: "模型生成", v: Math.max(k.model_ms - k.ttft_ms, 0), c: "#3b82f6", sub: cnum(k.steps) + "次" },
    { n: "工具执行", v: k.tool_ms, c: "#14b8a6", sub: cnum(k.tool_calls) + "次" },
  ].filter(function (s) { return s.v > 0; });
  patchHTML("insTimingBody", donutLegendBlock(timSegs, durMs(k.active_ms), "活跃时长", 108, true));
  renderHeatmap(d);
  var TOOL_COLORS = ["#f59e0b","#22c55e","#3b82f6","#a855f7","#14b8a6","#6366f1"];
  // 技能加载（对齐 dsh 技能卡）
  var sks = d.skills || [];
  document.getElementById("insSkillsSub").textContent = sks.reduce(function (a, x) { return a + x.calls; }, 0) + " 次加载";
  var maxS = Math.max.apply(null, sks.map(function (x) { return x.calls; }).concat([1]));
  patchHTML("insSkillsList", sks.map(function (x, i) {
    return '<div class="rankActions"><button class="barRow pickRow' + (state.pick && state.pick.kind === "skills" && state.pick.name === x.name ? " on" : "") + '" data-activity="skills" data-pick="' + esc(x.name) + '" title="最近 ' + agoTs(x.last_at) + ' · 单击筛选会话">'
      + '<span class="dot" style="background:' + TOOL_COLORS[i % 6] + '"></span>'
      + '<span class="nm" title="' + esc(x.name) + '">' + esc(x.name) + "</span>"
      + '<span class="ct">×' + x.calls + "</span>"
      + '<span class="tr"><i style="width:' + (x.calls / maxS * 100).toFixed(1) + "%;background:" + TOOL_COLORS[i % 6] + '"></i></span></button><button class="textButton rankDetail" data-activity="skills" data-pick="' + esc(x.name) + '" aria-label="查看 ' + esc(x.name) + ' 明细">明细</button></div>';
  }).join("") || '<span class="empty" style="padding:18px 0">无技能加载记录</span>');
  // 工具
  var tls = d.tools || [];
  document.getElementById("insToolsSub").textContent = tls.length + " 个工具 · " + tls.reduce(function (a, x) { return a + x.calls; }, 0) + " 次调用";
  var maxT = Math.max.apply(null, tls.map(function (x) { return x.calls; }).concat([1]));
  patchHTML("insToolsList", tls.slice(0, 10).map(function (x, i) {
    return '<div class="rankActions"><button class="barRow pickRow' + (state.pick && state.pick.kind === "tools" && state.pick.name === x.name ? " on" : "") + '" data-activity="tools" data-pick="' + esc(x.name) + '" title="耗时 ' + durMs(x.tool_ms) + (x.errors ? " · 失败 " + x.errors : "") + ' · 单击筛选会话">'
      + '<span class="dot" style="background:' + TOOL_COLORS[i % 6] + '"></span>'
      + '<span class="nm">' + esc(x.name) + "</span>"
      + '<span class="ct">×' + x.calls + "</span>"
      + '<span class="tr"><i style="width:' + (x.calls / maxT * 100).toFixed(1) + "%;background:" + TOOL_COLORS[i % 6] + '"></i></span></button><button class="textButton rankDetail" data-activity="tools" data-pick="' + esc(x.name) + '" aria-label="查看 ' + esc(x.name) + ' 明细">明细</button></div>';
  }).join("") || '<span class="empty" style="padding:18px 0">无工具调用</span>');
  // 命令
  var cmds = d.commands || [];
  document.getElementById("insCmdsSub").textContent = cmds.length + " 个程序";
  var maxC = Math.max.apply(null, cmds.map(function (x) { return x.count; }).concat([1]));
  var CMD_COLORS = ["#e0aa14","#3ddc97","#e5735f","#8b5cf6","#3b82f6"];
  patchHTML("insCmdsList", cmds.slice(0, 10).map(function (x, i) {
    return '<div class="rankActions"><button class="barRow pickRow' + (state.pick && state.pick.kind === "commands" && state.pick.name === x.program ? " on" : "") + '" data-activity="commands" data-pick="' + esc(x.program) + '">'
      + '<span class="dot" style="background:' + CMD_COLORS[i % 5] + '"></span>'
      + '<span class="nm">' + esc(x.program) + "</span>"
      + '<span class="ct">×' + x.count + "</span>"
      + '<span class="tr"><i style="width:' + (x.count / maxC * 100).toFixed(1) + "%;background:" + CMD_COLORS[i % 5] + '"></i></span></button><button class="textButton rankDetail" data-activity="commands" data-pick="' + esc(x.program) + '" aria-label="查看 ' + esc(x.program) + ' 明细">明细</button></div>';
  }).join("") || '<span class="empty" style="padding:18px 0">无命令记录</span>');
  document.getElementById("insSessCount").textContent = (d.sessions || []).length + " 个";
}
function dirName(s) {
  var parts = String(s.directory || "").split("/").filter(Boolean);
  var name = parts[parts.length - 1] || "(根)";
  return name.length > 18 ? name.slice(0, 15) + "…" : name;
}
/* ---------- 上下文页 ---------- */
function fillSessionSelect() {
  var sel = document.getElementById("ctxSession");
  var sessions = state.sessions.slice();
  if (state.sessionId && !sessions.some(s => s.id === state.sessionId)) sessions.unshift({ id: state.sessionId, title: state.ctx?.session?.title || state.sessionTitle || "当前会话" });
  var opts = sessions.map(function (s) {
    return '<option value="' + esc(s.id) + '"' + (s.id === state.sessionId ? " selected" : "") + ">" + esc(s.title || s.id) + "</option>";
  });
  patchHTML("ctxSession", opts.join("") || '<option value="">最近会话</option>');
  if (state.sessionId) sel.value = state.sessionId;
  if (window.syncSelect) syncSelect(sel);
}
document.getElementById('ctxSession').addEventListener('change', function (ev) { selectSession(ev.target.value); });
document.getElementById("trendMode").addEventListener("click", function (ev) {
  var b = ev.target.closest("button[data-m]");
  if (!b) return;
  state.trendMode = b.dataset.m;
  document.querySelectorAll("#trendMode button").forEach(function (x) { x.classList.toggle("on", x === b); });
  renderTrend();
});
document.getElementById("dnaMode").addEventListener("click", function (ev) {
  var b = ev.target.closest("button[data-m]");
  if (!b) return;
  if (state.dna === b.dataset.m) return;
  state.dna = b.dataset.m;
  document.querySelectorAll("#dnaMode button").forEach(function (x) { x.classList.toggle("on", x === b); });
  renderBrowser(); animateSwap(document.getElementById("ctxBrowser"));
});
async function ensureContext() {
  if (!state.sessions.length && !state.insights) await loadInsights(true);
  if (!state.ctx || state.ctx.session.id !== state.sessionId) return loadContext();
  renderContext();
}
async function loadContext(silent) {
  if (silent && inFlight.context) return;
  var ticket = ++requestTickets.context, sid = state.sessionId;
  inFlight.context = true;
  if (!silent) { showErr('ctxErr', null); setBusy('tab-context', true); }
  try {
    var data = await callTool('get_session_context', sid ? { session_id: sid } : {});
    if (ticket !== requestTickets.context || sid !== state.sessionId) return;
    state.ctx = data; state.sessionId = data.session.id; state.sessionTitle = data.session.title; state.contextAt = Date.now();
    state.lastActivity = Math.max(state.lastActivity, Number(data.session.updated || 0), data.live?.ts || 0);
    fillSessionSelect(); renderContext(); showErr('ctxErr', null);
    if (!silent) await loadBrowser();
  } catch (e) { if (ticket === requestTickets.context) { showErr('ctxErr', '上下文获取失败：' + e.message); setBusy('browserPanel', false); } }
  finally { if (ticket === requestTickets.context) { inFlight.context = false; setBusy('tab-context', false); } }
}
var browserTarget = '', browserDelay, chosenSnapshots = new Map();
function activeStep() { return state.trendHover || state.trendKey || ''; }
function snapshotTarget() { return JSON.stringify([state.sessionId, activeStep(), state.snapshot]); }
function stepLabel() {
  const step = trendValues.find(v => v.key === activeStep());
  return step ? '第 ' + step.number + ' 步' : activeStep() ? '已选择的历史步骤' : state.snapshot === 'prev' ? '上一请求' : state.manualKey ? '历史请求' : '最新请求';
}
function clearBrowserContent(message) {
  // 左栏图例在读历史时会变短，保留已布局的高度，避免柱子在按下和松开之间移位。
  const card = document.getElementById('currentCard');
  if (card && card.offsetHeight) card.style.minHeight = card.offsetHeight + 'px';
  state.browser = null;
  for (const id of ['browserStrip','browserSelection','snapshotScope']) patchHTML(id, '');
  document.getElementById('browserSelection').hidden = true;
  patchHTML('ctxBrowser', '<div class="empty">' + esc(message) + '</div>');
  document.getElementById('browserMeta').textContent = stepLabel() + ' · ' + message;
  renderCurrent();
}
function followTrendSnapshot() {
  if (!state.ctx || state.tab !== 'context' || !state.sessionId || document.getElementById('itemDialog')?.open) return;
  const target = snapshotTarget();
  if (target === browserTarget) return;
  browserTarget = target; clearTimeout(browserDelay); requestTickets.browser++; inFlight.browser = false;
  state.historyPage = null; state.historyList = false;
  clearBrowserContent('正在读取快照…');
  browserDelay = setTimeout(() => loadBrowser(), state.trendHover ? 130 : 0);
}
function renderSnapshotScope(data) {
  const choices = data.choices || [];
  const pending = !data.cats;
  const label = data.match === 'exact' ? '标识已匹配' : data.match === 'correlated' ? '按同轮时间和用量对应' : pending ? (choices.length ? '同轮候选，请核对时间' : '本页没有匹配快照') : activeStep() ? '手动选择的候选' : '日志快照';
  const controls = state.trendKey ? ['<button class="textButton" data-return-step>返回固定步骤 ↑</button>'] : [];
  if (!pending && data.snapshot_key) controls.push('<button class="textButton" data-compare-snap>与上个可读快照比较</button>');
  if (state.comparisonText) controls.push('<span>' + esc(state.comparisonText) + '</span>');
  if (!pending) controls.push('<button class="textButton" data-list-snap>' + (state.historyList ? '收起历史' : '浏览历史') + '</button>');
  if (pending || state.historyList) {
    choices.forEach((row, i) => {
      const seconds = row.ts ? new Date(row.ts).toLocaleTimeString('zh-CN', {hour12:false}) : '时间未知';
      controls.push('<button class="gchip" data-snap-choice="' + esc(row.key) + '" title="' + esc(row.request || row.turn) + '">' + seconds + ' · ' + esc(row.model || '请求') + ' · ' + (i + 1) + '</button>');
    });
    if (data.before != null) controls.push('<button class="textButton" data-older-snap>更早记录 ↓</button>');
  }
  if (data.skipped) controls.push('<span>本页有超出读取上限的记录</span>');
  patchHTML('snapshotScope', '<strong>' + esc(stepLabel()) + '</strong> · ' + label + ' ' + controls.join(' '));
}
async function loadBrowser(silent) {
  if (!state.sessionId || (silent && (inFlight.browser || activeStep() || state.manualKey || state.historyList))) return;
  clearTimeout(browserDelay);
  const target = browserTarget = snapshotTarget(), ticket = ++requestTickets.browser;
  const sid = state.sessionId, step = activeStep();
  const selection = step ? chosenSnapshots.get(JSON.stringify([sid,step])) : null;
  const key = step ? selection?.key : state.manualKey;
  const args = {session_id:sid, prev:state.snapshot === 'prev'};
  if (key) args.snapshot_key = key;
  if (step) args.step_id = step;
  if (state.historyPage != null) args.before = state.historyPage;
  inFlight.browser = true;
  if (!silent) setBusy('browserPanel', true);
  try {
    const data = await callTool('get_context_browser', args);
    if (ticket !== requestTickets.browser || target !== snapshotTarget()) return;
    if (step && data.snapshot_key && data.cats) {
      if (selection) data.match = selection.match;
      chosenSnapshots.set(JSON.stringify([sid,step]), {key:data.snapshot_key,match:data.match});
      if (chosenSnapshots.size > 120) chosenSnapshots.delete(chosenSnapshots.keys().next().value);
    }
    state.historyData = data; state.comparisonText = '';
    if (!data.cats) {
      clearBrowserContent(data.choices?.length ? '等待选择候选请求' : '当前日志范围内没有对应正文');
    } else {
      if (!step && state.snapshot === 'prev') state.manualKey = data.snapshot_key;
      state.browser = data; renderBrowser(); renderCurrent();
    }
    renderSnapshotScope(data);
  } catch (e) {
    if (ticket === requestTickets.browser && !silent) { state.historyData = null; clearBrowserContent(e.message); }
  } finally { if (ticket === requestTickets.browser) { inFlight.browser = false; setBusy('browserPanel', false); } }
}
function topChips(items, total, colorFn, kind) {
  var show = items.slice(0, 5);
  var html = show.map(function (x, i) {
    var action = kind ? 'data-activity="' + kind + '" data-pick="' + esc(x.name || x.program) + '"' : 'data-content-kind="' + (i === 0 ? 'user_messages' : 'answer') + '"';
    return '<button class="mchip" ' + action + '><i style="background:' + colorFn(i) + '"></i>' + esc(x.name || x.program) + " <b>" + x.count + "</b></button>";
  }).join("");
  if (items.length > 5) html += '<span class="mchip">+' + (items.length - 5) + " 项 · 共 " + total + "</span>";
  return html;
}
function renderContext() {
  var d = state.ctx; if (!d) return;
  var s = d.session, t = s.timing || {}, st = d.stats || {};
  // Context Stats KPI
  patchHTML("ctxStats", [
    { v: s.turns, l: "轮次" }, { v: s.steps, l: "步数" },
    { v: st.skills != null ? st.skills : "—", l: "技能加载" }, { v: st.answers != null ? st.answers : "—", l: "回答" },
  ].map(function (x) { return x.l === '技能加载' ? '<button class="csCell" data-activity="skills"><div class="v">' + x.v + '</div><div class="l">技能加载 ↗</div></button>' : '<div class="csCell"><div class="v">' + x.v + '</div><div class="l">' + x.l + "</div></div>"; }).join(""));
  patchHTML("ctxEvCounts", "上下文事件　"
    + '<b class="inj">注入 ' + (st.injects || 0) + "</b> / "
    + '<b class="cmp">压缩 ' + (st.compacts || 0) + "</b> / "
    + '<b>超限 ' + (st.overflows || 0) + '</b> / ' + '<b class="prn" data-tip="ZCode 未提供独立的裁剪事件记录">裁剪 —</b>');
  document.getElementById("ctxStatsSub").textContent = s.title || s.id;
  // Input / Output 行
  document.getElementById("ctxIoN").textContent = st.user_msgs != null ? st.user_msgs + " 条用户输入" : "—";
  patchHTML("ctxIoChips", topChips(
    [{ name: "用户消息", count: st.user_msgs || 0 }, { name: "回答", count: st.answers || 0 }],
    (st.user_msgs || 0) + (st.answers || 0), function (i) { return ["#22c55e", "#3b82f6"][i % 2]; }));
  // Tool Calls
  document.getElementById("ctxToolN").textContent = st.tool_calls || 0;
  var toolAgg = (st.tools || []).slice(0, 8).map(function (x) { return { name: x.name, count: x.count }; });
  patchHTML("ctxToolChips", topChips(toolAgg, st.tool_calls || 0, function (i) {
    return ["#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#14b8a6", "#6366f1"][i % 6];
  }, "tools"));
  // Command Executions
  var cmdTotal = st.command_calls ?? (st.commands || []).reduce(function (a, x) { return a + x.count; }, 0);
  document.getElementById("ctxCmdN").textContent = cmdTotal;
  patchHTML("ctxCmdChips", topChips(st.commands || [], cmdTotal, function (i) {
    return ["#e0aa14", "#3ddc97", "#e5735f", "#8b5cf6", "#3b82f6"][i % 5];
  }, "commands"));
  // Agent 家族行
  document.getElementById("ctxFleetN").textContent = "查看家族 →";
  patchHTML("ctxFleetRows", '<span class="mchip"><i style="background:#3b82f6"></i>会话 <b>' + cnum(s.tokens || 0) + "</b> tok</span>"
    + '<span class="mchip"><i style="background:#14b8a6"></i>输出 ' + cnum((s.token_sums || {}).output || 0) + "</span>");
  // 会话信息卡
  patchHTML("ctxInfo", [
    ["会话 ID", s.id], ["目录", s.directory], ["模型", s.model || "—"],
    ["窗口", cnum(s.window) + " tokens · " + (s.window_source || "内置")],
    ["预估费用", s.cost != null ? "≈¥" + (Math.round(s.cost * 100) / 100) : "已计价 " + (s.priced_models || 0) + " / " + (s.total_models || 0) + " 个模型"],
    ["创建", s.created ? new Date(s.created).toLocaleString("zh-CN") : "—"],
    ["更新", s.updated ? new Date(s.updated).toLocaleString("zh-CN") : "—"],
    ["归档", s.archived ? "是" : "否"],
  ].map(function (r) { return '<div class="row"><span class="k">' + r[0] + '</span><span class="v" title="' + esc(r[1]) + '">' + esc(r[1]) + "</span></div>"; }).join(""));
  // Token 统计环形（输出拆为思考/回复，与洞察页同口径）
  var ts = s.token_sums || {};
  document.getElementById("ctxCacheSub").textContent = "缓存命中 " + (t.cache_hit || 0) + "%";
  var tSegs = [
    { n: "缓存读取", v: ts.cache_read, c: "#22c55e" },
    { n: "缓存写入", v: ts.cache_write, c: "#a855f7" },
    { n: "新输入", v: Math.max((ts.input || 0) - (ts.cache_read || 0) - (ts.cache_write || 0), 0), c: "#3b82f6" },
    { n: "模型思考", v: ts.reasoning, c: "#ec4899" },
    { n: "模型回复", v: Math.max((ts.output || 0) - (ts.reasoning || 0), 0), c: "#f59e0b" },
  ].filter(function (x) { return x.v > 0; });
  var tTotal = tSegs.reduce(function (a, x) { return a + x.v; }, 0) || 1;
  patchHTML("ctxTokensBody", donutLegendBlock(tSegs, cnum(tTotal), "Token 总量", 108));
  document.getElementById("ctxTpsSub").textContent = "会话累计 · 输出速度 " + (t.tps || 0) + " tok/s";
  var timSegs = [
    { n: "模型等待", v: t.ttft_ms, c: "#6366f1", sub: cnum(ts.ttft_n) + "次" },
    { n: "模型生成", v: t.gen_ms, c: "#3b82f6", sub: cnum(s.steps) + "次" },
    { n: "工具执行", v: t.tool_ms, c: "#14b8a6", sub: cnum(t.tool_calls) + "次" },
  ].filter(function (x) { return x.v > 0; });
  patchHTML("ctxTimingBody", donutLegendBlock(timSegs, durMs(t.active_ms), "活跃时长", 108, true));
  restoreContextPins();
  renderCurrent();
  renderTrend();
  renderEvents();

}
function hash(s) { var h = 0; for (var i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0; return h; }
async function ensureFleet(silent) {
  if (silent && inFlight.fleet) return;
  var ticket = ++requestTickets.fleet, sid = state.sessionId;
  inFlight.fleet = true;
  if (!silent) { showErr('fleetErr', null); setBusy('tab-agent', true); }
  try {
    var data = await callTool('get_fleet', sid ? { session_id: sid } : {});
    if (ticket !== requestTickets.fleet || sid !== state.sessionId) return;
    state.fleet = data; state.fleetAt = Date.now(); renderFleet(); showErr('fleetErr', null);
  } catch (e) { if (ticket === requestTickets.fleet) showErr('fleetErr', 'Agent 家族获取失败：' + e.message); }
  finally { if (ticket === requestTickets.fleet) { inFlight.fleet = false; setBusy('tab-agent', false); } }
}

function schedule(){
  if (timer) clearInterval(timer);
  var el = document.getElementById("countdown");
  if (!REFRESH) { timer = null; if (el) el.textContent = "刷新已暂停"; return; } // 停止刷新：仅保留手动刷新
  timer = setInterval(function(){
    tick--;
    var el = document.getElementById("countdown");
    if (el) el.textContent = state.tab === "usage" ? Math.max(tick,0) + " 秒后刷新" : "自动同步";
    if (tick <= 0) {
      tick = REFRESH;
      if (state.tab === "usage" && !document.hidden) markRefreshing(refreshUsage()); // 洞察/上下文/Agent 由 live 定时器按会话活跃度驱动
    }
  }, 1000);
}
/* 刷新按钮反馈：仅图标旋转（无文字变化）；手动/自动刷新统一走这里，最短旋转 600ms 保证动画可感知 */
function markRefreshing(pr) {
  var b = document.getElementById('refreshBtn');
  if (!b) return Promise.resolve(pr);
  b.classList.add('refreshing');
  var min = typeof setTimeout === "function" ? new Promise(function (r) { setTimeout(r, 600); }) : Promise.resolve();
  return Promise.all([Promise.resolve(pr).catch(function () {}), min]).then(function () { b.classList.remove('refreshing'); });
}
async function manualRefresh() {
  var button = document.getElementById('refreshBtn');
  if (button.classList.contains('refreshing')) return;
  var work = (async function () {
    if (state.tab === 'usage') await refreshUsage();
    if (state.tab === 'insights') await loadInsights();
    if (state.tab === 'context') await loadContext();
    if (state.tab === 'agent') await ensureFleet();
  })();
  await markRefreshing(work);
}
applyTheme(document.documentElement.getAttribute("data-theme") || "dark");
/* ---- 使用详情（官方数据；经 MCP 桥调 get_usage_detail。合并自 glm-usage-dashboard v1.6.3）---- */
var detailState = { days: 7, tab: "model", data: null }, detailTicket = 0;
// 光带骨架占位：请求发出前就铺好与最终结构同几何的骨架，数据到达后原位补值，页面不跳版
function skel(w, h) { return '<span class="skel" style="width:' + w + ';height:' + h + '"></span>'; }
function ensureDetailSkeleton(body) {
  if (body.dataset.built === "1" && body.querySelector(".metrics, .lineLegend")) return;
  var barHs = [34, 58, 22, 74, 46, 88, 30, 64, 52, 40, 70, 26];
  body.innerHTML = '<div class="metrics">'
    + '<div class="metric"><div class="mv" id="dTtl">' + skel("52px", "14px") + '</div><div class="mk">总量 token</div></div>'
    + '<div class="metric"><div class="mv" id="dDly">' + skel("52px", "14px") + '</div><div class="mk">日均 token</div></div>'
    + '<div class="metric"><div class="mv" id="dCh">' + skel("52px", "14px") + '</div><div class="mk">缓存命中</div></div>'
    + '<div class="metric"><div class="mv" id="dPk">' + skel("52px", "14px") + '</div><div class="mk">峰时占比</div></div>'
    + "</div>"
    + '<div class="bars" id="dBars">' + barHs.map(function (h) { return '<div class="skel" style="height:' + h + 'px;flex:1"></div>'; }).join("") + '</div>'
    + '<div class="barAxis"><span id="dT0"></span><span id="dT1"></span></div>'
    + '<div class="legend"><span><i style="background:var(--acc)"></i>谷时</span><span><i style="background:var(--mid)"></i>峰时</span><span id="dGran"></span></div>'
    + '<div class="items" id="dItems">' + [72, 45, 88, 60].map(function (w) {
      return '<div class="item"><span class="in">' + skel("70%", "10px") + '</span><span class="ib"><i class="skel" style="width:' + w + '%"></i></span><span class="iv">' + skel("80%", "10px") + "</span></div>";
    }).join("") + '</div>';
  body.dataset.built = "1";
}
function renderDetail(animate = false) {
  var body = document.getElementById("detailBody");
  if (!detailState.data) return;
  var sec = detailState.data[detailState.tab];
  if (!sec || sec.error) { body.innerHTML = '<div class="err2">' + esc(sec?.error || "暂无使用详情") + "</div>"; delete body.dataset.built; return; }
  var sm = sec.summary || {}, max = Math.max.apply(null, [1].concat(sec.totals || []));
  ensureDetailSkeleton(body);
  function setMetric(id, v) {
    var el = document.getElementById(id);
    if (el.textContent !== String(v)) {
      el.textContent = v;
      el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
    }
  }
  setMetric("dTtl", fmtK(sm.total));
  setMetric("dDly", fmtK(sm.daily));
  setMetric("dCh", (sm.cacheHit * 100).toFixed(1) + "%");
  setMetric("dPk", (sm.peakRate * 100).toFixed(0) + "%");
  var bars = (sec.totals || []).map(function (v, i) {
    var h = Math.max(2, Math.round(v / max * 84));
    var peak = (sec.periodTypes || [])[i] === "PEAK", t = (sec.xTime || [])[i] || "";
    return '<div data-key="' + esc(t + '-' + i) + '" class="' + (peak ? "peak" : "") + '" style="height:' + h + 'px" data-tip="' + esc(t.slice(5, 16)) + ' · ' + fmtK(v) + ' token' + (peak ? ' · 峰时' : ' · 谷时') + '"></div>';
  }).join("");
  patchHTML('dBars', bars);
  document.getElementById("dT0").textContent = ((sec.xTime || [])[0] || "").slice(5, 10);
  document.getElementById("dT1").textContent = ((sec.xTime || []).slice(-1)[0] || "").slice(5, 10);
  document.getElementById("dGran").textContent = "按" + (sec.granularity === "HOUR" ? "小时" : sec.granularity === "DAY" ? "天" : sec.granularity);
  var top = sec.items && sec.items[0] ? sec.items[0].total || 1 : 1;
  var items = (sec.items || []).slice(0, 8).map(function (it) {
    return '<div class="item"><span class="in" title="' + esc(it.name) + '">' + esc(it.name) + "</span>"
      + '<span class="ib"><i style="width:' + Math.max(2, Math.round((it.total || 0) / top * 100)) + '%"></i></span>'
      + '<span class="iv">' + fmtK(it.total) + "</span></div>";
  }).join("");
  patchHTML('dItems', items);
  if (animate) animateSwap(document.getElementById("detailCard"));
}
async function loadDetail(animate = false) {
  var ticket = ++detailTicket, days = detailState.days;
  ensureDetailSkeleton(document.getElementById("detailBody")); /* 等待网络期间先铺光带骨架，占住最终版式 */
  try {
    var r = await window.__bridgeCall("tools/call", { name: "get_usage_detail", arguments: { days: days } });
    var j = JSON.parse(r.content[0].text);
    if (!j.ok) throw new Error(j.error || "未知错误");
    if (ticket !== detailTicket || days !== detailState.days) return;
    detailState.data = j.data;
    renderDetail(animate);
  } catch (e) {
    if (ticket !== detailTicket) return;
    document.getElementById("detailBody").innerHTML = '<div class="err2">获取失败：' + esc(e.message) + "</div>";
  }
}
document.getElementById("detailDays").addEventListener("click", function (e) {
  var b = e.target.closest("button"); if (!b || b.classList.contains("on")) return;
  detailState.days = Number(b.dataset.d);
  this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
  loadDetail(true);
});
document.getElementById("detailTab").addEventListener("click", function (e) {
  var b = e.target.closest("button"); if (!b) return;
  detailState.tab = b.dataset.t;
  this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
  renderDetail(true);
});

/* ---- 系统健康度（官方理论速率 model-performance-day + 本地实际解码速率对比）---- */
var healthState = { days: 7, data: null }, healthTicket = 0;
function speedChart(d) { return healthChart(d, { escape: esc, curve: monotonePath }); }
function ensureHealthSkeleton(body) {
  if (body.dataset.built === "1" && body.querySelector('.healthSummary')) return;
  var mSkel = '<div class="metric"><div class="mk">' + skel("58px", "9px") + '</div><div class="mv">' + skel("64px", "14px") + "</div></div>";
  body.innerHTML = '<div class="healthSummary" id="healthSummary">' + mSkel + mSkel + mSkel + '</div>'
    + '<div class="healthChartCaption">解码速度 <span>tokens/s</span> · 细线=官方理论 · 填充=本地实际</div>'
    + '<div id="hSpeed"><div class="skel skelBlock" style="height:148px;border-radius:4px"></div><div class="skel skelBlock" style="height:10px;width:42%;margin:9px auto 0"></div></div>'
    + '<div class="healthFoot" id="healthFoot">' + skel("46%", "10px") + '</div>';
  body.dataset.built = "1";
}
function renderHealth(animate = false) {
  var body = document.getElementById("healthBody");
  if (!healthState.data) return;
  var d = healthState.data;
  ensureHealthSkeleton(body);
  var last = Math.max(0, (d.xTime || []).length - 1);
  patchHTML('healthSummary', [['Max / Pro', d.proMax?.[last], '#4082f5'], ['Lite', d.lite?.[last], '#ff8e42'], ['实际 · 本地', d.actual?.[last], '#10b981']].map(function (row) {
    var value = row[1] != null && Number.isFinite(Number(row[1])) ? Number(row[1]).toFixed(1) : '—';
    return '<div class="metric"><div class="mk"><i style="background:' + row[2] + '"></i>' + row[0] + '</div><div class="mv">' + value + ' <small>tok/s</small></div></div>';
  }).join(''));
  var nLast = (d.actualN || [])[last];
  document.getElementById('healthFoot').textContent = (d.official === false ? '官方快照不可用 · 仅本地统计' : '官方每日快照' + (d.xTime?.length ? ' · 最新 ' + d.xTime[last] : ''))
    + ' · 实际=输出÷解码时长' + (nLast ? '（最新 ' + nLast + ' 次）' : '');
  var speed = document.getElementById("hSpeed");
  var sigS = d.xTime.join(",") + "|" + d.proMax.join(",") + "|" + d.lite.join(",") + "|" + (d.actual || []).join(",");
  if (speed.dataset.sig !== sigS) {
    speed.dataset.sig = sigS;
    patchHTML('hSpeed', speedChart(d));
    // 描线动画：下一帧把 dashoffset 放到 0，折线从左向右画出
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        speed.querySelectorAll("path.drawLine").forEach(function (el) { el.style.strokeDashoffset = "0"; });
      });
    });
  }
  if (animate) animateSwap(document.getElementById("healthCard"));
}
async function loadHealth(animate = false) {
  var ticket = ++healthTicket, days = healthState.days;
  ensureHealthSkeleton(document.getElementById("healthBody")); /* 等待期间先铺光带骨架，占住最终版式 */
  try {
    var r = await window.__bridgeCall("tools/call", { name: "get_health", arguments: { days: days } });
    var j = JSON.parse(r.content[0].text);
    if (!j.ok) throw new Error(j.error || "未知错误");
    if (ticket !== healthTicket || days !== healthState.days) return;
    healthState.data = j.data;
    renderHealth(animate);
  } catch (e) {
    if (ticket !== healthTicket) return;
    var body = document.getElementById("healthBody");
    body.innerHTML = '<div class="err2">获取失败：' + esc(e.message) + "</div>";
    delete body.dataset.built;
  }
}
document.getElementById("healthDays").addEventListener("click", function (e) {
  var b = e.target.closest("button"); if (!b || b.classList.contains("on")) return;
  healthState.days = Number(b.dataset.d);
  this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
  loadHealth(true);
});

async function keyStatus() {
  try {
    var r = await window.__bridgeCall("tools/call", { name: "get_config", arguments: {} });
    var j = JSON.parse(r.content[0].text);
    document.getElementById("keystatus").textContent =
      j.has_key ? "已配置 " + j.masked + "（优先使用）" : "未配置（用 ZCode 内嵌浏览器登录态兜底）";
    if (j.refresh_seconds != null) {
      REFRESH = j.refresh_seconds; tick = REFRESH;
      var sel = document.getElementById("refreshsel");
      if (sel) { sel.value = String(j.refresh_seconds); syncSelect(sel); }
      renderSubline(j.refresh_seconds);
    }
    if (j.insights_available === false) {
      showErr("insErr", "未找到本地会话数据库（~/.zcode/cli/db/db.sqlite），上下文洞察不可用");
    }
  } catch (e) { document.getElementById("keystatus").textContent = "配置读取失败"; }
}
function renderSubline(n) {
  var sl = document.getElementById("subline");
  if (sl) sl.innerHTML = (n ? "每 " + (n >= 60 ? (n / 60) + " 分钟" : n + " 秒") + "自动拉取" : "自动拉取已暂停（手动刷新可用）") + " · 燃烧速率按最近 5 分钟～6 小时样本估算 · <a href=\"https://bigmodel.cn/coding-plan/personal/usage\" target=\"_blank\">官方用量页 ↗</a>";
}
async function saveRefresh(v) {
  try {
    var n = Number(v);
    var r = await window.__bridgeCall("tools/call", { name: "set_refresh", arguments: { seconds: n } });
    REFRESH = n; tick = n;
    schedule();
    document.getElementById("keystatus").textContent = r.content[0].text;
    renderSubline(n);
  } catch (e) { document.getElementById("keystatus").textContent = "保存失败：" + e.message; }
}
async function saveKey(clear) {
  var v = clear ? "" : document.getElementById("keyinput").value.trim();
  try {
    var r = await window.__bridgeCall("tools/call", { name: "set_coding_key", arguments: { key: v } });
    document.getElementById("keystatus").textContent = r.content[0].text;
    document.getElementById("keyinput").value = "";
    load();
  } catch (e) { document.getElementById("keystatus").textContent = "保存失败：" + e.message; }
}
var usageRefresh = null;
function refreshUsage() {
  if (usageRefresh) return usageRefresh;
  usageRefresh = Promise.all([load(), loadDetail(), loadHealth()]).finally(() => { usageRefresh = null; });
  return usageRefresh;
}
/* 启动即挂载光带骨架：数据未到前各区块按最终布局占位（见 SK 注释） */
if (typeof document !== "undefined" && document.getElementById) SK.mountAll();
/* 启动防呆：bridge 迟迟未就绪时兜底显示默认用量页（正常路径在 switchTab 中纠正）；测试沙箱无 setTimeout，跳过 */
var bootGuard = typeof setTimeout === "function" ? setTimeout(function () {
  var page = document.getElementById("tab-usage");
  if (page) page.hidden = false;
  var tr = document.querySelector(".topright"); if (tr) tr.hidden = false;
  var b = document.querySelector('#tabs button[data-tab="usage"]');
  if (b && !document.querySelector("#tabs button.on")) b.classList.add("on");
}, 2500) : null;
var panelReady = false;
function openRequestedView() {
  if (!panelReady || !window.glmOpenTarget) return false;
  const {tab,sessionId} = window.glmOpenTarget;
  window.glmOpenTarget = null;
  if (sessionId && tab === 'context') selectSession(sessionId);
  else switchTab(tab);
  return true;
}
window.addEventListener('glm-open-target', openRequestedView);
window.addEventListener("bridge-ready", async function () {
  if (bootGuard) clearTimeout(bootGuard);
  await Promise.all([restorePersistentViews(), keyStatus()]);
  schedule(); panelReady = true;
  if (!openRequestedView()) switchTab(state.tab);
});
