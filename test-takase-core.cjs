"use strict";
// takase-core.cjs 的冒烟测试：确认抽取后各函数行为与抽取前一致。
const assert = require("node:assert/strict");
const core = require("./takase-core.cjs");

// 定数计算：与入口 selftest 里同样的样例
const bands = [
  [1010000, 16.2], [1007500, 15.95], [1000000, 15.45], [990000, 14.95],
  [970000, 14.2], [900000, 10.2], [800000, 8.2], [500000, 0], [499999, 0],
];
for (const [score, expected] of bands) {
  assert.ok(Math.abs(core.calculateBaseRating(14.2, score) - expected) < 1e-9, "Rating 分段 " + score);
}

const example = core.calculateSingleRating(14.2, 1000737, "fb", "none");
assert.equal(example.result, "15.74");
assert.equal(example.text, "基础分 15.49 + 成绩加成 0.2（SSS）+ 铃铛 0.05（FB）+ 连击 0（无）= 15.74");
assert.equal(core.calculateSingleRating(14.2, 1010000, "fb", "ab-plus").result, "16.90");
assert.throws(() => core.calculateSingleRating(14.25, 1000000, "none", "none"), /谱面定数/);

// 简繁检索互通
assert.ok(core.searchSongs("愛").length > 0);
assert.deepEqual(core.searchSongs("愛"), core.searchSongs("爱"));
assert.equal(core.searchSongs("id870")[0].id, 870);

// 自动补全
assert.equal(core.songAutocomplete("song", "id870")[0].value, "id870");
assert.equal(core.songAutocomplete("chartinfo", "id870 紫譜")[0].value, "id870 master");
assert.equal(core.songAutocomplete("chartinfo", "初音ミクの激唱 白谱")[0].value, "id8021 lunatic");
assert.equal(core.songAutocomplete("song", "zzzz_no_such_song").length, 0);

// 格式化：默认保持 Discord 转义不变
const sample = [{ id: 1, name: "a*b", artistName: "c_d" }];
core.configureFormatting();
assert.equal(core.songMatchLines(sample)[0], "id1　a\\*b　— c\\_d", "默认应为 Discord 转义");

// QQ 侧切成恒等转义：不渲染 markdown，不能出现裸反斜杠
const identity = (value) => String(value ?? "");
core.configureFormatting({ escapeText: identity });
assert.equal(core.songMatchLines(sample)[0], "id1　a*b　— c_d", "恒等转义应生效");
assert.equal(core.chartInfoMatchLines([{ song: sample[0], difficultyName: "MASTER" }])[0], "id1　a*b　[MASTER]　— c_d");
core.configureFormatting();
assert.equal(core.songMatchLines(sample)[0], "id1　a\\*b　— c\\_d", "应能切回 Discord 转义");

// 别名作用域校验
assert.throws(() => core.configureAliases({ vaultPath: "x/bindings.dat", aliasScope: "../坏" }), /别名作用域/);

// pngSize
const png = Buffer.alloc(24);
png.writeUInt32BE(0x89504e47, 0);
png.writeUInt32BE(0x0d0a1a0a, 4);
png.write("IHDR", 12, "ascii");
png.writeUInt32BE(1234, 16);
png.writeUInt32BE(56789, 20);
assert.deepEqual(core.pngSize(png), { width: 1234, height: 56789 });
assert.throws(() => core.pngSize(Buffer.alloc(4)), /不完整/);
assert.throws(() => core.pngSize(Buffer.alloc(24)), /不是有效的 PNG/);

// 分片：limit 收紧到 8，保证必然触发切分
const rows = Array.from({ length: 5 }, (_, i) => "行" + i);
assert.deepEqual(core.splitLines("头部", rows, "", 8), ["头部\n行0\n行1", "行2\n行3\n行4"]);
assert.deepEqual(core.splitLines("头部", rows, "", 100), ["头部\n" + rows.join("\n") + "\n"]);
const chunks = core.splitLines("头部", rows, "", 8);
assert.ok(chunks.every((chunk) => chunk.length <= 8));

