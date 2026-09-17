"use strict";
// OneBot 传输层测试。用 mock-onebot.cjs 冒充 NapCat，不需要真实 QQ。
//
// 注意：每个用例都要在 t.after 里关掉 mock 和 bot，否则 socket 和服务器
// 一直开着，node --test 会等进程退出而永远挂住。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createOneBot } = require("./qq-onebot.cjs");
const { createMockNapCat } = require("./mock-onebot.cjs");

const TOKEN = "test-token-abcdef";
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function setup(t, overrides = {}) {
  const events = [];
  const logs = [];
  const bot = createOneBot({
    port: 0, host: "127.0.0.1", token: TOKEN, coldStartMs: 0,
    minSendIntervalMs: 10, jitterMs: 0, perGroupIntervalMs: 0, perUserIntervalMs: 0,
    log: (text) => logs.push(text),
    ...overrides,
  });
  t.after(() => bot.stop());
  await bot.start((event) => events.push(event));

  const mock = createMockNapCat({ url: "ws://127.0.0.1:" + bot.state.port + "/onebot", token: TOKEN });
  t.after(() => mock.close());
  await mock.connect();
  await settle(30);
  return { bot, mock, events, logs };
}

test("token 不匹配的连接会被服务端关掉，且不处理事件", async (t) => {
  const { bot, logs } = await setup(t);
  // token 必须是 ASCII —— HTTP header 里放中文会 ERR_INVALID_CHAR
  const wrong = createMockNapCat({ url: "ws://127.0.0.1:" + bot.state.port + "/onebot", token: "wrong-token" });
  t.after(() => wrong.close());
  await wrong.connect();          // WS 握手本身不带鉴权，会先成功
  await wrong.closed;             // 随后被服务端关掉
  assert.equal(wrong.alive, false);
  assert.ok(logs.some((l) => l.includes("token 不匹配")), "应记录拒绝原因");
});

test("连接后收到 lifecycle 会记下 self_id", async (t) => {
  const { bot, mock } = await setup(t);
  mock.lifecycle();
  await settle();
  assert.equal(bot.state.selfId, 10001);
  assert.equal(bot.state.connected, true);
});

test("动作调用能拿到 echo 对应的响应", async (t) => {
  const { bot, mock } = await setup(t);
  mock.setResponder((frame) => frame.action === "get_login_info"
    ? { status: "ok", retcode: 0, data: { user_id: 10001, nickname: "小号" } }
    : { status: "ok", retcode: 0, data: {} });
  const data = await bot.call("get_login_info");
  assert.equal(data.user_id, 10001);
  assert.equal(data.nickname, "小号");
});

test("发送动作会带正确的 message 段", async (t) => {
  const { bot, mock } = await setup(t);
  await bot.call("send_group_msg", { group_id: 123456789, message: [{ type: "text", data: { text: "你好" } }] });
  const sent = mock.find("send_group_msg")[0];
  assert.equal(sent.params.group_id, 123456789);
  assert.equal(sent.params.message[0].data.text, "你好");
});

test("未连接时调用会报错而不是静默丢弃", async (t) => {
  const { bot } = await setup(t);
  bot.stop();
  await assert.rejects(() => bot.call("get_login_info"), /未连接/);
});

test("同一目标连发两条会被间隔限制拦住", async (t) => {
  const { bot } = await setup(t, { perGroupIntervalMs: 5000 });
  await bot.call("send_group_msg", { group_id: 1, message: [{ type: "text", data: { text: "第一条" } }] });
  await assert.rejects(
    () => bot.call("send_group_msg", { group_id: 1, message: [{ type: "text", data: { text: "第二条" } }] }),
    /间隔过短/,
  );
});

test("同一目标的每小时条数上限", async (t) => {
  const { bot } = await setup(t, { perGroupPerHour: 2 });
  for (const text of ["一", "二"]) {
    await bot.call("send_group_msg", { group_id: 7, message: [{ type: "text", data: { text } }] });
  }
  await assert.rejects(
    () => bot.call("send_group_msg", { group_id: 7, message: [{ type: "text", data: { text: "三" } }] }),
    /每小时上限/,
  );
});

