"use strict";
// 假的 NapCat，用来在没有真实 QQ 的情况下测传输层与入口。
//
// 它作为**客户端**连到我们的反向 WS 服务端（跟真 NapCat 一样），可以：
//   - 投递脚本化的事件
//   - 按脚本响应动作调用（包括失败，用来测熔断与降级）
//   - 记录我们发出去的所有东西

const { WebSocket } = require("ws");

function createMockNapCat(options = {}) {
  const url = options.url || "ws://127.0.0.1:8790/onebot";
  const token = options.token ?? "";
  const selfId = options.selfId || 10001;
  const received = [];        // 我们收到的动作调用
  let socket = null;
  let respondWith = () => ({ status: "ok", retcode: 0, data: {} });
  let markClosed;
  const closed = new Promise((resolve) => { markClosed = resolve; });

  function connect() {
    return new Promise((resolve, reject) => {
      socket = new WebSocket(url, token ? { headers: { authorization: "Bearer " + token } } : {});
      socket.on("open", () => resolve());
      socket.on("error", reject);
      socket.on("close", () => markClosed());
      socket.on("message", (raw) => {
        let frame;
        try { frame = JSON.parse(raw.toString()); } catch { return; }
        if (!frame.action) return;
        received.push(frame);
        const result = respondWith(frame) || { status: "ok", retcode: 0, data: {} };
        if (socket.readyState === 1) socket.send(JSON.stringify({ ...result, echo: frame.echo }));
      });
    });
  }

  const send = (event) => socket.send(JSON.stringify({ self_id: selfId, ...event }));

  return {
    connect,
    send,
    received,
    closed,
    get alive() { return socket !== null && socket.readyState === 1; },
    get actions() { return received.map((r) => r.action); },
    find(action) { return received.filter((r) => r.action === action); },
    setResponder(fn) { respondWith = fn; },
    lifecycle: () => send({ time: Date.now(), post_type: "meta_event", meta_event_type: "lifecycle" }),
    heartbeat: () => send({ time: Date.now(), post_type: "meta_event", meta_event_type: "heartbeat" }),
    close: () => { try { socket?.close(); } catch {} },
    // 造一条群消息事件，message 是 array 格式（与实测一致）。
    // at 传机器人 QQ 号 → 正文前加一个 @机器人 段；ats 传别人的 QQ 号 → 依次加 @某人 段。
    // raw_message 也照实测写成 CQ 码。
    groupMessage({ userId = 10002, groupId = 123456789, text = "#帮助", messageId = Date.now(), role = "member", nickname = "测试", at = null, ats = [] } = {}) {
      const segments = [], raw = [];
      for (const qq of [at, ...ats]) {
        if (!qq) continue;
        segments.push({ type: "at", data: { qq: String(qq) } });
        raw.push("[CQ:at,qq=" + qq + "]");
      }
      segments.push({ type: "text", data: { text } });
      raw.push(text);
      send({
        time: Date.now(), post_type: "message", message_type: "group", sub_type: "normal",
        message_id: messageId, group_id: groupId, user_id: userId, font: 0,
        raw_message: raw.join(" "),
        sender: { user_id: userId, nickname, card: "", role },
        message: segments,
      });
    },
    privateMessage({ userId = 10002, text = "#帮助", messageId = Date.now(), subType = "friend" } = {}) {
      send({
        time: Date.now(), post_type: "message", message_type: "private", sub_type: subType,
        message_id: messageId, user_id: userId, raw_message: text, font: 0,
        sender: { user_id: userId, nickname: "测试", card: "", role: "member" },
        message: [{ type: "text", data: { text } }],
      });
    },
  };
}

module.exports = { createMockNapCat };