// 错误脱敏
assert.match(core.safeError(new Error("密码 password=abc123 出错了")), /已隐藏/);
assert.match(core.safeError(new Error("联系 someone@example.com")), /邮箱已隐藏/);

// 能力解析：自然语言查分与 #命令 共用的那一层。
// 经由 module.exports 取 getBinding，所以这里替换掉就能完全离线跑。
(async () => {
  const realGetBinding = core.getBinding;
  core.getBinding = async (_config, userId) => (String(userId) === "bound" ? { playerName: "测试玩家" } : null);

  const unbound = await core.resolveCapability({}, "free", "song", "id870");
  assert.equal(unbound.kind, "notice");
  assert.match(unbound.text, /\/bind/);   // 默认是 Discord 说法，每句都带 /bind
  // 同一句提示反复出现会像系统通知，所以提示支持多句说法轮换
  const notices = new Set();
  for (let i = 0; i < 40; i++) notices.add((await core.resolveCapability({}, "free", "song", "id870")).text);
  assert.ok(notices.size >= 2, "未绑定提示应该在多种说法间轮换，实际只有 " + notices.size + " 句");
  assert.throws(() => core.configureCapabilities({ bindNotice: [] }), /不能为空/);
  assert.throws(() => core.configureCapabilities({ bindNotice: ["够意思", "  "] }), /不能为空/);

  const song = await core.resolveCapability({}, "bound", "song", "id870");
  assert.equal(song.kind, "image");
  assert.equal(song.key, "song");
  assert.equal(song.caption, "测试玩家 的单曲全难度成绩：id870 VIIIbit Explorer");
  assert.equal(typeof song.run, "function");

  // 多首与找不到都给候选列表，不给图片
  assert.equal((await core.resolveCapability({}, "bound", "song", "viyella")).kind, "lines");
  const missing = await core.resolveCapability({}, "bound", "song", "zzzz_no_such_song");
  assert.equal(missing.kind, "lines");
  assert.equal(missing.lines.length, 0);

  const plate = await core.resolveCapability({}, "bound", "plate", "闪击");
  assert.equal(plate.kind, "image");
  assert.equal(plate.caption, "测试玩家 的 閃撃（闪击）完成度 · ONGEKI bright MEMORY Act.2");
  assert.match((await core.resolveCapability({}, "bound", "plate", "不存在的牌子")).text, /请选择版本牌子/);

  assert.equal((await core.resolveCapability({}, "free", "chartinfo", "id870 master")).kind, "image");
  assert.equal((await core.resolveCapability({}, "free", "chartinfo", "id870")).kind, "text");

  // 算 Rating 不吃位置，自然语序也认；两种写法必须算出同一个结果
  const positional = await core.resolveCapability({}, "free", "calculate", "14.2 1000737 fb none");
  const natural = await core.resolveCapability({}, "free", "calculate", "定数14.2，技术分1000737，铃铛fb，连击ab+");
  assert.equal(positional.text, "基础分 15.49 + 成绩加成 0.2（SSS）+ 铃铛 0.05（FB）+ 连击 0（无）= 15.74");
  assert.equal(natural.text, "基础分 15.49 + 成绩加成 0.2（SSS）+ 铃铛 0.05（FB）+ 连击 0.35（AB+）= 16.09");
  // 只说「这歌我打了 1000737 分」也能算：铃铛和连击按「无」算，结果里明写出来
  assert.equal((await core.resolveCapability({}, "free", "calculate", "14.2 这歌我打了 1000737 分")).text,
    "基础分 15.49 + 成绩加成 0.2（SSS）+ 铃铛 0（无）+ 连击 0（无）= 15.69");
  // 连分数都没有才给用法
  assert.match((await core.resolveCapability({}, "free", "calculate", "怎么算 rating")).text, /定数、技术分/);

  const constant = await core.resolveCapability({}, "free", "constant", "定数表 14.2");
  assert.equal(constant.kind, "image");
  assert.equal(constant.caption, "音击定数表 · 14.2");
  assert.equal((await core.resolveCapability({}, "free", "constant", "abc")).kind, "text");

  const level = await core.resolveCapability({}, "bound", "level", "14+ 第2页");
  assert.equal(level.kind, "image");
  assert.match(level.caption, /第 2 页/);

  // 查别人：取的是对方的数据，所以对方必须绑定过、并且自己开过口
  core.getBinding = async (_config, userId) => ({
    me: { playerName: "我自己" },
    closed: { playerName: "小红" },
    open: { playerName: "小明", allowOthers: true },
  }[String(userId)] || null);
  assert.match((await core.resolveCapability({}, "me", "song", "id870", () => {}, "nobody")).text, /没绑过|还没绑定过/);
  // 提示是多句说法轮换的，断言要覆盖全部写法
  assert.match((await core.resolveCapability({}, "me", "song", "id870", () => {}, "closed")).text, /没开放|没把成绩开放/);
  const others = await core.resolveCapability({}, "me", "song", "id870", () => {}, "open");
  assert.equal(others.kind, "image");
  assert.equal(others.caption, "小明 的单曲全难度成绩：id870 VIIIbit Explorer");
  assert.match((await core.resolveCapability({}, "me", "song", "id870", () => {}, "me")).caption, /我自己/);
  // 不需要绑定的工具（定数表之类）跟 target 无关，不该被对方的状态拦住
  assert.equal((await core.resolveCapability({}, "me", "constant", "14.2", () => {}, "closed")).kind, "image");

  // 图上的数据摘要：聊天模型读不到图，但读得到这些数字 —— 这是「读懂图里是什么」的正路
  assert.equal(
    core.describeImage("song", { meta: { found: true, scores: [{ difficultyId: 3, techScore: 1008123, allBreak: true, fullCombo: true, fullBell: true }] } }, "X 的单曲成绩"),
    "X 的单曲成绩｜MASTER 1008123 AB · FC · FB");
  assert.equal(
    core.describeImage("chart", { meta: { rating: 16.749, counts: { best: 50, new: 10, platinum: 50 }, top: [{ title: "A", techScore: 1003154, allBreak: false, fullBell: true }] } }, "X 的分表"),
    "X 的分表｜RATING 16.749 · 三榜 50/10/50 曲 · 榜首 A 1003154 分 FB");
  assert.equal(core.describeImage("level", { meta: { total: 42, sssPlus: 3, sss: 10 } }, "X 的 LEVEL 14 成绩"),
    "X 的 LEVEL 14 成绩｜ALL 42 · SSS+ 3 · SSS 10");
  assert.equal(core.describeImage("plate", { meta: { summary: { master: { allBreak: 12, fullBell: 3, total: 50 } } } }, "X 的闪击完成度"),
    "X 的闪击完成度｜MASTER AB 12/50 · FB 3/50");
  assert.equal(core.describeImage("chartinfo", { meta: { difficulty: "MASTER", constant: 14.2, noteCount: 1234 } }, "谱面分析"),
    "谱面分析｜MASTER · 定数 14.2 · 音符 1234");
  // 没有摘要、摘要是空的、或该曲没记录，都只是退回原说明，不能抛
  assert.equal(core.describeImage("song", null, "X 的成绩"), "X 的成绩");
  assert.equal(core.describeImage("song", { meta: {} }, "X 的成绩"), "X 的成绩");
  assert.equal(core.describeImage("song", { meta: { found: false, scores: [] } }, "X 的成绩"), "X 的成绩｜没有该曲目的游玩记录");

  // 模型偶尔会编工具名：不能穿透到取数逻辑
  assert.equal((await core.resolveCapability({}, "free", "全部成绩", "")).kind, "notice");
  // 未绑定的能力不会去碰 vault 之外的东西
  core.getBinding = realGetBinding;

  core.configureCapabilities({ helpText: "自定义清单" });
  assert.equal((await core.resolveCapability({}, "free", "help", "")).text, "自定义清单");
  assert.throws(() => core.configureCapabilities({ helpText: " " }), /不能为空/);
  core.configureCapabilities({ helpText: core.CAPABILITY_SPECS.length + " 项功能" });

  console.log("CORE_SMOKE_OK 导出项 " + Object.keys(core).length + " 个");
})().catch((error) => { console.error(error); process.exitCode = 1; });
