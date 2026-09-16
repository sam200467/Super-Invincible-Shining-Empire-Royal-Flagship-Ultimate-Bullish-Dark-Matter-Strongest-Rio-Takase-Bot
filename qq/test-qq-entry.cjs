"use strict";
// QQ 入口测试：命令解析、群白名单、绑定状态机、回复路由。
// 用 mock-onebot.cjs 冒充 NapCat，并把 takase-core 的账号相关调用替换掉
// （verifyAccount / generateChart 需要真实大饼账号，测不了）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const core = require("../takase-core.cjs");
const { createQqBot, parseCommand } = require("./qq-entry.cjs");
const { createMockNapCat } = require("./mock-onebot.cjs");

const TOKEN = "test-token-abcdef";
const GROUP = "123456789";
const USER = "10002";
const OTHER_GROUP = "111111111";
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// 每个用例独立的数据目录与 stdout 捕获
function makeConfig(dir) {
  return {
    oneBotPort: 0, oneBotToken: TOKEN, qqNumber: "10001",
    allowedGroupIds: [GROUP],
    workDir: path.join(dir, "work"), outputDir: path.join(dir, "output"),
    corePath: path.join(dir, "fake-core.exe"), vaultHelperPath: path.join(dir, "fake-vault.exe"),
    vaultPath: path.join(dir, "bindings.dat"), proxyUrl: "",
    minSendIntervalMs: 10, jitterMs: 0, coldStartMs: 0,
    perUserIntervalMs: 0, perGroupIntervalMs: 0,
  };
}

// 一张 24 字节头的合法 PNG：够 pngSize 读出尺寸，不必是真图
function fakePng(name, width, height) {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4);
  png.write("IHDR", 12, "ascii"); png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
  return { name, buffer: png };
}

// 最小的 rio-chat 资料目录：够 loadSettings 通过校验即可。
// expressions.enabled=false，所以不需要表情清单和图片文件。
function writeRioChatFixture(dir) {
  const root = path.join(dir, "rio-chat");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "persona.md"), "你是高濑梨绪。\n");
  fs.writeFileSync(path.join(root, "examples.json"), JSON.stringify({ examples: [] }));
  fs.writeFileSync(path.join(root, "config.local.json"), JSON.stringify({
    schemaVersion: 1, enabled: true,
    provider: { baseUrl: "https://api.deepseek.com", endpoint: "/chat/completions", model: "deepseek-flash", apiKey: "test-key", timeoutMs: 10000 },
    personaFile: "persona.md", examplesFile: "examples.json",
    discord: { trigger: "direct_mention_only", allowDM: false, allowedChannelIds: [], inheritExistingChannelRestrictions: true },
    conversation: { maxTurns: 6, ttlMinutes: 30, persist: false },
    limits: { userCooldownSeconds: 0, maxConcurrentRequests: 2, maxInputChars: 1500, maxReplyChars: 600 },
    expressions: { enabled: false, manifest: "expressions.json" },
  }));
  return root;
}

// 假的 DeepSeek：按脚本返回一条 JSON 回复，不看请求内容（只看调用次数）
const deepSeekStub = (body) => async () => ({
  ok: true,
  json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(body) } }] }),
});