test("相同内容会被抑制（防止错误提示刷屏）", async (t) => {
  const { bot } = await setup(t);
  const params = { group_id: 5, message: [{ type: "text", data: { text: "队列已满" } }] };
  await bot.call("send_group_msg", params);
  await assert.rejects(() => bot.call("send_group_msg", params), /相同内容/);
});

test("每日上限触发后停止发送", async (t) => {
  const { bot } = await setup(t, { dailyCap: 1 });
  await bot.call("send_group_msg", { group_id: 9, message: [{ type: "text", data: { text: "A" } }] });
  await assert.rejects(
    () => bot.call("send_group_msg", { group_id: 9, message: [{ type: "text", data: { text: "B" } }] }),
    /每日发送上限/,
  );
});

test("retcode 像风控时触发熔断并在日志里说明", async (t) => {
  const { bot, mock, logs } = await setup(t);
  mock.setResponder(() => ({ status: "failed", retcode: -100, data: null }));
  await assert.rejects(() => bot.call("send_group_msg", { group_id: 4, message: [{ type: "text", data: { text: "Y" } }] }));
  assert.equal(bot.state.circuitOpen, true);
  assert.ok(logs.some((l) => l.includes("熔断")), "应记录熔断原因");
});

test("普通失败不触发熔断", async (t) => {
  const { bot, mock } = await setup(t);
  mock.setResponder(() => ({ status: "failed", retcode: 1404, data: null }));
  await assert.rejects(() => bot.call("send_group_msg", { group_id: 6, message: [{ type: "text", data: { text: "Z" } }] }));
  assert.equal(bot.state.circuitOpen, false, "1404 是普通错误，不该熔断");
});

test("第二个并发连接被拒绝（防止消息被处理两次）", async (t) => {
  const { bot, logs } = await setup(t);
  const second = createMockNapCat({ url: "ws://127.0.0.1:" + bot.state.port + "/onebot", token: TOKEN });
  t.after(() => second.close());
  await second.connect();
  await second.closed;
  assert.equal(second.alive, false);
  assert.ok(logs.some((l) => l.includes("第二个并发连接")), "应警告重复连接");
});

test("读取类动作不受发送间隔限制（否则每次引用都白等一秒多）", async (t) => {
  const { bot } = await setup(t, { minSendIntervalMs: 3000, jitterMs: 0 });
  await bot.call("send_group_msg", { group_id: 3, message: [{ type: "text", data: { text: "先发一条" } }] });
  const startedAt = Date.now();
  await bot.call("get_msg", { message_id: 1 });
  assert.ok(Date.now() - startedAt < 1000, "get_msg 不该陪着等发送间隔");
});

test("message_id 重复的事件只投递一次", async (t) => {
  const { bot, mock, events } = await setup(t);
  mock.groupMessage({ messageId: 555, text: "第一次" });
  await settle();
  mock.groupMessage({ messageId: 555, text: "第一次" });
  await settle();
  assert.equal(events.filter((e) => e.post_type === "message").length, 1);
});

test("冷启动宽限期内的事件被忽略", async (t) => {
  const { mock, events } = await setup(t, { coldStartMs: 60000 });
  mock.groupMessage({ text: "刚启动" });
  await settle();
  assert.equal(events.filter((e) => e.post_type === "message").length, 0);
});

test("自己发的消息不回环，meta_event 照常投递", async (t) => {
  const { mock, events } = await setup(t);
  mock.send({ post_type: "message_sent", message_type: "group", user_id: 10001, message_id: 1, message: [] });
  mock.lifecycle();
  await settle();
  assert.equal(events.filter((e) => e.post_type === "message_sent").length, 0);
  assert.ok(events.some((e) => e.post_type === "meta_event"));
});

test("事件里的 message 数组和 sender 字段原样透传", async (t) => {
  const { mock, events } = await setup(t);
  mock.groupMessage({ userId: 10002, groupId: 123456789, text: "#帮助", role: "admin" });
  await settle();
  const message = events.find((e) => e.post_type === "message");
  assert.equal(message.group_id, 123456789);
  assert.equal(message.user_id, 10002);
  assert.equal(Array.isArray(message.message), true);
  assert.equal(message.message[0].data.text, "#帮助");
  assert.equal(message.sender.role, "admin");
});
