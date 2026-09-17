"use strict";
// Takase Bot 的 QQ 入口（个人号 / NapCat + OneBot 11）。
//
// 与 Discord 版共用 takase-core.cjs（曲库检索、凭据库、渲染调用）。
// 平台差异全部关在 qq-onebot.cjs（传输）和本文件（命令与回复模型）里。

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createOneBot } = require("./qq-onebot.cjs");
const core = require("../takase-core.cjs");
const { loadSettings: loadRioSettings, createChat: createRioChat } = require("../rio-chat/chat.cjs");

const VERSION = "1.1.0-qq-full";
const SESSION_TTL_MS = 5 * 60 * 1000;
const BIND_MAX_EMAIL_ATTEMPTS = 3;

// ── 配置 ────────────────────────────────────────────────────────────
const REQUIRED_KEYS = ["oneBotToken", "qqNumber", "workDir", "outputDir", "corePath", "vaultPath", "vaultHelperPath"];

function validateConfig(config) {
  for (const key of REQUIRED_KEYS) {
    if (!String(config[key] || "").trim()) throw new Error("启动配置缺少 " + key);
  }
  // QQ 号与群号是 5-11 位纯数字，和 Discord 的 17-20 位 snowflake 完全不同
  if (!/^\d{5,11}$/.test(String(config.qqNumber).trim())) throw new Error("机器人 QQ 号格式不正确");
  if (!Array.isArray(config.allowedGroupIds) || config.allowedGroupIds.length === 0) {
    throw new Error("至少需要一个允许的群号（群白名单为空时拒绝启动，避免误入陌生群）");
  }
  for (const id of config.allowedGroupIds) {
    if (!/^\d{5,11}$/.test(String(id).trim())) throw new Error("群号格式不正确：" + id);
  }
  for (const key of ["corePath", "vaultHelperPath"]) {
    if (!fs.existsSync(config[key])) throw new Error("运行组件缺失：" + config[key]);
  }
  if (String(config.proxyUrl || "").trim() && !/^https?:\/\/[^\s]+$/i.test(String(config.proxyUrl).trim())) {
    throw new Error("代理地址必须以 http:// 或 https:// 开头");
  }
  if (config.aliasDeleteQqs !== undefined) {
    if (!Array.isArray(config.aliasDeleteQqs)) throw new Error("aliasDeleteQqs 必须是 QQ 号数组");
    for (const id of config.aliasDeleteQqs) {
      if (!/^\d{5,11}$/.test(String(id).trim())) throw new Error("aliasDeleteQqs 里的 QQ 号格式不正确：" + id);
    }
  }
}

// ── 命令解析 ────────────────────────────────────────────────────────
// 群里必须带 # 前缀（避免对闲聊响应，也压低风控）；私聊里裸关键字也可以，
// 但绑定会话进行中时状态机独占裸文本，带前缀的命令永远优先。
const COMMANDS = Object.freeze({
  help: "帮助",
  bind: "绑定",
  chart: "分表",
  plate: "牌子",
  song: "单曲",
  chartinfo: "谱面分析",
  constant: "定数表",
  level: "等级",
  calculate: "计算",
  aliasadd: "添加别名",
  aliasdelete: "删除别名",
  aliases: "查看别名",
  whatis: "是什么歌",
  allow: "允许查询",
  deny: "禁止查询",
  status: "状态",
  unbind: "解绑",
  cancel: "取消",
});

const ALIASES = Object.freeze({
  help: ["帮助", "help", "幫助", "菜单", "指令"],
  bind: ["绑定", "bind", "綁定", "登录", "登陆"],
  chart: ["分表", "chart", "b50", "成绩图"],
  plate: ["牌子", "plate", "完成度"],
  song: ["单曲", "song", "歌曲"],
  chartinfo: ["谱面分析", "譜面分析", "chartinfo", "谱面"],
  constant: ["定数表", "定數表", "constant", "定数"],
  level: ["等级", "等級", "level", "lv"],
  calculate: ["计算", "計算", "calculate", "rating"],
  aliasadd: ["添加别名", "新增別名", "aliasadd"],
  aliasdelete: ["删除别名", "刪除別名", "aliasdelete"],
  aliases: ["查看别名", "查看別名", "aliases"],
  whatis: ["是什么歌", "是什麼歌", "whatis"],
  allow: ["允许查询", "允許查詢", "开放查询", "開放查詢", "allowquery", "允许别人查我"],
  deny: ["禁止查询", "禁止查詢", "关闭查询", "關閉查詢", "denyquery", "禁止别人查我"],
  status: ["状态", "status", "狀態"],
  unbind: ["解绑", "unbind", "解綁"],
  cancel: ["取消", "cancel", "取消绑定"],
});

const LOOKUP = new Map();
for (const [name, words] of Object.entries(ALIASES)) {
  for (const word of words) LOOKUP.set(word.toLowerCase(), name);
}