async function setup(t, { bindings = {}, rioChat = false, fetchImpl = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "takase-qq-"));
  fs.writeFileSync(path.join(dir, "fake-core.exe"), "");
  fs.writeFileSync(path.join(dir, "fake-vault.exe"), "");
  const config = makeConfig(dir);
  if (rioChat) config.rioChatDir = writeRioChatFixture(dir);

  // 捕获 stdout 用来断言「密码从不外泄」
  const printed = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return realWrite(chunk, ...rest); };

  // 替换掉需要真实账号/真实分表核心的调用
  const original = {
    getBinding: core.getBinding, saveBinding: core.saveBinding, vaultCall: core.vaultCall,
    verifyAccount: core.verifyAccount, generateChart: core.generateChart, generateSongChart: core.generateSongChart,
  };
  const store = { ...bindings };
  const saved = [];
  core.getBinding = async (_c, userId) => store[String(userId)] || null;
  core.saveBinding = async (_c, entry) => { store[String(entry.userId)] = entry; saved.push(entry); };
  core.vaultCall = async (_c, command, args = []) => {
    if (command === "count") return String(Object.keys(store).length);
    if (command === "delete") { delete store[String(args[0])]; return "OK"; }
    return "OK";
  };
  core.verifyAccount = async (_c, email, password) => {
    if (password === "wrong-password") throw new Error("账号或密码错误");
    return "测试玩家";
  };
  core.generateChart = async () => fakePng("chart.png", 3600, 1800);
  // 带上核心真实会吐的那份摘要（SONG_SUMMARY 的形状）
  core.generateSongChart = async () => ({
    ...fakePng("song.png", 1200, 800),
    meta: { found: true, songId: 870, title: "VIIIbit Explorer", scores: [{ difficultyId: 3, techScore: 1008123, allBreak: true, fullCombo: true, fullBell: true }] },
  });

  const bot = createQqBot(config, { now: Date.now, ...(rioChat ? { chat: { fetchImpl: fetchImpl || deepSeekStub({ text: "嗯嗯，在的。" }) } } : {}) });
  await bot.start();
  const mock = createMockNapCat({
    url: "ws://127.0.0.1:" + bot.state.onebot.state.port + "/onebot",
    token: TOKEN,
    selfId: 10001,
  });
  await mock.connect();
  mock.setResponder((frame) => {
    if (frame.action === "get_login_info") return { status: "ok", retcode: 0, data: { user_id: 10001, nickname: "小号" } };
    return { status: "ok", retcode: 0, data: { message_id: 1 } };
  });
  await settle(30);

  t.after(() => {
    process.stdout.write = realWrite;
    Object.assign(core, original);
    mock.close();
    bot.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const sentText = (action) => mock.find(action)
    .map((r) => (r.params.message || []).filter((s) => s.type === "text").map((s) => s.data.text).join(""))
    .join("\n");

  return { bot, mock, config, printed, store, saved, sentText };
}

// ── 命令解析 ────────────────────────────────────────────────────────
test("命令解析：# 前缀 + 白名单关键字", () => {
  assert.equal(parseCommand("#帮助").name, "help");
  assert.equal(parseCommand("＃分表").name, "chart");        // 全角井号
  assert.equal(parseCommand("/bind").name, "bind");
  assert.equal(parseCommand("#B50").name, "chart");          // 大小写不敏感
  assert.equal(parseCommand("#牌子 bright").name, "plate");
  assert.equal(parseCommand("#单曲 id870").name, "song");
  assert.equal(parseCommand("#谱面分析 id870 master").name, "chartinfo");
  assert.equal(parseCommand("#定数表 14.2").name, "constant");
  assert.equal(parseCommand("#等级 14+ 2").name, "level");
  assert.equal(parseCommand("#计算 14.2 1000000 fb ab").name, "calculate");
  assert.equal(parseCommand("#添加别名 id870 | 八比特").name, "aliasadd");
  assert.equal(parseCommand("帮助"), null);                  // 无前缀 → 不触发
  assert.equal(parseCommand("#不存在的指令").name, null);
  assert.equal(parseCommand("今天天气不错"), null);
});

// ── 群白名单与前缀 ──────────────────────────────────────────────────
test("非白名单群的消息被忽略", async (t) => {
  const { mock, sentText } = await setup(t);
  mock.groupMessage({ groupId: OTHER_GROUP, text: "#帮助" });
  await settle();
  assert.equal(sentText("send_group_msg"), "");
});

test("群里没带前缀的闲聊不触发", async (t) => {
  const { mock, sentText } = await setup(t);
  mock.groupMessage({ text: "帮助" });
  await settle();
  assert.equal(sentText("send_group_msg"), "");
});

test("#帮助 在群里回复功能清单", async (t) => {
  const { mock, sentText } = await setup(t);
  mock.groupMessage({ text: "#帮助" });
  await settle();
  const text = sentText("send_group_msg");
  assert.match(text, /#绑定/);
  assert.match(text, /#分表/);
  assert.match(text, /私聊/);
  // QQ 不渲染 markdown，帮助文案里不该出现 Discord 的格式标记
  assert.doesNotMatch(text, /\*\*|`/);
});

test("完整迁移命令：Rating 计算与歌曲别名可在 QQ 使用", async (t) => {
  const { mock, sentText } = await setup(t);
  mock.groupMessage({ text: "#计算 14.2 1000737 fb none", messageId: 701 });
  await settle();
  assert.match(sentText("send_group_msg"), /15\.74/);
  mock.groupMessage({ text: "#添加别名 id870 | 八比特测试", messageId: 702 });
  await settle();
  assert.match(sentText("send_group_msg"), /已添加别名/);
  mock.groupMessage({ text: "#是什么歌 八比特测试", messageId: 703 });
  await settle();
  assert.match(sentText("send_group_msg"), /id870/);
});

// ── 绑定 ────────────────────────────────────────────────────────────
test("#绑定 在群里会引导用户私聊", async (t) => {
  const { mock, sentText } = await setup(t);
  mock.groupMessage({ text: "#绑定" });
  await settle();
  assert.match(sentText("send_group_msg"), /私聊/);
});

test("绑定流程：邮箱格式错误三次后中断", async (t) => {
  const { mock, bot, sentText } = await setup(t);
  mock.privateMessage({ text: "#绑定" });
  await settle();
  assert.equal(bot.state.sessions.get(USER).state, "awaitingEmail");

  // 三次都用不同的文本 —— 传输层对「同用户同文本 20 秒内」有去重，重复发同样的会被吞掉
  for (let i = 0; i < 3; i++) mock.privateMessage({ text: "不是邮箱" + i, messageId: 900 + i });
  await settle(80);
  assert.match(sentText("send_private_msg"), /邮箱连错 3 次/);
  assert.equal(bot.state.sessions.has(USER), false);
});

test("绑定流程：邮箱 → 密码 → 验证成功", async (t) => {
  const { mock, saved, sentText } = await setup(t);
  mock.privateMessage({ text: "#绑定" });
  await settle();
  mock.privateMessage({ text: "player@example.com", messageId: 901 });
  await settle();
  mock.privateMessage({ text: "hunter2-secret", messageId: 902 });
  await settle(200);

  assert.equal(saved.length, 1);
  assert.equal(saved[0].userId, USER);
  assert.equal(saved[0].email, "player@example.com");
  assert.equal(saved[0].playerName, "测试玩家");
  assert.match(sentText("send_private_msg"), /绑定成功/);
});

test("绑定失败会告知用户且不影响后续", async (t) => {
  const { mock, saved, sentText } = await setup(t);
  mock.privateMessage({ text: "#绑定" });
  await settle();
  mock.privateMessage({ text: "player@example.com", messageId: 911 });
  await settle();
  mock.privateMessage({ text: "wrong-password", messageId: 912 });
  await settle(200);
  assert.equal(saved.length, 0);
  assert.match(sentText("send_private_msg"), /绑定失败/);
});

test("密码从不出现在任何输出里", async (t) => {
  const { mock, printed } = await setup(t);
  const secret = "SuperSecret-Passw0rd-9f3a";
  mock.privateMessage({ text: "#绑定" });
  await settle();
  mock.privateMessage({ text: "player@example.com", messageId: 921 });
  await settle();
  mock.privateMessage({ text: secret, messageId: 922 });
  await settle(250);

  const all = printed.join("");
  assert.equal(all.includes(secret), false, "密码泄漏到了日志输出！");
  // 邮箱也不该明文出现在日志里（safeError 有脱敏规则）
  assert.equal(/player@example\.com/.test(all.replace(/邮箱已隐藏/g, "")), false, "邮箱泄漏到了日志输出");
});

test("#取消 能中断绑定会话", async (t) => {
  const { mock, bot, sentText } = await setup(t);
  mock.privateMessage({ text: "#绑定" });
  await settle();
  assert.equal(bot.state.sessions.has(USER), true);
  mock.privateMessage({ text: "#取消", messageId: 931 });
  await settle();
  assert.equal(bot.state.sessions.has(USER), false);
  assert.match(sentText("send_private_msg"), /已取消/);
});

// ── 分表 ────────────────────────────────────────────────────────────
test("未绑定时 #分表 引导去绑定", async (t) => {
  const { mock, sentText } = await setup(t);
  mock.groupMessage({ text: "#分表" });
  await settle(200);
  // 未绑定提示是多句说法轮换的，断言它们共有的绑定命令
  assert.match(sentText("send_private_msg") + sentText("send_group_msg"), /#绑定/);
});

test("已绑定后 #分表 会发出图片", async (t) => {
  const { mock, sentText } = await setup(t, { bindings: { [USER]: { userId: USER, email: "a@b.c", password: "x", playerName: "测试玩家" } } });
  mock.groupMessage({ text: "#分表" });
  await settle(300);
  const withImage = mock.find("send_group_msg").find((r) => (r.params.message || []).some((s) => s.type === "image"));
  assert.ok(withImage, "应该发出一条带图片的消息");
  const image = withImage.params.message.find((s) => s.type === "image");
  assert.match(image.data.file, /^file:\/\/\//, "应使用 file:/// 绝对路径");
  // 图片段本身占一整块，说明文字前面再加换行会在 QQ 里多出一个空行
  const caption = withImage.params.message.find((s) => s.type === "text");
  assert.equal(/^\s/.test(caption.data.text), false, "图片说明不该以换行开头");
  assert.match(caption.data.text, /测试玩家 的 B50 \+ N10 \+ P50 分表/);
  assert.equal(sentText("send_group_msg").includes("已收到，正在生成"), true);
});

test("生成冷却期内重复 #分表 会被拦住", async (t) => {
  const { mock, sentText } = await setup(t, { bindings: { [USER]: { userId: USER, email: "a@b.c", password: "x", playerName: "P" } } });
  mock.groupMessage({ text: "#分表", messageId: 941 });
  await settle(300);
  mock.groupMessage({ text: "#分表", messageId: 942 });
  await settle(200);
  // 冷却提示属于提醒类，按设计优先走私聊；群里的回执则是第一条那个。
  // 文案会随语气调整，这里只断言「报出了还要等几秒」这个信息本身
  assert.match(sentText("send_private_msg") + sentText("send_group_msg"), /等 \d+ 秒/);
  // 而且不该真去生成第二张
  assert.equal(mock.find("send_group_msg").filter((r) => (r.params.message || []).some((s) => s.type === "image")).length, 1);
});

// ── 解绑 ────────────────────────────────────────────────────────────
test("#解绑 需要二次确认", async (t) => {
  const { mock, store, sentText } = await setup(t, { bindings: { [USER]: { userId: USER, email: "a@b.c", password: "x", playerName: "P" } } });
  mock.privateMessage({ text: "#解绑", messageId: 951 });
  await settle();
  assert.match(sentText("send_private_msg"), /确定删除/);
  assert.ok(store[USER], "第一次不该真删");

  mock.privateMessage({ text: "#解绑", messageId: 952 });
  await settle(120);
  assert.equal(store[USER], undefined, "第二次确认后应删除");
});

test("#状态 报告连接与队列", async (t) => {
  const { mock, sentText } = await setup(t);
  mock.privateMessage({ text: "#状态", messageId: 961 });
  await settle();
  const text = sentText("send_private_msg");
  assert.match(text, /运行正常/);
  assert.match(text, /等待队列/);
});

test("NapCat 连接状态通过 BOT_NAPCAT 上报给界面", async (t) => {
  const { mock, printed } = await setup(t);
  await settle(2400);                 // 上报间隔 2 秒
  assert.equal(printed.join("").includes("BOT_NAPCAT:1"), true, "连上后应上报 1");
  mock.close();
  await settle(2400);
  assert.equal(printed.join("").includes("BOT_NAPCAT:0"), true, "断开后应上报 0");
});

// ── 自然语言查分（聊天与查分统一）────────────────────────────────────
const BOUND = { userId: USER, email: "a@b.c", password: "x", playerName: "测试玩家" };
const chatReply = (body) => deepSeekStub(body);

test("@机器人 用大白话查分：模型挑工具，图片带聊天口气", async (t) => {
  const { mock, sentText } = await setup(t, {
    bindings: { [USER]: BOUND },
    rioChat: true,
    fetchImpl: chatReply({ text: "哼哼，这就去翻你的成绩——", emotion: "proud", scene: "ordinary", expressionIds: [], action: { name: "song", query: "id870" } }),
  });
  mock.groupMessage({ text: "你能不能帮我查一下 id870 这首歌全难度成绩图", at: 10001, messageId: 7001 });
  await settle(300);

  const images = mock.find("send_group_msg").filter((r) => (r.params.message || []).some((s) => s.type === "image"));
  assert.equal(images.length, 1, "应该正好发出一条带图片的消息");
  assert.match(sentText("send_group_msg"), /哼哼/, "模型那句引出语应该先发出去");
  assert.match(sentText("send_group_msg"), /id870/, "图片说明由程序按真实结果补，不是模型编的");
});

test("@机器人 未绑定就查分：只给绑定提示，不把话说满", async (t) => {
  const { mock, sentText } = await setup(t, {
    rioChat: true,
    fetchImpl: chatReply({ text: "哼哼，这就去翻你的成绩——", emotion: "proud", scene: "ordinary", expressionIds: [], action: { name: "song", query: "id870" } }),
  });
  mock.groupMessage({ text: "帮我查一下 id870 的成绩", at: 10001, messageId: 7002 });
  await settle(300);

  assert.match(sentText("send_private_msg"), /#绑定/);
  assert.equal(sentText("send_group_msg").includes("哼哼"), false, "失败时不该先把话说满");
  assert.equal(mock.find("send_group_msg").some((r) => (r.params.message || []).some((s) => s.type === "image")), false);
});

// ── 查别人（需要本人开放）────────────────────────────────────────────
const OTHER = "10086";

test("#允许查询 / #禁止查询 控制别人能不能查我", async (t) => {
  const { mock, store, sentText } = await setup(t, { bindings: { [USER]: { ...BOUND } } });
  mock.privateMessage({ text: "#允许查询", messageId: 9001 });
  await settle(120);
  assert.equal(store[USER].allowOthers, true);
  assert.match(sentText("send_private_msg"), /开了/);
  mock.privateMessage({ text: "#禁止查询", messageId: 9002 });
  await settle(120);
  assert.equal(store[USER].allowOthers, false);
  assert.match(sentText("send_private_msg"), /关了/);
});

test("没绑定时 #允许查询 会提示先绑定", async (t) => {
  const { mock, sentText } = await setup(t);
  mock.privateMessage({ text: "#允许查询", messageId: 9003 });
  await settle(120);
  assert.match(sentText("send_private_msg"), /#绑定/);
});

test("#单曲 @某人 查得到对方成绩（对方已开放）", async (t) => {
  const { mock, sentText } = await setup(t, {
    bindings: {
      [USER]: { ...BOUND },
      [OTHER]: { userId: OTHER, email: "o@b.c", password: "x", playerName: "小明", allowOthers: true },
    },
  });
  mock.groupMessage({ text: "#单曲 id870", ats: [OTHER], messageId: 9101 });
  await settle(300);
  assert.match(sentText("send_group_msg"), /小明 的单曲全难度成绩/);
});

test("@某人 但对方没开放时会被回绝", async (t) => {
  const { mock, sentText } = await setup(t, {
    bindings: {
      [USER]: { ...BOUND },
      [OTHER]: { userId: OTHER, email: "o@b.c", password: "x", playerName: "小红" },
    },
  });
  mock.groupMessage({ text: "#单曲 id870", ats: [OTHER], messageId: 9102 });
  await settle(300);
  // 回绝文案有多句说法，断言共有的关键信息：告诉对方怎么才能开
  assert.match(sentText("send_private_msg") + sentText("send_group_msg"), /#允许查询/);
  assert.equal(mock.find("send_group_msg").some((r) => (r.params.message || []).some((s) => s.type === "image")), false);
});

test("@机器人 让我查 @某人：模型给的 target 要过 @ 名单校验", async (t) => {
  const action = (target) => ({ text: "哼哼，我去翻他的。", emotion: "proud", scene: "ordinary", expressionIds: [], action: { name: "song", query: "id870", target } });
  const bound = {
    [USER]: { ...BOUND },
    [OTHER]: { userId: OTHER, email: "o@b.c", password: "x", playerName: "小明", allowOthers: true },
  };
  // 真的 @ 过对方 → 查对方的
  const first = await setup(t, { bindings: bound, rioChat: true, fetchImpl: deepSeekStub(action(OTHER)) });
  first.mock.groupMessage({ text: "帮我查一下他的全难度成绩", at: 10001, ats: [OTHER], messageId: 9201 });
  await settle(300);
  assert.match(first.sentText("send_group_msg"), /小明 的单曲全难度成绩/);

  // 没 @ 过的人 → 模型编的编号作废，退回查自己
  const second = await setup(t, { bindings: bound, rioChat: true, fetchImpl: deepSeekStub(action("99999")) });
  second.mock.groupMessage({ text: "帮我查一下我的成绩", at: 10001, messageId: 9202 });
  await settle(300);
  assert.match(second.sentText("send_group_msg"), /测试玩家 的单曲全难度成绩/);
});

test("出图之后，群上下文里读得到图上的数据", async (t) => {
  const bodies = [];
  const { mock } = await setup(t, {
    bindings: { [USER]: BOUND },
    rioChat: true,
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ text: "嗯。", emotion: "neutral", scene: "ordinary", expressionIds: [] }) } }] }) };
    },
  });
  mock.groupMessage({ text: "#单曲 id870", messageId: 9301 });
  await settle(300);
  mock.groupMessage({ text: "他这首打了多少", at: 10001, messageId: 9302 });
  await settle(300);

  // 图本身模型读不到，但生成它的数据要能在上下文里看到
  const context = bodies[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(context, /MASTER 1008123 AB · FC · FB/, "图上数据（各难度技术分）应该进上下文");
  assert.match(context, /单曲全难度成绩/, "也要看得出这是谁的那张图");
});

test("群上下文：@机器人时带上刚才群里发生的事", async (t) => {
  const bodies = [];
  const { mock, sentText } = await setup(t, {
    bindings: { [USER]: BOUND },
    rioChat: true,
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ text: "哼哼。", emotion: "neutral", scene: "ordinary", expressionIds: [] }) } }] }) };
    },
  });
  mock.groupMessage({ text: "今天状态真差", userId: "10086", messageId: 8001 });   // 普通闲聊，没 @
  await settle();
  mock.groupMessage({ text: "帮我查一下 id870 的成绩", at: 10001, messageId: 8002 });
  await settle(300);

  const context = bodies[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(context, /今天状态真差/, "刚说过的闲聊要作为上下文送进去");
  assert.match(context, /不要逐条回应/, "要让模型知道这是背景，不是要逐条回");
  // 触发那句自己不该被重复塞进上下文
  assert.equal(context.includes("帮我查一下 id870 的成绩"), false, "触发消息不该在上下文里重复出现");
  assert.match(sentText("send_group_msg"), /哼哼/);
});

test("@机器人 闲聊不触发查询", async (t) => {
  const { mock, sentText } = await setup(t, {
    bindings: { [USER]: BOUND },
    rioChat: true,
    fetchImpl: chatReply({ text: "那当然，我可是超绝最强的！", emotion: "proud", scene: "ordinary", expressionIds: [] }),
  });
  mock.groupMessage({ text: "你是不是又在吹自己啦", at: 10001, messageId: 7003 });
  await settle(300);

  assert.match(sentText("send_group_msg"), /超绝最强/);
  assert.equal(mock.find("send_group_msg").some((r) => (r.params.message || []).some((s) => s.type === "image")), false);
});
