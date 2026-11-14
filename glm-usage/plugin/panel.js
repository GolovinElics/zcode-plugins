/* GLM 用量面板脚本（外置以规避沙箱对内联脚本的 CSP 限制）
   握手协议 2026-01-26：面板为客户端，主动向宿主发 ui/initialize，收到应答后发 initialized 通知。 */
(function () {
  var dbg = document.getElementById("dbg");
  function log(s) { if (dbg) dbg.textContent += "\n" + new Date().toISOString().slice(17, 23) + " " + s; }
  if (dbg) dbg.textContent = "parent===self: " + (window.parent === window) + " top===self: " + (window.top === window) + " origin: " + location.origin;

  var INIT_ID = 1, tries = 0, initializedSent = false, gotReply = false;
  function send(obj) {
    try { window.parent.postMessage(obj, "*"); } catch (e) { log("send err " + e.message); }
  }
  function sendInit() {
    tries++;
    log("→ initialize try#" + tries);
    send({ jsonrpc: "2.0", id: INIT_ID, method: "ui/initialize", params: {
      appInfo: { name: "glm-usage-panel", title: "GLM 用量", version: "1.0.0" },
      appCapabilities: {}, protocolVersion: "2026-01-26" } });
  }
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    log("← msg " + (ev.source === window.parent ? "[parent]" : ev.source === window.top ? "[top]" : "[other]") + " " +
        (d && typeof d === "object" ? (d.method || "") + " id=" + d.id + (d.result ? " RESULT" : "") + (d.error ? " ERROR " + JSON.stringify(d.error).slice(0, 80) : "") : String(d).slice(0, 60)));
    if (!d || typeof d !== "object" || d.jsonrpc !== "2.0") return;
    if (d.id === INIT_ID && d.result) {
      gotReply = true; initializedSent = true;
      log("OK 握手成功");
      send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      if (dbg) dbg.style.display = "none";
      return;
    }
    if (d.method && d.id !== undefined) send({ jsonrpc: "2.0", id: d.id, result: {} });
  });
  sendInit();
  var timer = setInterval(function () {
    if (gotReply) return clearInterval(timer);
    if (tries >= 12) { clearInterval(timer); log("FAIL 12 次尝试无应答"); return; }
    sendInit();
  }, 1000);
})();