function parseCommand(text) {
  const raw = String(text || "").normalize("NFKC").trim();
  const match = raw.match(/^[#＃/]\s*([^\s]+)\s*([\s\S]*)$/);
  if (!match) return null;
  const name = LOOKUP.get(match[1].toLowerCase());
  return name ? { name, rest: match[2].trim() } : { name: null, rest: match[2].trim() };
}

// ── 入口工厂 ────────────────────────────────────────────────────────
function createQqBot(config, deps = {}) {
  const log = deps.log || ((text) => core.emit("BOT_LOG", text));
  const now = deps.now || Date.now;
  const logError = (error) => core.emit("BOT_ERROR", core.safeError(error));

  // 删除别名的白名单：**只认名单里的 QQ 号**，不看群角色，而且只走 #删除别名 这条命令。
  // 名单放在 qq-config.json 而不是源码里 —— qq-entry.cjs 会同步进公开仓库，
  // 写死等于把号一起公开。没配就是谁都不能删（失败往安全的方向倒）。
  const aliasDeleteQqs = new Set((config.aliasDeleteQqs || []).map((id) => String(id).trim()));

  const sessions = new Map();     // user_id -> {state, email, attempts, startedAt, groupId}
  const queue = [];
  const queuedUsers = new Set();
  const lastGenerateAt = new Map();
  let busy = false;
  let currentOperation = "空闲";
  let rioChat = null;
  let napCatTimer = null, napCatOnline = null;   // NapCat 连接状态，供 GUI 亮灯
  const startedAt = now();

  const onebot = createOneBot({
    port: config.oneBotPort ?? 8790,
    token: config.oneBotToken,
    log,
    now,
    random: deps.random,
    minSendIntervalMs: config.minSendIntervalMs,
    jitterMs: config.jitterMs,
    perGroupIntervalMs: config.perGroupIntervalMs,
    perUserIntervalMs: config.perUserIntervalMs,
    perGroupPerHour: config.perGroupPerHour,
    perUserPerHour: config.perUserPerHour,
    dailyCap: config.dailyCap,
    duplicateWindowMs: config.duplicateWindowMs,
    // 连上后忽略最初几秒（NapCat 可能重投缓冲事件）；测试里设 0
    coldStartMs: config.coldStartMs,
  });

  const escape = (value) => String(value ?? "");   // QQ 不渲染 markdown，不做转义

  // ── 发送 ──────────────────────────────────────────────────────────
  // @ 段只用手里的 user_id 拼，永不从用户文本构造 —— 这是 allowedMentions 的结构性替代
  function at(userId) { return { type: "at", data: { qq: String(userId) } }; }
  function segments(text, userId) {
    const parts = [];
    if (userId) parts.push(at(userId), { type: "text", data: { text: " " } });
    parts.push({ type: "text", data: { text } });
    return parts;
  }

  async function sayGroup(groupId, text, userId) {
    return onebot.call("send_group_msg", { group_id: Number(groupId), message: segments(text, userId) });
  }
  async function sayPrivate(userId, text) {
    return onebot.call("send_private_msg", { user_id: Number(userId), message: segments(text) });
  }

  // 「回答跟着命令走」：回执、结果、失败都回到命令发出的地方。
  // 「提醒走私聊」：未绑定 / 冷却中这类引导用 sayPrivateOrGroup，不占群里的版面。
  function sayOrigin(event, text) {
    return event.message_type === "group"
      ? sayGroup(event.group_id, text, event.user_id)
      : sayPrivate(event.user_id, text);
  }

  // 优先私聊；私聊失败（非好友）就退回群里 @ 作者，并按用户节流，避免变成刷屏源
  const fallbackAt = new Map();
  async function sayPrivateOrGroup(event, text) {
    if (event.message_type === "private") return sayPrivate(event.user_id, text);
    try {
      return await sayPrivate(event.user_id, text);
    } catch {
      const key = String(event.user_id);
      if ((fallbackAt.get(key) || 0) > now() - 5 * 60 * 1000) return null;   // 5 分钟内只兜底一次
      fallbackAt.set(key, now());
      return sayGroup(event.group_id, text, event.user_id);
    }
  }

  // 分表 PNG 有 5-6 MiB，走临时文件而不是 base64（base64 会让体积涨 1/3，
  // 而 NapCat 拿到 base64 后本来也要解码落盘）。发完立即删除。
  const outbox = path.join(config.workDir, "outbox");
  async function sendImage(event, image, caption, kind = "") {
    fs.mkdirSync(outbox, { recursive: true });
    const { width, height } = core.pngSize(image.buffer);   // 顺带记录尺寸，便于排查 QQ 拒收
    if (config.maxImageBytes && image.buffer.length > config.maxImageBytes) {
      throw new Error("图片 " + (image.buffer.length / 1048576).toFixed(1) + " MiB 超过上限");
    }
    const file = path.join(outbox, "chart-" + now() + "-" + Math.floor((deps.random || Math.random)() * 1e6) + ".png");
    fs.writeFileSync(file, image.buffer);
    log("正在发送分表图片 " + width + "x" + height + "，" + (image.buffer.length / 1048576).toFixed(1) + " MiB");
    try {
      // Windows 下要三个斜杠 + 正斜杠
      const uri = "file:///" + file.replace(/\\/g, "/");
      const message = [
        { type: "image", data: { file: uri, summary: "[分表]" } },
        // 图片段本身就独占一行，说明文字前面再加 \n 会多出一个空行
        { type: "text", data: { text: caption } },
      ];
      if (event.message_type === "group") {
        const sent = await onebot.call("send_group_msg", { group_id: Number(event.group_id), message });
        // 图也算群上下文。记的不只是「出了张图」——带上生成它用的数据摘要
        // （RATING、各难度技术分…），模型才能回答「他这首歌打多少分」这种追问。
        rememberGroupMessage(event.group_id, "梨绪", core.describeImage(kind, image, caption) + "（图片）", sent?.message_id);
        return sent;
      }
      return await onebot.call("send_private_msg", { user_id: Number(event.user_id), message });
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
  }

  async function sendLocalImage(event, file, text) {
    const uri = "file:///" + path.resolve(file).replace(/\\/g, "/");
    const message = [
      { type: "text", data: { text: String(text || "") } },
      { type: "image", data: { file: uri, summary: "[梨绪表情]" } },
    ];
    return event.message_type === "group"
      ? onebot.call("send_group_msg", { group_id: Number(event.group_id), message })
      : onebot.call("send_private_msg", { user_id: Number(event.user_id), message });
  }

  // ── 队列与冷却 ────────────────────────────────────────────────────
  function queuePosition() { return queue.length + (busy ? 1 : 0); }

  function enqueue(task) {
    if (queue.length >= core.MAX_QUEUE) return false;
    queue.push(task);
    void pumpQueue();
    return true;
  }

  async function pumpQueue() {
    if (busy || queue.length === 0) return;
    const task = queue.shift();
    busy = true;
    currentOperation = task.label;
    core.emit("BOT_BUSY", currentOperation);
    try { await task.run(); }
    catch (error) { logError(error); }
    finally {
      if (task.userKey) queuedUsers.delete(task.userKey);
      busy = false;
      currentOperation = "空闲";
      core.emit("BOT_BUSY", "0");
      void pumpQueue();
    }
  }

  // ── 群上下文 ──────────────────────────────────────────────────────
  // 群里最近说过的话。@ 我的时候一起交给模型 —— 否则「这个人」「刚才那张图」
  // 它接不上（会话记忆是按用户隔离的，只存它自己回复过的文字）。
  // 只记群里本来就公开可见的内容；图片只记「有人发了张图」，内容读不到（模型没有视觉）。
  const groupContext = new Map();          // groupId -> [{at, who, text}]
  const CONTEXT_MESSAGES = 12;             // 每群最多留几条
  const CONTEXT_TTL_MS = 10 * 60 * 1000;   // 超过 10 分钟的不再当作上下文
  const CONTEXT_MAX_CHARS = 900;           // 拼成提示词时的总长上限

  function senderName(event) {
    return String(event.sender?.card || event.sender?.nickname || event.user_id || "某人").slice(0, 20);
  }

  // 把消息段压成一行可读摘要：上下文里要能看出「有人发了张图」「有人被 @ 了」
  function summarizeSegments(message, selfId) {
    if (!Array.isArray(message)) return String(message || "");
    return message.map((segment) => {
      const type = segment?.type;
      if (type === "text") return String(segment.data?.text || "");
      if (type === "at") return String(segment.data?.qq) === String(selfId) ? "@我" : "@" + String(segment.data?.qq || "某人");
      if (type === "image") return "[图片]";
      if (type === "face") return "[表情]";
      if (type === "record") return "[语音]";
      if (type === "reply") return "[回复]";
      return "[" + String(type || "?") + "]";
    }).join("").replace(/\s+/g, " ").trim();
  }

  function rememberGroupMessage(groupId, who, text, messageId) {
    if (!groupId) return;
    const line = String(text || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!line) return;
    const list = groupContext.get(String(groupId)) || [];
    list.push({ at: now(), who: String(who || "?").slice(0, 20), text: line });
    while (list.length > CONTEXT_MESSAGES) list.shift();
    groupContext.set(String(groupId), list);
    // 12 条窗口外的消息会在下面按 id 另存一份，供「引用 + @我」时回捞
    archiveForQuote(groupId, messageId, who, text);
  }

  function groupContextText(groupId, skipLast = 0) {
    const list = (groupContext.get(String(groupId)) || [])
      .filter((item) => now() - item.at < CONTEXT_TTL_MS)
      .slice(0, skipLast ? -skipLast : undefined);
    const lines = [];
    let total = 0;
    for (const item of list.slice().reverse()) {   // 从最近往回取，保证最近的一定在
      const line = new Date(item.at).toTimeString().slice(0, 5) + " " + item.who + "：" + item.text;
      if (total + line.length > CONTEXT_MAX_CHARS) break;
      total += line.length;
      lines.unshift(line);
    }
    return lines;
  }

  // ── 被引用的消息 ──────────────────────────────────────────────────
  // 「引用 + @我」问的是引用那条，而它多半早就滑出 12 条窗口了。模型只看得到
  // 「[回复]」时会当成没发生过（「我什么时候推荐过歌？」），所以引用谁就补谁：
  // 先翻自己留的底（零延迟、包含 bot 自己发过的），再问 NapCat 要。
  const quotedArchive = new Map();          // "groupId:messageId" -> {at, gid, who, text}
  const ARCHIVE_TTL_MS = 60 * 60 * 1000;    // 留一小时，够接住「你刚才为什么…」
  const ARCHIVE_PER_GROUP = 400;            // 每群最多留几条
  const QUOTED_MAX_CHARS = 400;             // 送进提示词的长度上限（比上下文那条宽）

  function archiveForQuote(groupId, messageId, who, text) {
    if (!messageId) return;
    const gid = String(groupId);
    const body = String(text || "").replace(/\s+/g, " ").trim().slice(0, QUOTED_MAX_CHARS);
    if (!body) return;
    quotedArchive.set(gid + ":" + String(messageId), { at: now(), gid, who: String(who || "?").slice(0, 20), text: body });
    // 顺手清理：先删过期的，再删本群超量的最旧几条（Map 按插入顺序遍历）
    let kept = 0;
    for (const [key, item] of quotedArchive) {
      if (now() - item.at > ARCHIVE_TTL_MS) quotedArchive.delete(key);
      else if (item.gid === gid && ++kept > ARCHIVE_PER_GROUP) quotedArchive.delete(key);
    }
  }

  // 引用目标在提示词里的那一行。bot 自己的话要标明 —— 「这是你自己说的」和
  // 「这是别人说的」对模型是两件事（截图里那句「我什么时候推荐过歌」就是这么来的）。
  // get_msg 只给昵称，所以「是不是我」得单独判，不能靠名字。
  function quotedLine(who, at, text, isSelf) {
    const name = isSelf ? "梨绪（我自己）" : String(who || "某人");
    return new Date(Number(at) || now()).toTimeString().slice(0, 5) + " " + name + "：" + text;
  }

  function replyIdOf(event) {
    if (Array.isArray(event.message)) {
      const segment = event.message.find((item) => item?.type === "reply");
      return segment?.data?.id ? String(segment.data.id) : "";
    }
    const match = String(event.raw_message || "").match(/\[CQ:reply,[^\]]*\bid=(\d+)/);
    return match ? match[1] : "";
  }

  // 拿不到就当没引用：宁可少一段上下文，也不能因为读不到引用就把回复卡住
  async function quotedContext(event) {
    const id = replyIdOf(event);
    if (!id || !/^\d+$/.test(id) || !event.group_id) return "";
    const cached = quotedArchive.get(String(event.group_id) + ":" + id);
    if (cached) return quotedLine(cached.who, cached.at, cached.text, cached.who === "梨绪");
    try {
      const data = await onebot.call("get_msg", { message_id: Number(id) });
      // 只认本群的消息：把别的群的内容当上下文，等于往提示词里塞不相干的东西
      if (data?.group_id && String(data.group_id) !== String(event.group_id)) return "";
      const text = summarizeSegments(data?.message, config.qqNumber).slice(0, QUOTED_MAX_CHARS);
      if (!text) { log("引用的消息没有可读内容（id=" + id + "）"); return ""; }
      const sender = data?.sender || {};
      return quotedLine(sender.card || sender.nickname || sender.user_id || "某人", Number(data?.time) * 1000, text,
        String(sender.user_id) === String(config.qqNumber));
    } catch (error) {
      log("引用消息读取失败（" + id + "）：" + core.safeError(error));
      return "";
    }
  }

  // ── @ 到的人 ──────────────────────────────────────────────────────
  // 支持「帮我查一下 @某人 的成绩」。只有本条消息真的 @ 过的人才会被采纳 ——
  // 模型编不出一个不存在的人来查，这是这道功能的隐私边界。
  function mentionedQqs(event) {
    const ids = [];
    if (Array.isArray(event.message)) {
      for (const segment of event.message) if (segment?.type === "at" && segment.data?.qq) ids.push(String(segment.data.qq));
    } else {
      for (const match of String(event.raw_message || "").matchAll(/\[CQ:at,qq=(\d+)/g)) ids.push(match[1]);
    }
    return [...new Set(ids)].filter((qq) => qq !== String(config.qqNumber));
  }

  // 数组格式的 at 段里通常没有昵称，得问 NapCat 要一次；之后缓存一小时。
  // 拿不到名字就用 QQ 号顶着——不影响能不能查，只影响模型认不认得出「小明」。
  const memberNames = new Map();
  const MEMBER_NAME_TTL_MS = 60 * 60 * 1000;
  async function memberName(groupId, qq) {
    const key = groupId + ":" + qq;
    const cached = memberNames.get(key);
    if (cached && now() - cached.at < MEMBER_NAME_TTL_MS) return cached.name;
    let name = "";
    try {
      const info = await onebot.call("get_group_member_info", { group_id: Number(groupId), user_id: Number(qq) });
      name = String(info?.card || info?.nickname || "").trim();
    } catch { /* 查不到就退回 QQ 号 */ }
    if (name) memberNames.set(key, { name, at: now() });
    return name || String(qq);
  }

  async function mentionHint(event, qqs) {
    if (!qqs.length) return "";
    const described = [];
    for (const qq of qqs) described.push((await memberName(event.group_id, qq)) + "（编号 " + qq + "）");
    return "\n本条消息 @ 了：" + described.join("、") +
      "。要查的是别人时，在 action 里加 \"target\":\"对方的编号\"；查自己、或没提到别人时不要加 target。";
  }

  // 命令解析只看文字段：@ 段不该混进参数里（「#单曲 @某人 id870」）
  function textOnly(event) {
    if (!Array.isArray(event.message)) return String(event.raw_message || "").replace(/\[CQ:[^\]]*\]/g, " ");
    return event.message.filter((segment) => segment?.type === "text").map((segment) => String(segment.data?.text || "")).join("");
  }

  // ── 会话 ──────────────────────────────────────────────────────────
  function getSession(userId) {
    const session = sessions.get(String(userId));
    if (!session) return null;
    if (now() - session.startedAt > SESSION_TTL_MS) { sessions.delete(String(userId)); return null; }
    return session;
  }
  function endSession(userId) {
    const session = sessions.get(String(userId));
    if (session) session.email = "";
    sessions.delete(String(userId));
  }

  // ── 绑定流程 ──────────────────────────────────────────────────────
  async function startBind(event) {
    const session = { state: "awaitingEmail", email: "", attempts: 0, startedAt: now(), groupId: event.message_type === "group" ? event.group_id : null };
    sessions.set(String(event.user_id), session);
    // 语气可以活泼，但密码相关的三条提醒保持直白——那几句不能靠语气传达
    await sayPrivate(event.user_id, [
      "好，那来绑大饼（u.otogame.net）账号吧！",
      "先发我邮箱，再单独发密码。",
      "",
      "几件事先说清楚：",
      "· 密码会留在 QQ 聊天记录里，发完请长按那条消息撤回",
      "· 我不会回显你的密码，也不会写进日志",
      "· 随时发 #取消 可以中断",
    ].join("\n"));
  }

  async function continueBind(event, text) {
    const session = getSession(event.user_id);
    if (!session) return false;

    if (session.state === "awaitingEmail") {
      const email = String(text).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        session.attempts += 1;
        if (session.attempts >= BIND_MAX_EMAIL_ATTEMPTS) {
          endSession(event.user_id);
          await sayPrivate(event.user_id, "邮箱连错 " + BIND_MAX_EMAIL_ATTEMPTS + " 次，我先放弃啦。想再试就发一句 #绑定。");
          return true;
        }
        await sayPrivate(event.user_id, "这个看着不像邮箱呀，再发一次？（还剩 " + (BIND_MAX_EMAIL_ATTEMPTS - session.attempts) + " 次机会）");
        return true;
      }
      session.email = email;
      session.state = "awaitingPassword";
      await sayPrivate(event.user_id, "邮箱收到～接下来把密码发我（发完记得撤回那条消息）：");
      return true;
    }

    if (session.state === "awaitingPassword") {
      const password = String(text);
      const { email, groupId } = session;
      session.state = "verifying";
      await sayPrivate(event.user_id, "收到！正在登录验证，等我一下……\n（现在可以撤回刚才那条密码了）");

      const userKey = "verify:" + event.user_id;
      if (queuedUsers.has(userKey)) {
        endSession(event.user_id);
        await sayPrivate(event.user_id, "你手上还有一次验证在跑呢，等它出结果再说。");
        return true;
      }
      queuedUsers.add(userKey);
      const accepted = enqueue({
        label: "正在验证 QQ 用户的账号",
        userKey,
        run: async () => {
          let secret = password;
          try {
            const playerName = await core.verifyAccount(config, email, secret, (line) => log(core.safeError(line)));
            await core.saveBinding(config, {
              userId: String(event.user_id), email, password: secret,
              playerName, boundAt: new Date().toISOString(),
            });
            await sayPrivate(event.user_id, "绑定成功：" + escape(playerName) + "！\n之后在群里发 #分表、#单曲、#等级 都能用了，也可以直接 @我用大白话问。\n（默认只有你自己能查。想让群友也能查你的成绩，发一句 #允许查询。）");
            if (groupId) await sayGroup(groupId, "绑定成功：" + escape(playerName), event.user_id);
            core.emit("BOT_BINDING_SAVED", playerName);
            core.emit("BOT_BINDING_COUNT", (await core.vaultCall(config, "count")).trim());
          } catch (error) {
            await sayPrivate(event.user_id, "绑定失败：" + core.safeError(error) + "\n检查一下账号密码，再发一句 #绑定 重来。");
            throw error;
          } finally {
            secret = "";
            endSession(event.user_id);
          }
        },
      });
      if (!accepted) {
        queuedUsers.delete(userKey);
        endSession(event.user_id);
        await sayPrivate(event.user_id, "我这边正忙不过来，等会儿再发 #绑定 试试。");
      }
      return true;
    }

    // verifying 状态下收到任何文本都只提示
    await sayPrivate(event.user_id, "正在验证，请稍候……");
    return true;
  }

  // ── 命令处理 ──────────────────────────────────────────────────────
  // 功能本身（查哪首歌、要不要绑定、发什么图）由 takase-core 的 resolveCapability
  // 统一解析，#命令 和自然语言聊天走的是同一条解析链路，只在这里决定怎么发。
  function helpText() {
    return [
      "Takase Bot QQ 版 v" + VERSION,
      "",
      "#帮助　查看本清单",
      "#绑定　绑定或更换大饼账号（请私聊我）",
      "#分表　生成自己的 B50 + N10 + P50 分表",
      "#牌子 <版本>　生成指定版本牌子完成度图",
      "#单曲 <曲名或ID>　生成单曲全难度成绩图",
      "#谱面分析 <曲名/ID 难度>　生成分数线与容错图",
      "#定数表 <14或14.2>　查询定数表（无需绑定）",
      "#等级 <14/14+/14.1/ABFB> [页码]　查询等级成绩",
      "#计算 <定数> <技术分> <铃铛> <连击>　计算单曲 Rating",
      "#添加别名 <曲目> | <别名>　添加歌曲别名",
      "#删除别名 <曲目> | <别名>　删除别名（仅指定账号，且只能在群里用这条指令）",
      "#查看别名 <曲目>　查看歌曲全部别名",
      "#是什么歌 <别名>　按别名反查歌曲",
      "#允许查询 / #禁止查询　开/关「别人能不能查我的成绩」（默认关）",
      "#状态　查看当前生成队列",
      "#解绑　删除本机保存的账号绑定",
      "",
      "绑定必须私聊我进行，请不要把邮箱密码发到群里。",
      "首次使用请先 #绑定。",
      "也可以直接 @我 用大白话提问，不用背上面的格式 —— 查分、查定数、算 Rating、",
      "加别名、查别名、开关成绩查询、看运行状态，说明白了我就能办。",
      "例如「@我 帮我给 id870 加个别名叫八爪鱼」「@我 以后别人问我成绩就给他们看」。",
      "想查群里别人的成绩就 @上他，例如「@我 帮我查一下 @某人 的闪击牌子」——只有本人开过 #允许查询 才查得到。",
    ].join("\n");
  }

  // 图片任务的唯一收口：去重、冷却、入队、出图，**不发送**。
  // 发什么、什么时候发由调用方决定 —— #命令 要先回执，聊天路径要等模型写完引出语。
  function startImageJob(event, kind, label, generate) {
    const userKey = kind + ":" + event.user_id;
    if (queuedUsers.has(userKey)) return { started: false, reason: "你手上还有一张同类的图在排队呢，等它出来再说。" };
    const remaining = core.GENERATE_COOLDOWN_MS - (now() - (lastGenerateAt.get(userKey) || 0));
    if (remaining > 0) return { started: false, reason: "刚才已经生成过一张啦，等 " + Math.ceil(remaining / 1000) + " 秒再叫我。" };
    const ahead = queuePosition();
    queuedUsers.add(userKey);
    lastGenerateAt.set(userKey, now());
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const accepted = enqueue({
      userKey, label,
      run: async () => {
        try { settle({ ok: true, image: await generate() }); }
        catch (error) { logError(error); settle({ ok: false, reason: label.replace(/^正在生成/, "") + "生成失败：" + core.safeError(error) }); }
      },
    });
    if (!accepted) {
      queuedUsers.delete(userKey);
      return { started: false, reason: "我这边排队的活儿太多了，等会儿再试。" };
    }
    return { started: true, ahead, done };
  }

  // 把一个解析结果发出去。chatLine 只在自然语言路径下非空，是模型写的引出语。
  async function dispatch(event, plan, chatLine = "") {
    if (plan.kind === "notice") return sayPrivateOrGroup(event, plan.text);   // 引导类提示不占群版面，也不带领出语
    const lead = chatLine ? chatLine + "\n" : "";
    if (plan.kind === "text") return sayOrigin(event, lead + plan.text);
    if (plan.kind === "lines") return sendLines(event, lead + plan.header, plan.lines, plan.footer);
    if (plan.kind !== "image") throw new Error("未知的能力结果类型：" + plan.kind);
    const job = startImageJob(event, plan.key, plan.label, plan.run);
    if (!job.started) return sayPrivateOrGroup(event, job.reason);
    // QQ 没有消息编辑 API：先发一条占位，完成后另发图片。聊天路径用模型那句话当占位。
    await sayOrigin(event, chatLine || (job.ahead === 0 ? "已收到，正在生成，请稍候……" : "已加入生成队列，前面还有 " + job.ahead + " 项任务。"));
    const done = await job.done;
    if (!done.ok) return sayOrigin(event, done.reason);
    return sendImage(event, done.image, plan.caption, plan.key);
  }

  async function runCapability(event, name, query, chatLine = "", target = null) {
    const plan = await core.resolveCapability(config, String(event.user_id), name, query, (line) => log(core.safeError(line)), target || event.__target || null);
    return dispatch(event, plan, chatLine);
  }

  async function handleHelp(event) { return runCapability(event, "help", ""); }
  async function handleChart(event) { return runCapability(event, "chart", ""); }

  async function sendLines(event, header, lines, footer = "") {
    const chunks = core.splitLines(header, lines, footer, 1500);
    for (const chunk of chunks) await sayOrigin(event, chunk);
  }

  async function handlePlate(event, query) { return runCapability(event, "plate", query); }
  async function handleSong(event, query) { return runCapability(event, "song", query); }
  async function handleChartInfo(event, query) { return runCapability(event, "chartinfo", query); }
  async function handleConstant(event, query) { return runCapability(event, "constant", query); }
  async function handleLevel(event, input) { return runCapability(event, "level", input); }
  async function handleCalculate(event, input) { return runCapability(event, "calculate", input); }

  async function handleAlias(event, name, input) {
    if (name === "aliasdelete" && !aliasDeleteQqs.has(String(event.user_id))) {
      return sayOrigin(event, "删除别名只对指定账号开放，你这边我不能给删。");
    }
    if (name === "whatis") {
      const needle = core.normalizeSongQuery(input);
      const matches = needle ? core.INTERNAL_SONGS.filter(song => core.getAliasStore().matches(song.id, needle)) : [];
      return sendLines(event, matches.length ? "匹配到以下别名对应的曲目：" : "没有找到这个别名。", core.songMatchLines(matches));
    }
    let query = input, alias = "";
    if (["aliasadd", "aliasdelete"].includes(name)) {
      const divider = input.indexOf("|");
      if (divider < 0) return sayOrigin(event, "用法：#" + ALIASES[name][0] + " <曲名或ID> | <别名>");
      query = input.slice(0, divider).trim(); alias = input.slice(divider + 1).trim();
    }
    const matches = core.searchSongs(query);
    if (matches.length !== 1) return sendLines(event, matches.length ? "找到多首曲目，请用完整 Song ID 明确选择：" : "没有找到曲目。", core.songMatchLines(matches));
    const song = matches[0], store = core.getAliasStore();
    if (name === "aliases") {
      const list = store.list(song.id);
      return sendLines(event, core.songMatchLines([song])[0] + " 的全部别名（" + list.length + " 个）：", list.length ? list.map(x => "• " + x) : ["暂未添加别名。"]);
    }
    try { alias = store.validateAlias(alias); }
    catch (error) { return sayOrigin(event, error.message); }
    if (name === "aliasdelete") {
      const result = store.remove(Number(song.id), alias);
      return sayOrigin(event, (result.removed ? "已删除别名：" : "这首歌没有该别名：") + alias + " → " + core.songMatchLines([song])[0]);
    }
    const result = store.add(Number(song.id), alias, event.user_id);
    const shared = core.INTERNAL_SONGS.filter(other => other.id !== song.id && store.matches(other.id, core.normalizeSongQuery(alias), true));
    return sayOrigin(event, (result.added ? "已添加别名：" : "这首歌已有该别名：") + alias + " → " + core.songMatchLines([song])[0] + (shared.length ? "\n这个别名还对应 " + shared.length + " 首歌。" : ""));
  }

  // 状态文本两处都用：#状态 命令，以及闲聊里模型挑的 status 能力 ——
  // 后者读不到 NapCat 连接状态，所以要由宿主注册进来（core 的 setStatusProvider）。
  function statusText() {
    const minutes = Math.max(0, Math.floor((now() - startedAt) / 60000));
    return [
      "Takase Bot QQ 版运行正常",
      "NapCat：" + (onebot.healthy() ? "已连接" : "未连接"),
      "登录账号：" + (onebot.state.selfId || "未知"),
      "当前：" + currentOperation,
      "等待队列：" + queue.length + " 项",
      "已运行：" + minutes + " 分钟",
    ].join("\n");
  }

  async function handleStatus(event) {
    if (event.message_type === "group") await sayGroup(event.group_id, statusText(), event.user_id);
    else await sayPrivate(event.user_id, statusText());
  }

  async function handleUnbind(event) {
    const binding = await core.getBinding(config, String(event.user_id));
    if (!binding) {
      return sayPrivateOrGroup(event, "你还没绑定过大饼账号呢，没什么可解的。");
    }
    // QQ 没有按钮，用二次确认替代
    const session = getSession(event.user_id);
    if (session?.state === "confirmUnbind") {
      endSession(event.user_id);
      await core.vaultCall(config, "delete", [String(event.user_id)]);
      core.emit("BOT_BINDING_COUNT", (await core.vaultCall(config, "count")).trim());
      return sayPrivateOrGroup(event, "账号已经删掉了。以后想用，再发一句 #绑定 就行。");
    }
    sessions.set(String(event.user_id), { state: "confirmUnbind", email: "", attempts: 0, startedAt: now(), groupId: null });
    // 窗口就是会话的 TTL，从常量推出来，别写死 —— 原来写的「60 秒」和实际的 5 分钟对不上
    return sayPrivateOrGroup(event, "确定删除吗？本机保存的账号绑定删了就找不回来了。\n" +
      Math.round(SESSION_TTL_MS / 60000) + " 分钟内再发一次 #解绑 确认。");
  }

  // 开/关「别人能不能查我的成绩」。默认关着 —— 账号密码是人家自己交上来的，
  // 拿它给别人看成绩得本人点头。
  async function handleQueryPermission(event, allowed) {
    const binding = await core.getBinding(config, String(event.user_id));
    if (!binding) return sayPrivateOrGroup(event, "你还没绑定过大饼账号呢，先发一句 #绑定。");
    await core.saveBinding(config, { ...binding, allowOthers: allowed });
    return sayPrivateOrGroup(event, allowed
      ? "好，开了。以后群里 @我 查你的成绩，我会帮他们翻——想关掉随时发 #禁止查询。"
      : "收到，关了。以后别人想查你的成绩，我一律回绝。");
  }

  async function handleCancel(event) {
    if (getSession(event.user_id)) {
      endSession(event.user_id);
      return sayPrivate(event.user_id, "已取消，那就不弄啦。想绑的时候再叫我。");
    }
    return sayPrivate(event.user_id, "当前没有进行中的操作。");
  }

  // 群里先说一声、再把步骤私聊过去。闲聊路径也走这里 —— 但只走到这里为止：
  // 邮箱密码由 continueBind 的多轮私聊流程收集，模型碰不到，也传不了。
  async function handleBind(event) {
    if (event.message_type === "group") {
      await sayGroup(event.group_id, "绑定得私聊来，步骤我已经私聊发你了。没收到的话，先加我好友试试。", event.user_id);
      try { await startBind(event); }
      catch { /* 非好友会失败，上面的群消息已经说明了 */ }
      return;
    }
    return startBind(event);
  }

  async function handleEvent(event) {
    if (!event || event.post_type !== "message") return;

    const isGroup = event.message_type === "group";
    if (isGroup && !config.allowedGroupIds.map(String).includes(String(event.group_id))) {
      log("忽略非白名单群的消息：" + event.group_id);
      return;
    }
    // 先记进群上下文。@ 我的那条也记，但聊天取上下文时会跳过它 ——
    // 否则模型会看到同一句话出现两次。放最前面是为了让「机器人的回复」排在提问之后。
    if (isGroup) rememberGroupMessage(event.group_id, senderName(event), summarizeSegments(event.message, config.qqNumber), event.message_id);
    // 群里必须带前缀；私聊里裸文本先交给绑定会话
    let command = parseCommand(textOnly(event));
    const session = getSession(event.user_id);

    // 解绑确认期间收到私聊文本，绝不能落进绑定流程 —— 那边会在末尾回一句
    // 「正在验证，请稍候……」，用户明明是来确认解绑的，只会一头雾水。
    // 裸关键字「解绑」本身也算确认：用户刚被告知「再发一次」，不一定记得带 #。
    if (!command && session?.state === "confirmUnbind" && event.message_type === "private") {
      const bare = String(event.raw_message || "").normalize("NFKC").trim().toLowerCase();
      if (LOOKUP.get(bare) === "unbind") return handleUnbind(event);
      return sayPrivate(event.user_id, "现在在等你确认解绑：要继续就再发一次 #解绑，不想解了就发 #取消。");
    }
    if (!command && session && event.message_type === "private") {
      await continueBind(event, String(event.raw_message || event.message || ""));
      return;
    }
    if (!command && event.message_type === "private") {
      const bare = String(event.raw_message || "").normalize("NFKC").trim().match(/^([^\s]+)\s*([\s\S]*)$/);
      const name = bare && LOOKUP.get(bare[1].toLowerCase());
      if (name) command = { name, rest: bare[2].trim() };
    }
    if (!command) {
      // QQ 聊天与 Discord 一致：只响应群内直接 @，不监听普通闲聊。
      if (rioChat && isGroup && mentionsSelf(event)) {
        const text = stripSelfMention(event);
        const mentions = mentionedQqs(event);
        await rioChat.handle({
          id: String(event.message_id), guildId: "qq", channelId: String(event.group_id),
          author: { id: String(event.user_id), bot: false }, content: text, __qqEvent: event,
          __context: groupContextText(event.group_id, 1),   // 跳过本条，只给「之前」的上下文
          __quoted: await quotedContext(event),             // 本条引用的那条，可能远在 12 条之外
          __mentionQqs: mentions,                            // runAction 用它校验 target
          __mentionHint: await mentionHint(event, mentions),
        });
      }
      return;
    }
    if (!command.name) {
      return sayPrivateOrGroup(event, "未知指令。发送 #帮助 查看可用指令。");
    }

    // 命令路径的「查别人」：「#单曲 @某人 id870」按 @ 的第一个人查。
    // 只在这里设置 —— 聊天路径的 target 由模型判断、并且要过 @ 名单校验，
    // 不能让它捡到这里的值，否则「@bot 小明刚才那首是什么」会跑去查小明的号。
    event.__target = (isGroup ? mentionedQqs(event)[0] : null) || null;

    log("收到指令 #" + ALIASES[command.name][0] + "（" + event.message_type + " user=" + event.user_id + "）");
    switch (command.name) {
      case "help": return handleHelp(event);
      case "bind": return handleBind(event);
      case "chart": return handleChart(event);
      case "plate": return handlePlate(event, command.rest);
      case "song": return handleSong(event, command.rest);
      case "chartinfo": return handleChartInfo(event, command.rest);
      case "constant": return handleConstant(event, command.rest);
      case "level": return handleLevel(event, command.rest);
      case "calculate": return handleCalculate(event, command.rest);
      case "aliasadd": case "aliasdelete": case "aliases": case "whatis": return handleAlias(event, command.name, command.rest);
      case "allow": return handleQueryPermission(event, true);
      case "deny": return handleQueryPermission(event, false);
      case "status": return handleStatus(event);
      case "unbind": return handleUnbind(event);
      case "cancel": return handleCancel(event);
      default: return sayPrivateOrGroup(event, "该功能暂未在 QQ 版开放。发送 #帮助 查看可用指令。");
    }
  }

  function mentionsSelf(event) {
    if (Array.isArray(event.message)) return event.message.some(segment => segment?.type === "at" && String(segment.data?.qq) === String(config.qqNumber));
    return new RegExp("\\[CQ:at,qq=" + String(config.qqNumber).replace(/\D/g, "") + "(?:,[^\\]]*)?\\]").test(String(event.raw_message || ""));
  }

  function stripSelfMention(event) {
    if (Array.isArray(event.message)) return event.message
      .filter(segment => !(segment?.type === "at" && String(segment.data?.qq) === String(config.qqNumber)))
      .map(segment => segment?.type === "text" ? String(segment.data?.text || "") : "").join("").trim();
    return String(event.raw_message || "").replace(new RegExp("\\[CQ:at,qq=" + String(config.qqNumber).replace(/\D/g, "") + "(?:,[^\\]]*)?\\]", "g"), "").trim();
  }

  async function start() {
    // 目录必须先建：别名库和凭据库都落在 workDir 下
    fs.mkdirSync(config.workDir, { recursive: true });
    fs.mkdirSync(config.outputDir, { recursive: true });
    core.configureFormatting({ escapeText: escape });   // QQ 不转义 markdown
    core.configureAliases({ ...config, aliasScope: "qq" });
    // resolveCapability 里少数几处必须写命令的地方，换成本平台的说法
    core.configureCapabilities({
      // 查别人时的两种回绝。要写清楚原因和「怎么才能开」，别让人以为是机器人坏了
      targetNotBound: [
        "TA 还没绑定过大饼账号，我手里没有 TA 的数据，查不了。",
        "TA 没绑过账号呀，我上哪儿给 TA 翻成绩去。",
      ],
      targetNotAllowed: [
        "TA 没开放成绩查询，我不能替 TA 查。TA 想开的话，发一句 #允许查询 就行。",
        "这个不行——TA 没把成绩开放给别人查。TA 自己发 #允许查询 就能开了。",
      ],
      // 多句说法轮着用：这条提示出现得最频繁，老说同一句就像系统通知
      bindNotice: [
        "唔，你还没把大饼账号交给我呢。私聊发我一句 #绑定，我这就帮你连上，成绩随时翻给你看。",
        "查成绩之前得先绑账号呀 —— 私聊我发 #绑定，一分钟的事。",
        "你还没绑定哦。私聊发一句 #绑定 把账号交给我，之后想查什么尽管说。",
      ],
      helpText: helpText(),
      chartInfoUsage: "请写明曲名或 Song ID 和难度，例如：#谱面分析 id870 master",
      levelUsage: "用法：#等级 <14/14+/14.1/ABFB> [1-99页码]",
      constantUsage: "请输入 0–20 的整数或一位小数，例如：#定数表 14.2",
      calculateUsage: "用法：#计算 <定数> <技术分> <none/fb> <none/fc/ab/ab-plus>\n例如：#计算 14.2 1000737 fb none",
      // 闲聊也能触发的几条，文案里的命令要写成 QQ 的说法（默认值是 Discord 的斜杠）
      aliasUsage: "请把曲目和别名用竖线分开，例如：id870 | 八爪鱼。曲目可以是曲名、已有别名或 Song ID。",
      bindUsage: "绑定得私聊来 —— 私聊发我一句 #绑定，我带你填账号。别把邮箱密码发在群里。",
      allowDone: [
        "好，开了。以后有人 @ 我查你的成绩，我就帮他们翻。想关掉随时说一声。",
        "行，开了。以后群里问起你的成绩我就不藏着掖着了，不想给看了再叫一声。",
      ],
      denyDone: [
        "收到，关了。以后别人想查你的成绩，我一律回绝。",
        "好，关了。往后谁问你的成绩我都不说，放心。",
      ],
      statusUnavailable: "我现在没法自查状态，这条功能暂时没开。",
    });
    // 状态能力靠它取文本：core 读不到 NapCat 的连接状态和队列
    core.setStatusProvider(statusText);
    if (!aliasDeleteQqs.size) {
      log("提示：qq-config.json 里没配 aliasDeleteQqs，删除别名现在对谁都不可用（#删除别名 一律回绝）");
    }
    sweepOutbox();

    try {
      const root = config.rioChatDir || path.join(path.dirname(config.corePath), "rio-chat");
      const rio = loadRioSettings(root);
      if (rio) {
        rioChat = createRioChat(rio, { guildId: "qq", channelIds: config.allowedGroupIds.map(String), proxyUrl: config.proxyUrl }, {
          log,
          ...(deps.chat || {}),
          adapter: {
            ability: (message) => "运行时实际能力：你正在 QQ 群中回复直接 @ 你的消息。可以按语境发送梨绪表情。用户想查成绩、查定数、算 Rating、加歌曲别名、查别名、开关成绩查询、问机器人状态、想绑定账号时可以调用工具，结果和图片由程序发送。" +
              "绑定工具只把用户引到私聊流程，你自己绝不能索要、接收或转述邮箱和密码。" +
              "删除别名你没有这个工具，用户要删就告诉他用 #删除别名 指令，而且只有指定账号能用。" + (message.__mentionHint || ""),
            actions: core.CAPABILITY_SPECS,
            actionTarget: true,
            personalRecommendationNotice: message => require('../rio-chat/personal-recommendation.cjs').bindingNotice(
              id=>core.getBinding(config,id),String(message.author.id),message.__mentionQqs||[],
              '请私聊我发送 #绑定。'),
            accepts: message => config.allowedGroupIds.map(String).includes(String(message.channelId)),
            extractText: message => message.content,
            typing: async () => {},
            send: async (message, text, file) => {
              const event = message.__qqEvent;
              const sent = await (file ? sendLocalImage(event, file.absoluteFile, text) : sayOrigin(event, text));
              // 自己说过的话也留一份：用户引用的常常正是 bot 上一条回复
              if (event?.message_type === "group") rememberGroupMessage(event.group_id, "梨绪", text + (file ? "（表情）" : ""), sent?.message_id);
              return sent;
            },
            // 群里最近的消息，帮模型接上「这个人」「刚才那张图」这类指代
            context: (message) => Array.isArray(message.__context) ? message.__context : [],
            // 本条引用（QQ 的「回复」）指向的那条消息，可能早就不在上下文窗口里了
            quoted: (message) => message.__quoted || "",
            // 聊天里的工具调用：和 #命令 走同一条解析链路，只是把模型那句话
            // 当作引出语先发出去。失败（未绑定、冷却、找不到曲子）时不带引出语。
            runAction: async (action, message, result) => {
              const event = message.__qqEvent;
              if (!event) return { handled: false };
              // 绑定不走 resolveCapability，也不把模型那句引出语带上 —— 那是一条要收
              // 邮箱密码的多轮私聊流程，让它经模型的手，明文密码就会作为 action 参数
              // 进到 DeepSeek 的请求体和本地会话历史里。这里只把用户引到原流程上。
              if (action.name === "bind") {
                await handleBind(event);
                return { handled: true };
              }
              // 只认本条消息真的 @ 过的人：模型给别的编号一律作废，退回查自己
              const mentioned = new Set(message.__mentionQqs || []);
              const target = action.target && mentioned.has(String(action.target)) ? String(action.target) : null;
              if (action.target && !target) log("忽略模型给的陌生查询对象：" + action.target);
              await runCapability(event, action.name, action.query, result?.text || "", target);
              return { handled: true };
            },
          },
        });
        log("梨绪聊天已启用：允许群内直接 @ 回复，可用自然语言查分");
      } else log("梨绪聊天未启用：请检查 rio-chat/config.local.json");
    } catch (error) { log("梨绪聊天配置加载失败：" + core.safeError(error)); }

    // 一致性自检必须等连接就绪再做 —— 启动瞬间 NapCat 往往还没连上来，
    // 那时调 get_login_info 只会失败，检查会被静默跳过。
    let selfChecked = false;

    await onebot.start((event) => {
      if (!selfChecked && event.post_type === "meta_event" && event.meta_event_type === "lifecycle" && event.self_id) {
        selfChecked = true;
        const actual = String(event.self_id);
        core.emit("BOT_LOG", "NapCat 已连接：self_id=" + actual);
        if (actual !== String(config.qqNumber)) {
          core.emit("BOT_ERROR", "NapCat 登录的是 " + actual + "，与配置的 " + config.qqNumber +
            " 不一致 —— 请确认扫码登录的是不是你要当机器人的那个号");
        }
        void core.vaultCall(config, "count")
          .then((count) => core.emit("BOT_BINDING_COUNT", String(count).trim()))
          .catch(() => {});
        core.emit("BOT_READY");
      }
      void handleEvent(event).catch((error) => {
        logError(error);
        if (event.post_type === "message") void sayPrivateOrGroup(event, "操作失败：" + core.safeError(error)).catch(() => {});
      });
    });
    // NapCat 连接状态上报给 GUI（那盏独立的灯）。只在变化时发，不刷日志。
    // 心跳超时也算掉线——连接还在但 NapCat 已经不发心跳，跟断开没区别。
    napCatTimer = setInterval(() => {
      const online = onebot.healthy();
      if (online === napCatOnline) return;
      const wasOnline = napCatOnline === true;
      napCatOnline = online;
      core.emit("BOT_NAPCAT", online ? "1" : "0");
      if (wasOnline && !online) log("NapCat 连接已断开，等它重连……");
    }, 2000);

    core.emit("BOT_LOG", "QQ 核心版本 " + VERSION + "，等待 NapCat 连接……");
  }

  // 崩溃可能留下未删的临时图片，启动时清掉 1 小时以上的
  function sweepOutbox() {
    try {
      if (!fs.existsSync(outbox)) return;
      const cutoff = now() - 3600000;
      for (const name of fs.readdirSync(outbox)) {
        const file = path.join(outbox, name);
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      }
    } catch { /* 清理失败不影响启动 */ }
  }

  return {
    start,
    stop: () => {
      if (napCatTimer) { clearInterval(napCatTimer); napCatTimer = null; }
      rioChat?.close();
      onebot.stop();
    },
    handleEvent, state: { onebot, sessions, queue }, config,
  };
}

// ── 启动 ────────────────────────────────────────────────────────────
async function readConfigFile(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  return JSON.parse(text);
}

async function main() {
  if (process.argv.includes("--selftest")) {
    const names = Object.keys(COMMANDS).join(",");
    const expected = "help,bind,chart,plate,song,chartinfo,constant,level,calculate,aliasadd,aliasdelete,aliases,whatis,allow,deny,status,unbind,cancel";
    if (names !== expected) throw new Error("QQ 指令定义自测失败：" + names);
    if (parseCommand("#单曲 id870")?.name !== "song" || parseCommand("/chartinfo id870 master")?.name !== "chartinfo") {
      throw new Error("QQ 完整指令解析自测失败");
    }
    if (core.searchSongs("id870")[0]?.name !== "VIIIbit Explorer" || core.searchChartInfo("id870 master").matches.length !== 1) {
      throw new Error("QQ 查分检索自测失败");
    }
    process.stdout.write("TAKASE_QQ_SELFTEST_OK v" + VERSION + "\n");
    return;
  }
  const config = process.argv[2] === "--stdin-config"
    ? JSON.parse(fs.readFileSync(0, "utf8").replace(/^﻿/, ""))
    : await readConfigFile(process.argv[2] || path.join(__dirname, "qq-config.json"));
  config.workDir = path.resolve(config.workDir);
  config.outputDir = path.resolve(config.outputDir);
  validateConfig(config);

  const bot = createQqBot(config);
  await bot.start();

  const shutdown = () => {
    core.emit("BOT_LOG", "正在断开 NapCat 连接……");
    bot.stop();
    setTimeout(() => process.exit(0), 250);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    core.emit("BOT_FATAL", core.safeError(error));
    process.exitCode = 1;
  });
}

module.exports = { createQqBot, parseCommand, validateConfig, ALIASES, COMMANDS, VERSION };
