/* ZCode 面板桥：① 握手（面板为客户端，协议 2026-01-26）② MCP 工具代理调用（serverTools） */
(function () {
  var INIT_ID = 1, tries = 0, gotReply = false;
  var pending = {}, reqId = 100;
  window.__bridgeCall = function (method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++reqId;
      pending[id] = { resolve: resolve, reject: reject };
      try { window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*"); } catch (e) { delete pending[id]; reject(e); }
      setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error(method + " 桥接超时")); } }, 20000);
    });
  };
  function send(o) { try { window.parent.postMessage(o, "*"); } catch (e) {} }
  function sendInit() {
    tries++;
    send({ jsonrpc: "2.0", id: INIT_ID, method: "ui/initialize", params: {
      appInfo: { name: "glm-usage-panel", title: "GLM 用量 · 上下文洞察", version: "2.8.4" },
      appCapabilities: {}, protocolVersion: "2026-01-26" } });
  }
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || typeof d !== "object" || d.jsonrpc !== "2.0") return;
    if (d.id === INIT_ID && d.result) {
      if (gotReply) return;
      gotReply = true;
      send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      window.dispatchEvent(new CustomEvent("bridge-ready"));
      return;
    }
    if (d.id >= 100 && pending[d.id]) {
      var p = pending[d.id]; delete pending[d.id];
      if (d.error) p.reject(new Error(d.error.message || "桥接错误")); else p.resolve(d.result);
      return;
    }
    if (d.method && d.id !== undefined) send({ jsonrpc: "2.0", id: d.id, result: {} });
  });
  sendInit();
  var t = setInterval(function () {
    if (gotReply) return clearInterval(t);
    if (tries >= 12) return clearInterval(t);
    sendInit();
  }, 1000);
})();
/* 主题初始化（localStorage > 系统） */
(function(){ try {
  var t = localStorage.getItem("glm-theme");
  if (!t) t = (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
} catch(e){} })();
