#!/usr/bin/env node
"use strict";
// NapCat / OneBot 11 连接探针。
//
// 目的：在写适配层之前，把几个只能实测才能确定的假设一次性问清楚：
//   1. NapCat 的反向 WS 握手时，access_token 怎么带？—— header 还是 URL query？
//      （Node 内置 WebSocket 作为客户端不支持自定义 header，这决定正向 WS 能否零依赖使用）
//   2. 事件推送的 message 字段是 array 还是 string（CQ 码）？
//   3. HTTP 动作接口的鉴权方式，/get_login_info 是否可用？
//   4. 正向 WS 是否接受 ?access_token= ？
//
// 用法（先启动 NapCat 并扫码登录，再运行）：
//   node qq/probe-napcat.cjs
//   node qq/probe-napcat.cjs --token 你的token --port 8790 --http 8791 --forward 3001
//
// 它会在本机起一个临时 WS 服务端等 NapCat 连过来，同时探测 HTTP 与正向 WS。
// 不改任何文件，Ctrl+C 退出。

const http = require("node:http");
const { WebSocketServer } = require("ws");

function arg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const PORT = Number(arg("port", "8790"));
const HTTP_PORT = Number(arg("http", "8791"));
const FORWARD_PORT = Number(arg("forward", "3001"));
const TOKEN = arg("token", "");
const WAIT_MS = Number(arg("wait", "180000"));
// 连上之后还要停留一会儿，等一条真实消息事件才能判断 message 字段是 array 还是 string
const OBSERVE_MS = Number(arg("observe", "30000"));
const HOST = "127.0.0.1";

const findings = [];
const note = (tag, text) => { findings.push(tag + "：" + text); console.log("  [" + tag + "] " + text); };
const head = (text) => console.log("\n── " + text + " " + "─".repeat(Math.max(0, 58 - text.length)));
const status = (value) => (!value ? "（无）" : String(value).slice(0, 90));

// ── 1. HTTP 动作接口 ────────────────────────────────────────────────
function callHttp(path, withToken) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ action: path.slice(1), params: {}, echo: "probe" });
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    if (withToken && TOKEN) headers.authorization = "Bearer " + TOKEN;
    const req = http.request({ host: HOST, port: HTTP_PORT, path, method: "POST", headers, timeout: 5000 }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ code: res.statusCode, text }));
    });
    req.on("error", (error) => resolve({ error: error.message }));
    req.on("timeout", () => { req.destroy(); resolve({ error: "超时" }); });
    req.end(body);
  });
}

async function probeHttp() {
  head("探测 HTTP 动作接口 127.0.0.1:" + HTTP_PORT);
  const bare = await callHttp("/get_login_info", false);
  if (bare.error) {
    note("HTTP", "连不上（" + bare.error + "）—— NapCat 的 HTTP 服务器可能没开，动作改走 WS 通道即可");
    return;
  }
  note("HTTP", "不带 token：" + bare.code + " " + status(bare.text));
  if (TOKEN) {
    const authed = await callHttp("/get_login_info", true);
    note("HTTP", "带 token：" + (authed.error || authed.code + " " + status(authed.text)));
  }
}

// ── 2. 正向 WS：内置 WebSocket 能否用 ?access_token= 连上 ──────────────
function probeForward() {
  return new Promise((resolve) => {
    head("探测正向 WebSocket 127.0.0.1:" + FORWARD_PORT);
    const url = "ws://" + HOST + ":" + FORWARD_PORT + "/" + (TOKEN ? "?access_token=" + encodeURIComponent(TOKEN) : "");
    console.log("  用 Node 内置 WebSocket 连 " + url);
    let socket;
    try { socket = new WebSocket(url); }
    catch (error) { note("正向WS", "构造失败：" + error.message); return resolve(); }

    const finish = () => { try { socket.close(); } catch {} resolve(); };
    const timer = setTimeout(() => { note("正向WS", "已连接，但没等到动作响应"); finish(); }, 5000);

    socket.onopen = () => {
      note("正向WS", "连接成功 —— ?access_token= 这种带法被接受，零依赖方案可行");
      socket.send(JSON.stringify({ action: "get_login_info", params: {}, echo: "probe-fwd" }));
    };
    socket.onmessage = (event) => {
      let data;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      if (data.echo !== "probe-fwd") return; // 是事件推送而非我们的响应，忽略
      clearTimeout(timer);
      note("正向WS", "WS 通道动作调用 " + data.status + (data.data ? "（" + data.data.user_id + " / " + data.data.nickname + "）" : ""));
      finish();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      note("正向WS", "连接失败 —— NapCat 没开正向 WS，或不允许 query 带 token；用反向 WS + HTTP 即可");
      resolve();
    };
  });
}

// ── 3. 反向 WS 服务端：等 NapCat 连进来，观察它怎么带凭据 ──────────────
function probeReverse() {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ host: HOST, port: PORT });
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };

    server.on("error", (error) => {
      console.error("\n!! 起监听失败：" + error.message);
      if (error.code === "EADDRINUSE") console.error("   端口 " + PORT + " 被占用，换一个：--port 8791");
      process.exitCode = 1;
      finish(null);
    });

    server.on("listening", () => {
      head("反向 WebSocket 已监听 ws://" + HOST + ":" + PORT + "/onebot");
      console.log("  去 NapCat 的「网络配置」加一个反向 WebSocket 客户端：");
      console.log("    地址 ws://" + HOST + ":" + PORT + "/onebot" + (TOKEN ? "，token 填你配的那个" : ""));
      console.log("  等它连过来（最多 " + Math.round(WAIT_MS / 1000) + " 秒，Ctrl+C 可退出）……");
    });

    server.on("connection", (socket, request) => {
      head("NapCat 连上了");
      const headers = request.headers;
      const url = request.url || "";
      const query = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
      const queryToken = query.get("access_token");

      console.log("  请求路径：" + url);
      console.log("  X-Self-ID：" + (headers["x-self-id"] || "（无）"));
      console.log("  X-Client-Role：" + (headers["x-client-role"] || "（无）"));
      console.log("  Authorization：" + (headers["authorization"] ? "有，形如 " + String(headers.authorization).slice(0, 16) + "…" : "无"));
      console.log("  URL 里的 access_token：" + (queryToken ? "有" : "无"));

      if (headers["authorization"]) {
        note("鉴权", "NapCat 用 Authorization header 送 token");
        note("结论", "反向 WS 可用；但内置 WebSocket 不支持自定义 header，正向 WS 需另找客户端或改用反向 WS + HTTP");
      } else if (queryToken) {
        note("鉴权", "NapCat 用 URL query 送 token");
        note("结论", "正向 WS 可用内置 WebSocket 直连，零新增依赖");
      } else if (TOKEN) {
        note("鉴权", "握手信息里没有 token —— 检查 NapCat 那边是否真的配了");
      } else {
        note("鉴权", "本次没配 token；只绑回环地址时可以接受");
      }

      let askedLogin = false;
      let observeTimer = null;
      socket.on("message", (raw) => {
        let event;
        try { event = JSON.parse(raw.toString()); } catch { return; }

        // 动作响应
        if (event.echo === "probe-rev") {
          note("动作", "WS 通道调用 get_login_info：" + event.status +
            (event.data ? "（登录中 " + event.data.user_id + " / " + event.data.nickname + "）" : ""));
          if (event.data?.user_id) note("自检", "NapCat 登录的 QQ 号是 " + event.data.user_id + "，确认这是你的小号");
          return;
        }
        // 连接就绪后先自报家门
        if (event.post_type === "meta_event") {
          if (event.meta_event_type === "lifecycle" && !askedLogin) {
            askedLogin = true;
            note("事件", "收到 lifecycle，连接已就绪");
            socket.send(JSON.stringify({ action: "get_login_info", params: {}, echo: "probe-rev" }));
          }
          return;
        }
        if (event.post_type !== "message") return;

        head("收到一条消息事件");
        console.log("  message_type：" + event.message_type + " / sub_type：" + event.sub_type);
        console.log("  user_id：" + event.user_id + (event.group_id ? " / group_id：" + event.group_id : ""));
        console.log("  raw_message：" + JSON.stringify(event.raw_message));
        const isArray = Array.isArray(event.message);
        console.log("  message 字段：" + (isArray ? "array（好消息，免去解析 CQ 码）" : typeof event.message));
        note("格式", "messagePostFormat = " + (isArray ? "array" : "string —— 建议在 NapCat 里改成 array"));
        if (event.sender) note("字段", "sender 可用字段：" + Object.keys(event.sender).join(", "));
        clearTimeout(observeTimer);
        finish({ server });
      });

      socket.on("close", (code) => note("事件", "连接断开，代码 " + code));

      // 连上不等于验证完毕：还要等一条真实消息才能确认 message 字段格式
      console.log("\n  已连接。请在 QQ 里往群里或私聊发一条消息（例如 #帮助），" +
        "好让我看清事件格式（最多等 " + Math.round(OBSERVE_MS / 1000) + " 秒）……");
      observeTimer = setTimeout(() => {
        note("格式", "没等到消息事件，message 字段格式未确认 —— 可以重跑，或先发一条消息再连");
        finish({ server });
      }, OBSERVE_MS);
    });

    setTimeout(() => {
      if (done) return;
      console.error("\n!! 等了 " + Math.round(WAIT_MS / 1000) + " 秒没有 NapCat 连进来。");
      console.error("   检查：NapCat 是否已启动并扫码登录；反向 WS 客户端的地址与端口是否对得上。");
      finish(null);
    }, WAIT_MS);
  });
}

(async () => {
  console.log("NapCat / OneBot 11 连接探针");
  console.log("反向 WS " + PORT + " ｜ HTTP " + HTTP_PORT + " ｜ 正向 WS " + FORWARD_PORT + (TOKEN ? " ｜ 已带 token" : " ｜ 未带 token"));

  await probeHttp();
  await probeForward();
  const connected = await probeReverse();

  if (connected) {
    head("结论");
    for (const item of findings) console.log("  " + item);
    console.log("\n把以上输出发我，我据此定下适配层的传输方案。");
  }
  process.exit(0);
})();
