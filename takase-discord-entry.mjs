import startupModule from "./discord-startup.cjs";
const { registerCommands, detail: startupErrorDetail } = startupModule;
import fs from "node:fs";
import rioChatModule from "./rio-chat/chat.cjs";
const { loadSettings: loadRioSettings, createChat: createRioChat } = rioChatModule;
import aliasStoreModule from "./song-alias-store.cjs";
const { SongAliasStore } = aliasStoreModule;
import { Converter } from "opencc-js";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import INTERNAL_SONGS from "./ongeki-music-internal.json";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

const VERSION = "1.15.1-rio-chat";
const GENERATE_COOLDOWN_MS = 60 * 1000;
// discord.js 默认只给 REST 请求 15 秒。分表图片约 5–6 MiB，经代理上传时
// 很容易超过默认值并抛出 “This operation was aborted”。
const DISCORD_REST_TIMEOUT_MS = 120 * 1000;
// Discord interaction tokens are valid for a limited time; three waiting jobs keeps the
// worst-case reply comfortably inside that window even when each render takes several minutes.
const MAX_QUEUE = 3;
const PLATE_CHOICES = Object.freeze([
  { id: "040100", nameJa: "桜撃", nameZhHans: "樱击", version: "ONGEKI" },
  { id: "040105", nameJa: "進撃", nameZhHans: "进击", version: "ONGEKI PLUS" },
  { id: "040110", nameJa: "夏撃", nameZhHans: "夏击", version: "ONGEKI SUMMER" },
  { id: "040115", nameJa: "波撃", nameZhHans: "波击", version: "ONGEKI SUMMER PLUS" },
  { id: "040120", nameJa: "赤撃", nameZhHans: "赤击", version: "ONGEKI R.E.D." },
  { id: "040125", nameJa: "皇撃", nameZhHans: "皇击", version: "ONGEKI R.E.D. PLUS" },
  { id: "040130", nameJa: "輝撃", nameZhHans: "辉击", version: "ONGEKI bright" },
  { id: "040135", nameJa: "耀撃", nameZhHans: "耀击", version: "ONGEKI bright MEMORY Act.1" },
  { id: "040140", nameJa: "閃撃", nameZhHans: "闪击", version: "ONGEKI bright MEMORY Act.2" },
  { id: "040145", nameJa: "想撃", nameZhHans: "想击", version: "ONGEKI bright MEMORY Act.3" },
  { id: "040150", nameJa: "爽撃", nameZhHans: "爽击", version: "ONGEKI Re:Fresh Act.1" },
]);
const LEVEL_CHOICES = Object.freeze([
  "0", "1", "2", "3", "4", "5", "6", "7", "7+", "8", "8+", "9", "9+",
  "10", "10+", "11", "11+", "12", "12+", "13", "13+", "14", "14+", "15", "15+",
]);
const COMMANDS = [
  new SlashCommandBuilder().setName("constant").setNameLocalizations({"zh-CN":"定数表查询","zh-TW":"定數表查詢"})
    .setDescription("Show a chart constant table, e.g. 14 or 14.2")
    .addStringOption(o=>o.setName("query").setDescription("整数查整段定数，如 14；一位小数精确查询，如 14.2").setRequired(true).setMaxLength(4)),
  new SlashCommandBuilder()
    .setName("help")
    .setNameLocalizations({ "zh-CN": "帮助", "zh-TW": "幫助" })
    .setDescription("Show Takase Bot commands")
    .setDescriptionLocalizations({ "zh-CN": "查看 Takase Bot 的功能清单", "zh-TW": "查看 Takase Bot 的功能清單" }),
  new SlashCommandBuilder()
    .setName("bind")
    .setNameLocalizations({ "zh-CN": "绑定", "zh-TW": "綁定" })
    .setDescription("Bind or replace your u.otogame account")
    .setDescriptionLocalizations({ "zh-CN": "绑定或更换自己的大饼账号", "zh-TW": "綁定或更換自己的大餅帳號" }),
  new SlashCommandBuilder()
    .setName("chart")
    .setNameLocalizations({ "zh-CN": "分表", "zh-TW": "分表" })
    .setDescription("Generate your ONGEKI B50 + N10 + P50 chart")
    .setDescriptionLocalizations({ "zh-CN": "生成自己的音击 B50 + N10 + P50 分表", "zh-TW": "生成自己的音擊 B50 + N10 + P50 分表" }),
  new SlashCommandBuilder()
    .setName("plate")
    .setNameLocalizations({ "zh-CN": "牌子", "zh-TW": "牌子" })
    .setDescription("Generate completion details for one ONGEKI version plate")
    .setDescriptionLocalizations({ "zh-CN": "查询指定版本牌子的全曲完成情况", "zh-TW": "查詢指定版本牌子的全曲完成情況" })
    .addStringOption((option) => option
      .setName("plate")
      .setNameLocalizations({ "zh-CN": "版本牌子", "zh-TW": "版本牌子" })
      .setDescription("Choose a version plate")
      .setDescriptionLocalizations({ "zh-CN": "选择要查询的牌子与对应版本", "zh-TW": "選擇要查詢的牌子與對應版本" })
      .setRequired(true)
      .addChoices(...PLATE_CHOICES.map((plate) => ({
        name: `${plate.nameJa}（${plate.nameZhHans}） / ${plate.version}`,
        value: plate.id,
      })))),
  new SlashCommandBuilder()
    .setName("song")
    .setNameLocalizations({ "zh-CN": "单曲", "zh-TW": "單曲" })
    .setDescription("Generate the all-difficulty score image for one song")
    .setDescriptionLocalizations({ "zh-CN": "按完整 Song ID 或曲名查询单曲全难度成绩", "zh-TW": "按完整 Song ID 或曲名查詢單曲全難度成績" })
    .addStringOption((option) => option
      .setName("query")
      .setNameLocalizations({ "zh-CN": "曲目", "zh-TW": "曲目" })
      .setDescription("Full Song ID, full title, or part of a title")
      .setDescriptionLocalizations({ "zh-CN": "完整 Song ID、完整曲名或部分曲名（不区分大小写）", "zh-TW": "完整 Song ID、完整曲名或部分曲名（不區分大小寫）" })
      .setRequired(true)
      .setAutocomplete(true)
      .setMaxLength(200)),
  new SlashCommandBuilder()
    .setName("chartinfo")
    .setNameLocalizations({ "zh-CN": "谱面分析", "zh-TW": "譜面分析" })
    .setDescription("Show score tolerances and platinum thresholds for one chart")
    .setDescriptionLocalizations({ "zh-CN": "查询单张谱面的分数线、判定容错和白金分", "zh-TW": "查詢單張譜面的分數線、判定容錯和白金分" })
    .addStringOption((option) => option
      .setName("query")
      .setNameLocalizations({ "zh-CN": "谱面", "zh-TW": "譜面" })
      .setDescription("Song ID or title, followed by BASIC/ADVANCED/EXPERT/MASTER/LUNATIC")
      .setDescriptionLocalizations({ "zh-CN": "曲名或 Song ID 加难度，例如 VIIIbit Explorer master", "zh-TW": "曲名或 Song ID 加難度，例如 VIIIbit Explorer master" })
      .setRequired(true)
      .setAutocomplete(true)
      .setMaxLength(220)),
  new SlashCommandBuilder()
    .setName("level")
    .setNameLocalizations({ "zh-CN": "等级", "zh-TW": "等級" })
    .setDescription("Query charts by LEVEL, exact constant, or ABFB")
    .setDescriptionLocalizations({ "zh-CN": "按显示等级、精确定数或 ABFB 查询谱面", "zh-TW": "按顯示等級、精確定數或 ABFB 查詢譜面" })
    .addStringOption((option) => option
      .setName("level")
      .setNameLocalizations({ "zh-CN": "查询条件", "zh-TW": "查詢條件" })
      .setDescription("LEVEL 14, constant 14.1, or ABFB")
      .setDescriptionLocalizations({ "zh-CN": "例如 14、14+、14.1 或 ABFB", "zh-TW": "例如 14、14+、14.1 或 ABFB" })
      .setRequired(true)
      .setMaxLength(16))
    .addIntegerOption((option) => option
      .setName("page")
      .setNameLocalizations({ "zh-CN": "页码", "zh-TW": "頁碼" })
      .setDescription("Page number, starting from 1")
      .setDescriptionLocalizations({ "zh-CN": "从 1 开始的页码，每页最多 70 张谱面", "zh-TW": "從 1 開始的頁碼，每頁最多 70 張譜面" })
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(99)),
  new SlashCommandBuilder()
    .setName("calculate")
    .setNameLocalizations({ "zh-CN": "计算", "zh-TW": "計算" })
    .setDescription("Calculate the rating for one ONGEKI chart")
    .setDescriptionLocalizations({ "zh-CN": "按谱面定数、技术分和成绩标记计算单曲 Rating", "zh-TW": "按譜面定數、技術分和成績標記計算單曲 Rating" })
    .addNumberOption((option) => option
      .setName("constant")
      .setNameLocalizations({ "zh-CN": "谱面定数", "zh-TW": "譜面定數" })
      .setDescription("Chart constant (0–20, at most one decimal place)")
      .setDescriptionLocalizations({ "zh-CN": "0–20，最多一位小数，例如 14.2", "zh-TW": "0–20，最多一位小數，例如 14.2" })
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(20))
    .addIntegerOption((option) => option
      .setName("score")
      .setNameLocalizations({ "zh-CN": "技术分", "zh-TW": "技術分" })
      .setDescription("Technical score (0–1010000)")
      .setDescriptionLocalizations({ "zh-CN": "0–1010000 的纯整数", "zh-TW": "0–1010000 的純整數" })
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(1010000))
    .addStringOption((option) => option
      .setName("bell")
      .setNameLocalizations({ "zh-CN": "铃铛加成", "zh-TW": "鈴鐺加成" })
      .setDescription("Bell bonus")
      .setDescriptionLocalizations({ "zh-CN": "选择 FB 或无", "zh-TW": "選擇 FB 或無" })
      .setRequired(true)
      .addChoices(
        { name: "无", value: "none" },
        { name: "FB", value: "fb" },
      ))
    .addStringOption((option) => option
      .setName("combo")
      .setNameLocalizations({ "zh-CN": "连击加成", "zh-TW": "連擊加成" })
      .setDescription("Combo bonus")
      .setDescriptionLocalizations({ "zh-CN": "选择 FC、AB、AB+ 或无", "zh-TW": "選擇 FC、AB、AB+ 或無" })
      .setRequired(true)
      .addChoices(
        { name: "无", value: "none" },
        { name: "FC", value: "fc" },
        { name: "AB", value: "ab" },
        { name: "AB+", value: "ab-plus" },
      )),
  new SlashCommandBuilder()
    .setName("status")
    .setNameLocalizations({ "zh-CN": "状态", "zh-TW": "狀態" })
    .setDescription("Show the current generation queue")
    .setDescriptionLocalizations({ "zh-CN": "查看 Bot 状态和分表生成队列", "zh-TW": "查看 Bot 狀態和分表生成佇列" }),
  new SlashCommandBuilder()
    .setName("unbind")
    .setNameLocalizations({ "zh-CN": "解绑", "zh-TW": "解綁" })
    .setDescription("Delete your saved u.otogame account")
    .setDescriptionLocalizations({ "zh-CN": "删除自己保存的大饼账号", "zh-TW": "刪除自己保存的大餅帳號" }),
  new SlashCommandBuilder().setName("aliasadd").setNameLocalizations({ "zh-CN": "添加别名", "zh-TW": "新增別名" })
    .setDescription("添加歌曲别名；所有成员可用")
    .addStringOption(o => o.setName("query").setNameLocalizations({ "zh-CN": "曲目", "zh-TW": "曲目" }).setDescription("部分曲名、部分已有别名或完整 Song ID").setRequired(true).setAutocomplete(true).setMaxLength(200))
    .addStringOption(o => o.setName("alias").setNameLocalizations({ "zh-CN": "别名", "zh-TW": "別名" }).setDescription("要添加的别名，最多 80 字符").setRequired(true).setMaxLength(80)),
  new SlashCommandBuilder().setName("aliasdelete").setNameLocalizations({ "zh-CN": "删除别名", "zh-TW": "刪除別名" })
    .setDescription("删除指定歌曲的一个别名（仅管理员）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("query").setNameLocalizations({ "zh-CN": "曲目", "zh-TW": "曲目" }).setDescription("部分曲名、已有别名或完整 ID，支持模糊搜索").setRequired(true).setAutocomplete(true).setMaxLength(200))
    .addStringOption(o => o.setName("alias").setNameLocalizations({ "zh-CN": "别名", "zh-TW": "別名" }).setDescription("要删除的完整别名").setRequired(true).setAutocomplete(true).setMaxLength(80)),
  new SlashCommandBuilder().setName("aliases").setNameLocalizations({ "zh-CN": "查看别名", "zh-TW": "查看別名" })
    .setDescription("查看一首歌曲的全部别名")
    .addStringOption(o => o.setName("query").setNameLocalizations({ "zh-CN": "曲目", "zh-TW": "曲目" }).setDescription("部分曲名、部分已有别名或完整 Song ID").setRequired(true).setAutocomplete(true).setMaxLength(200)),
  new SlashCommandBuilder().setName("whatis").setNameLocalizations({ "zh-CN": "是什么歌", "zh-TW": "是什麼歌" })
    .setDescription("按别名反查对应歌曲")
    .addStringOption(o => o.setName("query").setNameLocalizations({ "zh-CN": "别名", "zh-TW": "別名" }).setDescription("输入完整或部分别名，支持简繁模糊搜索").setRequired(true).setAutocomplete(true).setMaxLength(100)),
].map((command) => command.toJSON());

function emit(tag, value = "") {
  process.stdout.write(tag + (value === "" ? "" : ":" + String(value)) + "\n");
}

function safeError(error) {
  return String(error?.message || error || "未知错误")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[代理凭据已隐藏]@")
    .replace(/([\w.+-]{1,80})@([\w.-]{1,120})/g, "[邮箱已隐藏]")
    .replace(/(secret|password|passwd|token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/[A-Za-z0-9_.-]{48,}/g, "[敏感内容已隐藏]")
    .slice(0, 800);
}

const simplifySongQuery = Converter({ from: "tw", to: "cn" });

function normalizeSongQuery(value) {
  return simplifySongQuery(String(value || "")
    .normalize("NFKC")
    .replace(/[\s　]+/g, " ")
    .trim()
    .toLowerCase());
}

function normalizeLevelCommandQuery(value) {
  const query = String(value || "")
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/^LEVEL\s*/i, "")
    .replace(/^LV\.?\s*/i, "")
    .replace(/\s+/g, "");
  if (query === "ABFB" || LEVEL_CHOICES.includes(query)) return query;
  if (/^\d{1,2}\.\d$/.test(query)) {
    const constant = Number(query);
    if (constant >= 0 && constant <= 15.9) return constant.toFixed(1);
  }
  return "";
}

function levelCommandTarget(query) {
  if (query === "ABFB") return "ABFB 全难度";
  if (/^\d+\.\d$/.test(query)) return `定数 ${query}`;
  return `LEVEL ${query}`;
}

let songAliases = new SongAliasStore(null, normalizeSongQuery);

const SONG_SEARCH_INDEX = INTERNAL_SONGS.map(song => ({ song, title: normalizeSongQuery(song?.name) }));

function searchSongs(query) {
  const raw = String(query || "").normalize("NFKC").trim();
  if (!raw) return [];
  const idMatch = raw.match(/^(?:id\s*)?(\d+)$/i);
  if (idMatch) {
    const id = Number(idMatch[1]);
    return INTERNAL_SONGS.filter((song) => Number(song?.id) === id);
  }
  const needle = normalizeSongQuery(raw);
  return SONG_SEARCH_INDEX
    .filter(({ song, title }) => title.includes(needle) || songAliases.matches(song.id, needle))
    .map(({ song }) => song)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

const CHART_INFO_DIFFICULTY_ALIASES = Object.freeze(new Map([
  ["basic", 0], ["bas", 0], ["bsc", 0], ["绿", 0], ["绿谱", 0], ["緑", 0], ["緑譜", 0],
  ["advanced", 1], ["adv", 1], ["黄", 1], ["黄谱", 1], ["黃", 1], ["黃譜", 1],
  ["expert", 2], ["exp", 2], ["红", 2], ["红谱", 2], ["紅", 2], ["紅譜", 2],
  ["master", 3], ["mas", 3], ["mst", 3], ["紫", 3], ["紫谱", 3], ["紫譜", 3],
  ["lunatic", 10], ["lun", 10], ["lnt", 10], ["白", 10], ["白谱", 10], ["白譜", 10],
]));
const CHART_INFO_DIFFICULTY_NAMES = Object.freeze({ 0: "BASIC", 1: "ADVANCED", 2: "EXPERT", 3: "MASTER", 10: "LUNATIC" });
const CHART_INFO_DIFFICULTY_POSITIONS = Object.freeze({ 0: 0, 1: 1, 2: 2, 3: 3, 10: 4 });

function parseChartInfoQuery(value) {
  const normalized = String(value || "").normalize("NFKC").replace(/[\s　]+/g, " ").trim();
  const match = normalized.match(/^(.*\S)\s+(\S+)$/);
  if (!match) return null;
  const difficultyId = CHART_INFO_DIFFICULTY_ALIASES.get(match[2].toLowerCase());
  if (difficultyId === undefined) return null;
  return { songQuery: match[1].trim(), difficultyId, difficultyName: CHART_INFO_DIFFICULTY_NAMES[difficultyId] };
}

function songHasChartDifficulty(song, difficultyId) {
  const position = CHART_INFO_DIFFICULTY_POSITIONS[difficultyId];
  if (position === undefined) return false;
  const level = song?.level?.[position];
  const constant = Number(song?.const?.[position]);
  const notes = Number(song?.noteTotal?.[position]);
  return level !== null && level !== undefined && String(level).trim() !== "" && String(level) !== "-" &&
    Number.isFinite(constant) && constant >= 0 && Number.isFinite(notes) && notes > 0;
}

function searchChartInfo(value) {
  const parsed = parseChartInfoQuery(value);
  if (!parsed) return { parsed: null, matches: [] };
  const matches = searchSongs(parsed.songQuery)
    .filter((song) => songHasChartDifficulty(song, parsed.difficultyId))
    .map((song) => ({ song, difficultyId: parsed.difficultyId, difficultyName: parsed.difficultyName }));
  return { parsed, matches };
}

// Candidate values use IDs so duplicate titles and shortened labels stay unambiguous.
function songAutocomplete(commandName, value) {
  if (!["song", "chartinfo"].includes(commandName)) return [];
  const raw = String(value || "").normalize("NFKC").replace(/[\s　]+/g, " ").trim();
  let query = raw;
  let difficulties = [3, 2, 1, 0, 10];
  if (commandName === "chartinfo") {
    const parsed = parseChartInfoQuery(raw);
    if (parsed) {
      query = parsed.songQuery;
      difficulties = [parsed.difficultyId];
    } else {
      const suffix = raw.match(/^(.*\S)\s+(\S+)$/);
      const partial = suffix && [...CHART_INFO_DIFFICULTY_ALIASES]
        .filter(([alias]) => alias.startsWith(suffix[2].toLowerCase())).map(([, id]) => id);
      if (partial?.length) {
        query = suffix[1];
        difficulties = [...new Set(partial)];
      }
    }
  }
  const needle = normalizeSongQuery(query);
  const idMatch = query.match(/^(?:id\s*)?(\d+)$/i);
  const songs = SONG_SEARCH_INDEX.filter(({ song, title }) => !needle ||
    (idMatch ? String(song.id).startsWith(idMatch[1]) : title.includes(needle) || songAliases.matches(song.id, needle)))
    .sort((a, b) => {
      const rank = item => idMatch ? (String(item.song.id) === idMatch[1] ? 0 : 1)
        : item.title === needle || songAliases.matches(item.song.id, needle, true) ? 0 : item.title.startsWith(needle) ? 1 : 2;
      return rank(a) - rank(b) || Number(a.song.id) - Number(b.song.id);
    });
  const choices = [];
  for (const { song } of songs) {
    const entries = commandName === "song" ? [null] : difficulties.filter(id => songHasChartDifficulty(song, id));
    for (const id of entries) {
      const difficulty = id === null ? "" : CHART_INFO_DIFFICULTY_NAMES[id];
      choices.push({
        name: ("id" + song.id + " " + (difficulty ? "[" + difficulty + "] " : "") + song.name + " — " + (song.artistName || "")).slice(0, 100),
        value: "id" + song.id + (difficulty ? " " + difficulty.toLowerCase() : ""),
      });
      if (choices.length === 25) return choices;
    }
  }
  return choices;
}

async function handleAutocomplete(interaction, config) {
  if (assertAllowedInteraction(interaction, config)) return interaction.respond([]);
  const focused = interaction.options.getFocused(true);
  if (interaction.commandName === "aliasdelete" && focused.name === "alias") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.respond([]);
    const matches = searchSongs(interaction.options.getString("query") || "");
    const needle = normalizeSongQuery(focused.value);
    return interaction.respond(matches.length === 1 ? songAliases.list(matches[0].id)
      .filter(alias => normalizeSongQuery(alias).includes(needle)).slice(0, 25).map(alias => ({ name: alias, value: alias })) : []);
  }
  if (focused.name !== "query") return interaction.respond([]);
  if (interaction.commandName === "whatis") return interaction.respond(aliasAutocomplete(focused.value));
  const command = ["aliasadd", "aliasdelete", "aliases"].includes(interaction.commandName) ? "song" : interaction.commandName;
  return interaction.respond(songAutocomplete(command, focused.value));
}

function aliasAutocomplete(value) {
  const needle = normalizeSongQuery(value);
  const seen = new Set();
  const choices = [];
  for (const entry of songAliases.entries) {
    const key = normalizeSongQuery(entry.alias);
    if (!key.includes(needle) || seen.has(key)) continue;
    seen.add(key);
    choices.push({ name: entry.alias, value: entry.alias });
    if (choices.length === 25) break;
  }
  return choices;
}

async function replyAliasLines(interaction, header, lines, footer = "", privateReply = false) {
  const chunks = splitDiscordLines(header, lines, footer);
  for (let i = 0; i < chunks.length; i++) {
    const payload = { content: chunks[i], allowedMentions: { parse: [] }, ...(privateReply ? { flags: MessageFlags.Ephemeral } : {}) };
    if (i === 0) await interaction.reply(payload);
    else await interaction.followUp(payload);
  }
}

async function handleAliasCommand(interaction) {
  const name = interaction.commandName;
  if (name === "aliasdelete" && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: "只有服务器管理员可以删除别名。", flags: MessageFlags.Ephemeral });
  }
  const query = interaction.options.getString("query", true);
  if (name === "whatis") {
    const needle = normalizeSongQuery(query);
    const matches = needle ? INTERNAL_SONGS.filter(song => songAliases.matches(song.id, needle)) : [];
    return replyAliasLines(interaction, matches.length ? "匹配到以下别名对应的曲目：" : "没有找到这个别名。可以从输入候选中选择已登记别名，或用 /aliases 查看某首歌的全部别名。", songMatchLines(matches));
  }
  const matches = searchSongs(query);
  if (matches.length !== 1) {
    return replyAliasLines(interaction, matches.length ? "找到多首曲目，请用完整 Song ID 明确选择：" : "没有找到曲目，请检查曲名或完整 Song ID。", songMatchLines(matches), "", name !== "aliasadd");
  }
  const song = matches[0];
  if (name === "aliases") {
    const aliases = songAliases.list(song.id);
    return replyAliasLines(interaction, songMatchLines([song])[0] + " 的全部别名（" + aliases.length + " 个）：",
      aliases.length ? aliases.map(alias => "• " + escapeDiscordText(alias)) : ["暂未添加别名。"]);
  }
  let alias;
  try { alias = songAliases.validateAlias(interaction.options.getString("alias", true)); }
  catch (error) { return interaction.reply({ content: error.message, ...(name === "aliasadd" ? {} : { flags: MessageFlags.Ephemeral }) }); }
  await interaction.deferReply(name === "aliasadd" ? {} : { flags: MessageFlags.Ephemeral });
  if (name === "aliasdelete") {
    const result = songAliases.remove(Number(song.id), alias);
    return interaction.editReply({ content: (result.removed ? "已删除别名：" : "这首歌没有该别名：") + escapeDiscordText(alias) + " → " + songMatchLines([song])[0], allowedMentions: { parse: [] } });
  }
  const result = songAliases.add(Number(song.id), alias, interaction.user.id);
  const shared = INTERNAL_SONGS.filter(other => other.id !== song.id && songAliases.matches(other.id, normalizeSongQuery(alias), true));
  await interaction.editReply({
    content: (result.added ? "已添加别名：" : "这首歌已有该别名（简繁、大小写视为相同）：") + escapeDiscordText(alias) + " → " + songMatchLines([song])[0] +
      (shared.length ? "\n这个别名还对应 " + shared.length + " 首歌；查询时会列出全部对应曲目。" : ""),
    allowedMentions: { parse: [] },
  });
}

function chartInfoMatchLines(matches) {
  return matches.map(({ song, difficultyName }) =>
    `id${song.id}　${escapeDiscordText(song.name)}　[${difficultyName}]　— ${escapeDiscordText(song.artistName)}`
  );
}

function calculateBaseRating(chartConstant, score) {
  if (score >= 1010000) return chartConstant + 2.0;
  if (score >= 1007500) {
    return chartConstant + 1.75 + (score - 1007500) * (2.0 - 1.75) / (1010000.0 - 1007500.0);
  }
  if (score >= 1000000) {
    return chartConstant + 1.25 + (score - 1000000) * (1.75 - 1.25) / (1007500.0 - 1000000.0);
  }
  if (score >= 990000) {
    return chartConstant + 0.75 + (score - 990000) * (1.25 - 0.75) / (1000000.0 - 990000.0);
  }
  if (score >= 970000) {
    return chartConstant + (score - 970000) * (0.75 - 0.0) / (990000.0 - 970000.0);
  }
  if (score >= 900000) {
    return chartConstant - 4.0 + (score - 900000) * (0.0 - (-4.0)) / (970000.0 - 900000.0);
  }
  if (score >= 800000) {
    return chartConstant - 6.0 + (score - 800000) * (-4.0 - (-6.0)) / (900000.0 - 800000.0);
  }
  if (score >= 500000) return (score - 500000) * (-6.0) / (800000.0 - 500000.0);
  return 0;
}

function calculateSingleRating(chartConstant, score, bellMark, comboMark) {
  if (!Number.isFinite(chartConstant) || chartConstant < 0 || chartConstant > 20 ||
      Math.abs(chartConstant * 10 - Math.round(chartConstant * 10)) > 1e-9) {
    throw new Error("谱面定数不合法：请输入 0–20，且最多一位小数（如 13、13.0、13.4）。");
  }
  if (!Number.isInteger(score) || score < 0 || score > 1010000) {
    throw new Error("技术分不合法：请输入 0–1010000 的纯整数。");
  }
  if (!new Set(["none", "fb"]).has(bellMark)) throw new Error("铃铛加成只能选择 FB 或无。");
  if (!new Set(["none", "fc", "ab", "ab-plus"]).has(comboMark)) throw new Error("连击加成只能选择 FC、AB、AB+ 或无。");

  const baseRating = calculateBaseRating(chartConstant, score);
  const scoreMark = score >= 1007500 ? "SSS+" : score >= 1000000 ? "SSS" : score >= 990000 ? "SS" : "无";
  const scoreBonus = scoreMark === "SSS+" ? 0.30 : scoreMark === "SSS" ? 0.20 : scoreMark === "SS" ? 0.10 : 0;
  const bellBonus = bellMark === "fb" ? 0.05 : 0;
  const comboBonus = comboMark === "fc" ? 0.10 : comboMark === "ab" ? 0.30 : comboMark === "ab-plus" ? 0.35 : 0;
  const total = baseRating + scoreBonus + bellBonus + comboBonus;
  const truncateTwo = (value) => Math.trunc(value * 100) / 100;
  const compact = (value) => String(truncateTwo(value));
  const comboLabel = comboMark === "fc" ? "FC" : comboMark === "ab" ? "AB" : comboMark === "ab-plus" ? "AB+" : "无";
  return {
    result: truncateTwo(total).toFixed(2),
    text: "基础分 " + truncateTwo(baseRating).toFixed(2) +
      " + 成绩加成 " + compact(scoreBonus) + "（" + scoreMark + "）" +
      "+ 铃铛 " + compact(bellBonus) + "（" + (bellMark === "fb" ? "FB" : "无") + "）" +
      "+ 连击 " + compact(comboBonus) + "（" + comboLabel + "）" +
      "= " + truncateTwo(total).toFixed(2),
  };
}

function escapeDiscordText(value) {
  return String(value || "").replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1");
}

function songMatchLines(matches) {
  return matches.map((song) => {
    const lunaticMark = song.isLunatic === true ? " [LUNATIC]" : "";
    return `id${song.id}　${escapeDiscordText(song.name)}${lunaticMark}　— ${escapeDiscordText(song.artistName)}`;
  });
}

function splitDiscordLines(header, lines, footer, limit = 1900) {
  const chunks = [];
  let current = header;
  for (const line of lines) {
    const addition = (current ? "\n" : "") + line;
    if (current && current.length + addition.length > limit) {
      chunks.push(current);
      current = line;
    } else current += addition;
  }
  const footerAddition = (current ? "\n" : "") + footer;
  if (current.length + footerAddition.length > limit) {
    if (current) chunks.push(current);
    current = footer;
  } else current += footerAddition;
  if (current) chunks.push(current);
  return chunks;
}

async function readConfig() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("未收到启动配置");
  return JSON.parse(text);
}

function validateSnowflake(value, label) {
  if (!/^\d{17,20}$/.test(String(value || "").trim())) throw new Error(label + " 格式不正确");
}

function validateConfig(config) {
  for (const key of ["applicationId", "botToken", "guildId", "workDir", "outputDir", "corePath", "vaultPath", "vaultHelperPath"]) {
    if (!String(config[key] || "").trim()) throw new Error("启动配置缺少 " + key);
  }
  validateSnowflake(config.applicationId, "Application ID");
  validateSnowflake(config.guildId, "服务器 ID");
  if (!Array.isArray(config.channelIds) || config.channelIds.length === 0) throw new Error("至少需要一个频道 ID");
  for (const channelId of config.channelIds) validateSnowflake(channelId, "频道 ID");
  for (const key of ["corePath", "vaultHelperPath"]) {
    if (!fs.existsSync(config[key])) throw new Error("运行组件缺失：" + config[key]);
  }
  if (String(config.proxyUrl || "").trim() && !/^https?:\/\/[^\s]+$/i.test(String(config.proxyUrl).trim())) {
    throw new Error("代理地址必须以 http:// 或 https:// 开头");
  }
}

function runProcess(exe, args, input = "", timeoutMs = 15000, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, env: env || process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      reject(new Error("子进程执行超时"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input, "utf8");
  });
}

async function vaultCall(config, command, args = [], input = "") {
  const result = await runProcess(config.vaultHelperPath, [command, config.vaultPath, ...args], input, 15000);
  if (result.code === 4) return null;
  if (result.code !== 0) throw new Error(result.stderr.replace(/^VAULT_ERROR:/, "").trim() || "本地加密账号库操作失败");
  return result.stdout;
}

async function getBinding(config, userId) {
  const text = await vaultCall(config, "get", [userId]);
  return text ? JSON.parse(text) : null;
}

async function saveBinding(config, entry) {
  await vaultCall(config, "set", [], JSON.stringify(entry));
}

function runCore(config, mode, job, timeoutMs, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.corePath, [mode], {
      cwd: config.workDir,
      windowsHide: true,
      env: {
        ...process.env,
        ONGEKI_APP_DIR: config.workDir,
        // 分表核心（ongeki-core）用同一代理访问 u.otogame / reiwa 渲染服务
        ONGEKI_HTTPS_PROXY: config.proxyUrl || "",
        ONGEKI_HTTP_PROXY: config.proxyUrl || "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      reject(new Error("操作超时，已中止本次任务"));
    }, timeoutMs);
    const receive = (isError, data) => {
      const text = String(data);
      if (isError) stderr += text;
      else stdout += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => receive(false, data));
    child.stderr.on("data", (data) => receive(true, data));
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.match(/(?:CONSTANT_JOB|CHART_INFO_JOB|COMPLETION_JOB|LEVEL_JOB|SONG_JOB|JOB|VERIFY)_ERROR:\s*(.+)/)?.[1] || "分表核心异常退出";
        reject(new Error(detail + "（代码 " + code + "）"));
      } else resolve({ stdout, stderr });
    });
    child.stdin.end(JSON.stringify(job), "utf8");
  });
}

async function verifyAccount(config, email, password, onLine) {
  const result = await runCore(config, "--verify-job-stdin", { email, password }, 120000, onLine);
  const playerName = result.stdout.match(/^PLAYER_NAME:(.+)$/m)?.[1]?.trim();
  if (!playerName) throw new Error("账号验证成功，但没有读取到玩家名");
  return playerName;
}

async function generateChart(config, binding, onLine) {
  const result = await runCore(config, "--job-stdin", {
    email: binding.email,
    password: binding.password,
    streamOutput: true, // 图片不落盘，以 base64 经 stdout 返回
  }, 360000, onLine);
  const streamed = result.stdout.match(/^OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64") };
  // 兼容回退：旧核心仍可能写文件，读取后立即删除
  const outputPath = result.stdout.match(/^OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer };
}

async function generateSongChart(config, binding, song, onLine) {
  const result = await runCore(config, "--song-job-stdin", {
    email: binding.email,
    password: binding.password,
    playerName: binding.playerName || "",
    songId: Number(song.id),
    streamOutput: true,
  }, 360000, onLine);
  const streamed = result.stdout.match(/^SONG_OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64") };
  const outputPath = result.stdout.match(/^SONG_OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的单曲图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer };
}

async function generateChartInfo(config, match, onLine) {
  const result = await runCore(config, "--chart-info-job-stdin", {
    songId: Number(match.song.id),
    difficultyId: Number(match.difficultyId),
    streamOutput: true,
  }, 180000, onLine);
  const summaryText = result.stdout.match(/^CHART_INFO_SUMMARY:(.+)$/m)?.[1];
  let meta = null;
  try { if (summaryText) meta = JSON.parse(summaryText); } catch {}
  const streamed = result.stdout.match(/^CHART_INFO_OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64"), meta };
  const outputPath = result.stdout.match(/^CHART_INFO_OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的谱面分析图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer, meta };
}

async function generateCompletionChart(config, binding, plate, onLine) {
  const result = await runCore(config, "--completion-job-stdin", {
    email: binding.email,
    password: binding.password,
    playerName: binding.playerName || "",
    plateId: plate.id,
    streamOutput: true,
  }, 600000, onLine);
  const summaryText = result.stdout.match(/^COMPLETION_SUMMARY:(.+)$/m)?.[1];
  let meta = null;
  try { if (summaryText) meta = JSON.parse(summaryText); } catch {}
  const streamed = result.stdout.match(/^COMPLETION_OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64"), meta };
  const outputPath = result.stdout.match(/^COMPLETION_OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的牌子完成度图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer, meta };
}

async function generateLevelChart(config, binding, level, page, onLine) {
  const result = await runCore(config, "--level-job-stdin", {
    email: binding.email,
    password: binding.password,
    playerName: binding.playerName || "",
    level,
    page,
    streamOutput: true,
  }, 600000, onLine);
  const summaryText = result.stdout.match(/^LEVEL_SUMMARY:(.+)$/m)?.[1];
  let meta = null;
  try { if (summaryText) meta = JSON.parse(summaryText); } catch {}
  const streamed = result.stdout.match(/^LEVEL_OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64"), meta };
  const outputPath = result.stdout.match(/^LEVEL_OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的等级成绩图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer, meta };
}

function helpText() {
  return [
    "**Takase Bot 功能清单**",
    "`/help`　查看本清单",
    "`/bind`　绑定或更换自己的 u.otogame 大饼账号",
    "`/chart`　生成自己的 B50 + N10 + P50 分表",
    "`/plate`　选择一个版本牌子，生成全曲 AB / FC / FB 完成情况",
    "`/song`　按 Song ID 或曲名生成单曲成绩图（简繁互通、输入补全）",
    "`/chartinfo`　输入曲名或 Song ID 加难度，生成单谱面分数线、容错与白金分分析图",
    "`/constant`　定数表查询：14 显示 14.0–14.9，14.2 精确查询；无需绑定账号",
    "`/level`　输入显示等级（14/14+）、精确定数（14.1）或 ABFB；页码默认 1，每页最多 70 张谱面",
    "`/calculate`　按谱面定数、技术分、铃铛加成、连击加成计算单曲 Rating",
    "`/status`　查看当前生成队列",
    "`/unbind`　删除本机保存的账号绑定",
    "",
    "别名命令：/aliasadd 添加别名（所有成员）；/aliasdelete 删除别名（仅管理员）；/aliases 查看某首歌全部别名；/whatis 按别名反查。查询无需绑定。",
    "首次使用请先执行 `/bind`。账号表单和结果只对你可见；请勿把邮箱、密码或 Bot Token 发到频道。",
  ].join("\n");
}

function buildBindModal() {
  const email = new TextInputBuilder()
    .setCustomId("email")
    .setLabel("大饼（u.otogame.net）的邮箱账号")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(160)
    .setPlaceholder("🔒 只有你能看见，其他人无法看见");
  const password = new TextInputBuilder()
    .setCustomId("password")
    .setLabel("大饼（u.otogame.net）的密码")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(256)
    .setPlaceholder("🔒 只有你能看见，其他人无法看见");
  return new ModalBuilder()
    .setCustomId("takase:bind")
    .setTitle("🔒 私密账号绑定")
    .addComponents(
      new ActionRowBuilder().addComponents(email),
      new ActionRowBuilder().addComponents(password),
    );
}

function assertAllowedInteraction(interaction, config) {
  if (!interaction.inGuild() || interaction.guildId !== String(config.guildId)) return "这个 Bot 仅供指定私人服务器使用。";
  if (!config.channelIds.includes(String(interaction.channelId))) return "请在指定的 Bot 频道中使用该指令。";
  return "";
}

async function selftest() {
  if (COMMANDS.length !== 15) throw new Error("指令数量自测失败");
  const names = COMMANDS.map((item) => item.name).join(",");
  if (names !== "constant,help,bind,chart,plate,song,chartinfo,level,calculate,status,unbind,aliasadd,aliasdelete,aliases,whatis") throw new Error("指令定义自测失败：" + names);
  const plateCommand = COMMANDS.find((item) => item.name === "plate");
  const plateValues = plateCommand?.options?.[0]?.choices?.map((item) => item.value) || [];
  if (PLATE_CHOICES.length !== 11 || plateValues.join(",") !== PLATE_CHOICES.map((item) => item.id).join(",")) {
    throw new Error("牌子指令选项自测失败");
  }
  const levelCommand = COMMANDS.find((item) => item.name === "level");
  const levelQuery = levelCommand?.options?.[0];
  const levelPage = levelCommand?.options?.[1];
  if (LEVEL_CHOICES.length !== 25 || levelQuery?.name !== "level" || levelQuery?.required !== true ||
      levelQuery?.max_length !== 16 || Array.isArray(levelQuery?.choices) ||
      levelPage?.name !== "page" || levelPage?.required === true || levelPage?.min_value !== 1 ||
      normalizeLevelCommandQuery("lv.14+") !== "14+" || normalizeLevelCommandQuery("14.1") !== "14.1" ||
      normalizeLevelCommandQuery("abfb") !== "ABFB" || normalizeLevelCommandQuery("14.12") !== "") {
    throw new Error("等级指令选项自测失败");
  }
  if (safeError("password=abc test@example.com token=123")?.includes("abc")) throw new Error("敏感信息过滤自测失败");
  const bindModal = JSON.stringify(buildBindModal().toJSON());
  if (!bindModal.includes("u.otogame.net") || !bindModal.includes("邮箱账号") || !bindModal.includes("密码")) {
    throw new Error("绑定窗口账号说明自测失败");
  }
  if (!bindModal.includes("私密账号绑定") || !bindModal.includes("只有你能看见，其他人无法看见")) {
    throw new Error("绑定窗口隐私提示自测失败");
  }
  const idResult = searchSongs("id870");
  const titleResult = searchSongs("VIIIbit Explorer");
  const partialResult = searchSongs("viyella");
  const sameTitleResult = searchSongs("初音ミクの激唱");
  const sameTitleLines = songMatchLines(sameTitleResult);
  if (idResult.length !== 1 || idResult[0].name !== "VIIIbit Explorer" ||
      titleResult.length !== 1 || titleResult[0].id !== 870 ||
      partialResult.length !== 2 || partialResult[0].id !== 168 || partialResult[1].id !== 496 ||
      sameTitleResult.length !== 2 || sameTitleResult[0].id !== 56 || sameTitleResult[1].id !== 8021 ||
      sameTitleLines[0].includes("[LUNATIC]") || !sameTitleLines[1].includes("[LUNATIC]")) {
    throw new Error("单曲检索规则自测失败");
  }
  const chartInfoMaster = searchChartInfo("viiibit explorer master");
  const chartInfoById = searchChartInfo("id870 紫谱");
  const chartInfoLunatic = searchChartInfo("初音ミクの激唱 lunatic");
  const chartInfoInvalid = searchChartInfo("VIIIbit Explorer");
  if (chartInfoMaster.matches.length !== 1 || chartInfoMaster.matches[0].song.id !== 870 ||
      chartInfoMaster.matches[0].difficultyId !== 3 || chartInfoById.matches[0]?.song.id !== 870 ||
      chartInfoLunatic.matches.length !== 1 || chartInfoLunatic.matches[0].song.id !== 8021 ||
      chartInfoInvalid.parsed !== null || chartInfoInvalid.matches.length !== 0) {
    throw new Error("单谱面分析检索规则自测失败");
  }
  if (normalizeSongQuery("愛戀 樂曲 龍") !== normalizeSongQuery("爱恋 乐曲 龙")) throw Error("简繁标准化失败");
  for (const command of ["song", "chartinfo"]) {
    if (!COMMANDS.find(c => c.name === command).options[0].autocomplete) throw Error("自动补全未注册");
    for (const query of ["", "愛", "爱", "id87", "viyella", "初音ミクの激唱"]) {
      const choices = songAutocomplete(command, query);
      if (choices.length > 25 || new Set(choices.map(c => c.value)).size !== choices.length ||
          choices.some(c => !c.name.length || c.name.length > 100 || c.value.length > 100)) throw Error("补全长度或唯一性失败");
      for (const choice of choices) {
        const matches = command === "song" ? searchSongs(choice.value) : searchChartInfo(choice.value).matches;
        if (matches.length !== 1) throw Error("补全候选无法唯一提交：" + choice.value);
      }
    }
    if (JSON.stringify(songAutocomplete(command, "愛")) !== JSON.stringify(songAutocomplete(command, "爱"))) throw Error("简繁补全结果不同");
  }
  if (!searchSongs("愛").length || JSON.stringify(searchSongs("愛")) !== JSON.stringify(searchSongs("爱"))) throw Error("简繁检索结果不同");
  if (songAutocomplete("song", "id870")[0]?.value !== "id870" ||
      songAutocomplete("song", "zzzz_no_such_song").length ||
      songAutocomplete("chartinfo", "id870 紫譜")[0]?.value !== "id870 master" ||
      songAutocomplete("chartinfo", "id870 ma")[0]?.value !== "id870 master" ||
      songAutocomplete("chartinfo", "初音ミクの激唱 白谱")[0]?.value !== "id8021 lunatic") throw Error("自动补全筛选失败");
  const autocompleteConfig = { guildId: "g", channelIds: ["c"] };
  let autocompleteResponse;
  const mockAutocomplete = { inGuild: () => true, guildId: "g", channelId: "c", commandName: "song",
    options: { getFocused: () => ({ name: "query", value: "id870" }) }, respond: async choices => { autocompleteResponse = choices; } };
  await handleAutocomplete(mockAutocomplete, autocompleteConfig);
  if (autocompleteResponse[0]?.value !== "id870") throw Error("自动补全交互失败");
  await handleAutocomplete({ ...mockAutocomplete, channelId: "denied" }, autocompleteConfig);
  if (autocompleteResponse.length) throw Error("自动补全频道限制失败");

  const aliasTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "takase-alias-integration-"));
  const originalAliases = songAliases;
  try {
    songAliases = new SongAliasStore(path.join(aliasTestDir, "aliases.json"), normalizeSongQuery);
    const replies = [];
    const deferredReplies = [];
    const interaction = (commandName, values, admin = false) => ({
      commandName, memberPermissions: { has: permission => admin && permission === PermissionFlagsBits.Administrator }, user: { id: "test-user" },
      options: { getString: name => values[name] },
      reply: async payload => replies.push(payload), followUp: async payload => replies.push(payload),
      deferReply: async payload => deferredReplies.push({ commandName, ...payload }), editReply: async payload => replies.push(payload),
    });
    if (COMMANDS.find(c => c.name === "aliasadd").default_member_permissions != null ||
        COMMANDS.find(c => c.name === "aliasdelete").default_member_permissions !== String(PermissionFlagsBits.Administrator)) throw Error("别名命令默认权限失败");
    await handleAliasCommand(interaction("aliasadd", {query:"viyella",alias:"測試愛稱"},true));
    const ambiguousAdd = replies.pop();
    if (songAliases.entries.length || !ambiguousAdd.content.includes("多首") || ambiguousAdd.flags) throw Error("添加别名公开候选失败");
    await handleAliasCommand(interaction("aliasadd", {query:"viiibit exp",alias:"測試愛稱"}));
    if (songAliases.entries.length !== 1 || !replies.pop().content.includes("已添加")) throw Error("添加别名失败");
    await handleAliasCommand(interaction("aliasadd", {query:"id870",alias:"测试爱称"},true));
    if (songAliases.entries.length !== 1 || !replies.pop().content.includes("已有")) throw Error("重复别名处理失败");
    if (searchSongs("测试爱称")[0]?.id !== 870 || searchSongs("测试爱")[0]?.id !== 870 ||
        songAutocomplete("song","测试爱称")[0]?.value !== "id870" ||
        songAutocomplete("chartinfo","测试爱称 紫譜")[0]?.value !== "id870 master" ||
        searchChartInfo("测试爱称 mas").matches[0]?.song.id !== 870) throw Error("别名搜索或补全失败");
    await handleAliasCommand(interaction("aliases",{query:"viiibit exp"}));
    if (!replies.pop().content.includes("測試愛稱")) throw Error("查看全部别名失败");
    await handleAliasCommand(interaction("whatis",{query:"测试爱称"}));
    if (!replies.pop().content.includes("id870")) throw Error("别名反查失败");
    await handleAliasCommand(interaction("whatis",{query:"测试爱"}));
    if (!replies.pop().content.includes("id870")) throw Error("别名反查部分匹配失败");
    await handleAliasCommand(interaction("aliasadd",{query:"id168",alias:"测试爱称"},true));
    const shared = replies.pop();
    if (!shared.content.includes("还对应")) throw Error("别名多曲提示失败");
    await handleAliasCommand(interaction("whatis",{query:"測試愛稱"}));
    const reverse = replies.pop();
    if (!reverse.content.includes("id168") || !reverse.content.includes("id870")) throw Error("别名多曲反查失败");
    if (aliasAutocomplete("测试爱").length !== 1) throw Error("别名补全简繁去重失败");
    await handleAutocomplete({ ...mockAutocomplete, commandName:"whatis", options:{ getFocused:()=>({name:"query",value:"测试爱"}) } }, autocompleteConfig);
    if (autocompleteResponse[0]?.value !== "測試愛稱") throw Error("反查交互补全失败");
    await handleAutocomplete({ ...mockAutocomplete, commandName:"aliases" }, autocompleteConfig);
    if (autocompleteResponse[0]?.value !== "id870") throw Error("查看别名补全失败");
    for (const commandName of ["song", "chartinfo", "aliasadd", "aliasdelete", "aliases"]) {
      if (!COMMANDS.find(c => c.name === commandName).options.find(o => o.name === "query").autocomplete) throw Error("歌曲输入未启用自动补全：" + commandName);
      const value = commandName === "chartinfo" ? "viiibit exp 紫谱" : "viiibit exp";
      await handleAutocomplete({ ...mockAutocomplete, commandName, options:{getFocused:()=>({name:"query",value})} }, autocompleteConfig);
      if (!autocompleteResponse.some(c => c.value === (commandName === "chartinfo" ? "id870 master" : "id870"))) throw Error("歌曲输入模糊补全失败：" + commandName);
    }
    if (deferredReplies.filter(r=>r.commandName === "aliasadd").some(r=>r.flags)) throw Error("添加别名结果应公开");
    const file = songAliases.filePath;
    songAliases = new SongAliasStore(file,normalizeSongQuery);
    songAliases.load();
    if (searchSongs("测试爱称").length !== 2) throw Error("重载别名搜索失败");
    await handleAliasCommand(interaction("aliasdelete", {query:"id870",alias:"测试爱称"}));
    if (!replies.pop().content.includes("管理员") || !songAliases.matches(870,normalizeSongQuery("测试爱称"),true)) throw Error("删除别名权限失败");
    await handleAliasCommand(interaction("aliasdelete", {query:"测试爱称",alias:"测试爱称"},true));
    if (!replies.pop().content.includes("多首")) throw Error("删除目标歧义处理失败");
    await handleAutocomplete({ ...mockAutocomplete, commandName:"aliasdelete", memberPermissions:{has:()=>true}, options:{getFocused:()=>({name:"alias",value:"测试爱"}),getString:()=>"id870"} },autocompleteConfig);
    if (autocompleteResponse[0]?.value !== "測試愛稱") throw Error("删除别名补全失败");
    await handleAliasCommand(interaction("aliasdelete", {query:"id870",alias:"测试爱称"},true));
    if (!replies.pop().content.includes("已删除") || searchSongs("测试爱称").length !== 1 || searchSongs("测试爱称")[0].id !== 168) throw Error("删除应只影响指定曲目");
    if (songAutocomplete("song","测试爱称").some(c=>c.value === "id870")) throw Error("删除后补全未刷新");
    songAliases.load();
    if (songAliases.matches(870,normalizeSongQuery("测试爱称"),true)) throw Error("删除未持久化");
    await handleAliasCommand(interaction("aliasdelete", {query:"id870",alias:"测试爱称"},true));
    if (!replies.pop().content.includes("没有该别名")) throw Error("不存在的别名删除失败");
    for (let i=0;i<35;i++) songAliases.add(870,"长别名" + i + "字".repeat(70),"test-user");
    replies.length = 0;
    await handleAliasCommand(interaction("aliases",{query:"id870"}));
    if (replies.length < 2 || replies.some(reply => reply.content.length > 2000 || reply.allowedMentions.parse.length)) throw Error("别名分页或提及限制失败");
    if (aliasAutocomplete("").length !== 25) throw Error("别名候选上限失败");
  } finally {
    songAliases = originalAliases;
    for (const entry of fs.readdirSync(aliasTestDir)) fs.unlinkSync(path.join(aliasTestDir, entry));
    fs.rmdirSync(aliasTestDir);
  }

  const ratingBandTests = [
    [1010000, 16.2], [1007500, 15.95], [1000000, 15.45], [990000, 14.95],
    [970000, 14.2], [900000, 10.2], [800000, 8.2], [500000, 0], [499999, 0],
  ];
  for (const [score, expected] of ratingBandTests) {
    if (Math.abs(calculateBaseRating(14.2, score) - expected) > 1e-9) throw new Error("Rating 分段公式自测失败：" + score);
  }
  const exampleRating = calculateSingleRating(14.2, 1000737, "fb", "none");
  if (exampleRating.result !== "15.74" || exampleRating.text !== "基础分 15.49 + 成绩加成 0.2（SSS）+ 铃铛 0.05（FB）+ 连击 0（无）= 15.74") {
    throw new Error("Rating 样例自测失败");
  }
  if (calculateSingleRating(14.2, 1010000, "fb", "ab-plus").result !== "16.90") throw new Error("Rating 加成自测失败");
  try {
    calculateSingleRating(14.25, 1000000, "none", "none");
    throw new Error("Rating 谱面定数校验自测失败");
  } catch (error) {
    if (!String(error.message).includes("谱面定数")) throw error;
  }
  console.log("TAKASE_DISCORD_SELFTEST_OK v" + VERSION);
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  const config = await readConfig();
  config.applicationId = String(config.applicationId).trim();
  config.guildId = String(config.guildId).trim();
  config.channelIds = Array.from(new Set((config.channelIds || []).map((id) => String(id).trim()).filter(Boolean)));
  config.proxyUrl = String(config.proxyUrl || "").trim();
  validateConfig(config);
  fs.mkdirSync(config.workDir, { recursive: true });
  fs.mkdirSync(config.outputDir, { recursive: true });
  songAliases = new SongAliasStore(path.join(path.dirname(config.vaultPath), "song-aliases-" + config.guildId + ".json"), normalizeSongQuery);
  songAliases.load();

  let restAgent = null;
  if (config.proxyUrl) {
    restAgent = new ProxyAgent(config.proxyUrl);
    // build-discord-bot.js injects this agent into @discordjs/ws's WebSocket options.
    // discord.js exposes a REST dispatcher but currently has no public Gateway-agent option.
    globalThis.__TAKASE_DISCORD_WS_AGENT = new HttpsProxyAgent(config.proxyUrl);
    emit("BOT_LOG", "已启用本地 HTTP 代理");
  }
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    rest: restAgent
      ? { agent: restAgent, timeout: DISCORD_REST_TIMEOUT_MS }
      : { timeout: DISCORD_REST_TIMEOUT_MS },
  });
  let rioChat = null;
  try {
    const root = config.rioChatDir || path.join(process.cwd(), "rio-chat");
    const rio = loadRioSettings(root);
    if (rio) {
      rioChat = createRioChat(rio, config, { log: text => emit("BOT_LOG", text) });
      client.on("messageCreate", message => { void rioChat.handle(message).catch(() => emit("BOT_ERROR", "梨绪聊天发送失败，请检查频道权限")); });
      emit("BOT_LOG", "梨绪聊天已启用：指定频道@回复，表情按语境概率发送");
    } else emit("BOT_LOG", "梨绪聊天未启用：请检查EXE同目录rio-chat/config.local.json");
  } catch { emit("BOT_ERROR", "梨绪聊天配置加载失败；请检查本地配置与资源文件，原有斜杠功能继续运行"); }
  const operationQueue = [];
  const queuedUsers = new Set();
  const recentInteractions = new Map();
  const lastGenerateAt = new Map();
  let busy = false;
  let currentOperation = "空闲";
  let shuttingDown = false;
  const startedAt = Date.now();

  function isDuplicate(interactionId) {
    const now = Date.now();
    for (const [id, expiresAt] of recentInteractions) if (expiresAt <= now) recentInteractions.delete(id);
    if (recentInteractions.has(interactionId)) return true;
    recentInteractions.set(interactionId, now + 15 * 60 * 1000);
    return false;
  }

  function queuePosition() { return operationQueue.length + (busy ? 1 : 0); }

  function enqueue(task) {
    if (operationQueue.length >= MAX_QUEUE) return false;
    operationQueue.push(task);
    void pumpQueue();
    return true;
  }

  async function pumpQueue() {
    if (busy || operationQueue.length === 0) return;
    const task = operationQueue.shift();
    busy = true;
    currentOperation = task.label;
    emit("BOT_BUSY", currentOperation);
    try { await task.run(); }
    catch (error) { emit("BOT_ERROR", safeError(error)); }
    finally {
      if (task.userKey) queuedUsers.delete(task.userKey);
      busy = false;
      currentOperation = "空闲";
      emit("BOT_BUSY", "0");
      void pumpQueue();
    }
  }

  async function handleBindModal(interaction) {
    const email = interaction.fields.getTextInputValue("email").trim();
    let password = interaction.fields.getTextInputValue("password");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await interaction.reply({ content: "邮箱格式不正确，请重新执行 `/bind`。", flags: MessageFlags.Ephemeral });
      password = "";
      return;
    }
    // 绑定结果（成功/失败/队列状态）对频道公开；邮箱密码输入表单本身只有提交者可见
    await interaction.deferReply();
    const userKey = "verify:" + interaction.user.id;
    if (queuedUsers.has(userKey)) {
      await interaction.editReply("你已经有一项账号验证正在进行，请稍候。 ");
      password = "";
      return;
    }
    const ahead = queuePosition();
    queuedUsers.add(userKey);
    const accepted = enqueue({
      label: "正在验证 Discord 用户的账号",
      userKey,
      run: async () => {
        try {
          const playerName = await verifyAccount(config, email, password, (line) => emit("BOT_LOG", safeError(line)));
          await saveBinding(config, {
            userId: interaction.user.id,
            email,
            password,
            playerName,
            boundAt: new Date().toISOString(),
          });
          await interaction.editReply("绑定成功：**" + playerName.replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1") + "**\n现在可以执行 `/chart` 生成分表，执行 `/plate` 查询版本牌子完成度，或执行 `/level` 查询指定等级。 ");
          emit("BOT_BINDING_SAVED", playerName);
          emit("BOT_BINDING_COUNT", (await vaultCall(config, "count")).trim());
        } catch (error) {
          await interaction.editReply("绑定失败：" + safeError(error) + "\n请检查账号密码后重新执行 `/bind`。 ");
          throw error;
        } finally { password = ""; }
      },
    });
    if (!accepted) {
      queuedUsers.delete(userKey);
      password = "";
      await interaction.editReply("当前任务队列已满，请稍后重新执行 `/bind`。 ");
      return;
    }
    if (ahead > 0) await interaction.editReply("账号验证已加入队列，前面还有 " + ahead + " 项任务。 ");
    else await interaction.editReply("正在登录并验证账号，请稍候……");
  }

  async function handleChart(interaction) {
    const binding = await getBinding(config, interaction.user.id);
    if (!binding) {
      await interaction.reply({ content: "你还没有绑定大饼账号。请先执行 `/bind`。", flags: MessageFlags.Ephemeral });
      return;
    }
    const userKey = "chart:" + interaction.user.id;
    if (queuedUsers.has(userKey)) {
      await interaction.reply({ content: "你已经有一项分表任务正在生成或排队，请勿重复提交。", flags: MessageFlags.Ephemeral });
      return;
    }
    const remaining = GENERATE_COOLDOWN_MS - (Date.now() - (lastGenerateAt.get(userKey) || 0));
    if (remaining > 0) {
      await interaction.reply({ content: "生成冷却中，请在 " + Math.ceil(remaining / 1000) + " 秒后再试。", flags: MessageFlags.Ephemeral });
      return;
    }
    const ahead = queuePosition();
    await interaction.deferReply();
    queuedUsers.add(userKey);
    lastGenerateAt.set(userKey, Date.now());
    const accepted = enqueue({
      label: "正在生成 " + (binding.playerName || "玩家") + " 的分表",
      userKey,
      run: async () => {
        try {
          emit("BOT_LOG", "开始生成已绑定玩家的分表");
          const image = await generateChart(config, binding, (line) => emit("BOT_LOG", safeError(line)));
          const size = image.buffer.length;
          const limit = Number(interaction.attachmentSizeLimit || 10 * 1024 * 1024);
          if (size > limit) throw new Error("生成图片为 " + (size / 1048576).toFixed(1) + " MiB，超过当前频道 " + (limit / 1048576).toFixed(1) + " MiB 的附件上限");
          emit("BOT_LOG", "正在向 Discord 上传分表图片……");
          await interaction.editReply({
            content: "**" + (binding.playerName || "玩家") + "** 的 B50 + N10 + P50 分表",
            files: [{ attachment: image.buffer, name: image.name }],
          });
          emit("BOT_LOG", "分表图片发送完成");
        } catch (error) {
          try { await interaction.editReply("分表生成失败：" + safeError(error)); } catch {}
          throw error;
        }
      },
    });
    if (!accepted) {
      queuedUsers.delete(userKey);
      await interaction.editReply("当前队列已满，请稍后再试。 ");
      return;
    }
    await interaction.editReply(ahead === 0 ? "已收到，正在生成分表，请稍候……" : "已加入生成队列，前面还有 " + ahead + " 项任务。 ");
  }

  async function handlePlate(interaction) {
    const plateId = interaction.options.getString("plate", true);
    const plate = PLATE_CHOICES.find((item) => item.id === plateId);
    if (!plate) {
      await interaction.reply({ content: "不支持的牌子选项，请重新执行 `/plate`。", flags: MessageFlags.Ephemeral });
      return;
    }
    const binding = await getBinding(config, interaction.user.id);
    if (!binding) {
      await interaction.reply({ content: "你还没有绑定大饼账号。请先执行 `/bind`。", flags: MessageFlags.Ephemeral });
      return;
    }
    const userKey = "plate:" + interaction.user.id;
    if (queuedUsers.has(userKey)) {
      await interaction.reply({ content: "你已经有一项牌子完成度任务正在生成或排队，请勿重复提交。", flags: MessageFlags.Ephemeral });
      return;
    }
    const remaining = GENERATE_COOLDOWN_MS - (Date.now() - (lastGenerateAt.get(userKey) || 0));
    if (remaining > 0) {
      await interaction.reply({ content: "生成冷却中，请在 " + Math.ceil(remaining / 1000) + " 秒后再试。", flags: MessageFlags.Ephemeral });
      return;
    }
    const ahead = queuePosition();
    await interaction.deferReply();
    queuedUsers.add(userKey);
    lastGenerateAt.set(userKey, Date.now());
    const accepted = enqueue({
      label: "正在生成 " + (binding.playerName || "玩家") + " 的 " + plate.nameJa + " 完成度图",
      userKey,
      run: async () => {
        try {
          emit("BOT_LOG", "开始生成牌子完成度图：" + plate.nameJa + " / " + plate.version);
          const image = await generateCompletionChart(config, binding, plate, (line) => emit("BOT_LOG", safeError(line)));
          const size = image.buffer.length;
          const limit = Number(interaction.attachmentSizeLimit || 10 * 1024 * 1024);
          if (size > limit) throw new Error("生成图片为 " + (size / 1048576).toFixed(1) + " MiB，超过当前频道 " + (limit / 1048576).toFixed(1) + " MiB 的附件上限");
          const master = image.meta?.summary?.master;
          const progress = master
            ? `\nMASTER：AB ${master.allBreak}/${master.total} · FB ${master.fullBell}/${master.total}`
            : "";
          emit("BOT_LOG", "正在向 Discord 上传牌子完成度图片……");
          await interaction.editReply({
            content: "**" + escapeDiscordText(binding.playerName || "玩家") + "** 的 **" + plate.nameJa + "（" + plate.nameZhHans + "）** 完成度\n" + escapeDiscordText(plate.version) + progress,
            files: [{ attachment: image.buffer, name: image.name }],
          });
          emit("BOT_LOG", "牌子完成度图片发送完成");
        } catch (error) {
          try { await interaction.editReply("牌子完成度图生成失败：" + safeError(error)); } catch {}
          throw error;
        }
      },
    });
    if (!accepted) {
      queuedUsers.delete(userKey);
      await interaction.editReply("当前队列已满，请稍后再试。 ");
      return;
    }
    const target = "**" + plate.nameJa + "（" + plate.nameZhHans + "）** / " + plate.version;
    await interaction.editReply(ahead === 0
      ? "已选择 " + target + "，正在读取四难度成绩并生成图片，请稍候……"
      : "已选择 " + target + "，任务已加入队列，前面还有 " + ahead + " 项任务。 ");
  }

  async function handleSong(interaction) {
    const query = interaction.options.getString("query", true).trim();
    const matches = searchSongs(query);
    if (matches.length === 0) {
      await interaction.reply({
        content: "没有找到符合要求的曲目。请使用完整 Song ID（例如 `id870`）或换一个更完整的曲名重试。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (matches.length > 1) {
      const chunks = splitDiscordLines(
        "找到以下符合要求的曲目：",
        songMatchLines(matches),
        "请重新执行 `/song`，输入上方唯一的完整 Song ID（例如 `id168`），或继续补全曲名。",
      );
      await interaction.reply({ content: chunks[0], flags: MessageFlags.Ephemeral });
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    const song = matches[0];
    const binding = await getBinding(config, interaction.user.id);
    if (!binding) {
      await interaction.reply({ content: "你还没有绑定大饼账号。请先执行 `/bind`。", flags: MessageFlags.Ephemeral });
      return;
    }
    const userKey = "song:" + interaction.user.id;
    if (queuedUsers.has(userKey)) {
      await interaction.reply({ content: "你已经有一项单曲成绩图正在生成或排队，请勿重复提交。", flags: MessageFlags.Ephemeral });
      return;
    }
    const remaining = GENERATE_COOLDOWN_MS - (Date.now() - (lastGenerateAt.get(userKey) || 0));
    if (remaining > 0) {
      await interaction.reply({ content: "生成冷却中，请在 " + Math.ceil(remaining / 1000) + " 秒后再试。", flags: MessageFlags.Ephemeral });
      return;
    }
    const ahead = queuePosition();
    await interaction.deferReply();
    queuedUsers.add(userKey);
    lastGenerateAt.set(userKey, Date.now());
    const accepted = enqueue({
      label: "正在生成 id" + song.id + " " + song.name + " 的单曲成绩图",
      userKey,
      run: async () => {
        try {
          emit("BOT_LOG", "开始生成单曲成绩图：id" + song.id + " " + song.name);
          const image = await generateSongChart(config, binding, song, (line) => emit("BOT_LOG", safeError(line)));
          const size = image.buffer.length;
          const limit = Number(interaction.attachmentSizeLimit || 10 * 1024 * 1024);
          if (size > limit) throw new Error("生成图片为 " + (size / 1048576).toFixed(1) + " MiB，超过当前频道 " + (limit / 1048576).toFixed(1) + " MiB 的附件上限");
          emit("BOT_LOG", "正在向 Discord 上传单曲成绩图……");
          await interaction.editReply({
            content: "**" + escapeDiscordText(binding.playerName || "玩家") + "** 的单曲全难度成绩：`id" + song.id + "` " + escapeDiscordText(song.name),
            files: [{ attachment: image.buffer, name: image.name }],
          });
          emit("BOT_LOG", "单曲成绩图发送完成");
        } catch (error) {
          try { await interaction.editReply("单曲成绩图生成失败：" + safeError(error)); } catch {}
          throw error;
        }
      },
    });
    if (!accepted) {
      queuedUsers.delete(userKey);
      await interaction.editReply("当前队列已满，请稍后再试。 ");
      return;
    }
    const target = "`id" + song.id + "` " + escapeDiscordText(song.name);
    await interaction.editReply(ahead === 0
      ? "已定位 " + target + "，正在生成单曲全难度成绩图，请稍候……"
      : "已定位 " + target + "，任务已加入队列，前面还有 " + ahead + " 项任务。 ");
  }

  async function handleChartInfo(interaction) {
    const query = interaction.options.getString("query", true).trim();
    const result = searchChartInfo(query);
    if (!result.parsed) {
      await interaction.reply({
        content: "请在曲名或 Song ID 后写明难度，例如 `VIIIbit Explorer master`、`id870 mas` 或 `初音ミクの激唱 lunatic`。支持 BASIC / ADVANCED / EXPERT / MASTER / LUNATIC 及常用缩写。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.matches.length === 0) {
      await interaction.reply({
        content: "没有找到符合要求的 " + result.parsed.difficultyName + " 谱面。请检查曲名、Song ID 与难度是否匹配。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.matches.length > 1) {
      const chunks = splitDiscordLines(
        "找到以下符合要求的谱面：",
        chartInfoMatchLines(result.matches),
        "请重新执行 `/chartinfo`，输入上方唯一的完整 Song ID 和难度，例如 `id870 master`。",
      );
      await interaction.reply({ content: chunks[0], flags: MessageFlags.Ephemeral });
      for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
      return;
    }

    const match = result.matches[0];
    const userKey = "chartinfo:" + interaction.user.id;
    if (queuedUsers.has(userKey)) {
      await interaction.reply({ content: "你已经有一项谱面分析图正在生成或排队，请勿重复提交。", flags: MessageFlags.Ephemeral });
      return;
    }
    const remaining = GENERATE_COOLDOWN_MS - (Date.now() - (lastGenerateAt.get(userKey) || 0));
    if (remaining > 0) {
      await interaction.reply({ content: "生成冷却中，请在 " + Math.ceil(remaining / 1000) + " 秒后再试。", flags: MessageFlags.Ephemeral });
      return;
    }
    const ahead = queuePosition();
    await interaction.deferReply();
    queuedUsers.add(userKey);
    lastGenerateAt.set(userKey, Date.now());
    const accepted = enqueue({
      label: "正在生成 id" + match.song.id + " " + match.song.name + " " + match.difficultyName + " 谱面分析图",
      userKey,
      run: async () => {
        try {
          emit("BOT_LOG", "开始生成谱面分析图：id" + match.song.id + " " + match.song.name + " " + match.difficultyName);
          const image = await generateChartInfo(config, match, (line) => emit("BOT_LOG", safeError(line)));
          const size = image.buffer.length;
          const limit = Number(interaction.attachmentSizeLimit || 10 * 1024 * 1024);
          if (size > limit) throw new Error("生成图片为 " + (size / 1048576).toFixed(1) + " MiB，超过当前频道 " + (limit / 1048576).toFixed(1) + " MiB 的附件上限");
          emit("BOT_LOG", "正在向 Discord 上传谱面分析图……");
          await interaction.editReply({
            content: "谱面分析：`id" + match.song.id + "` **" + escapeDiscordText(match.song.name) + " · " + match.difficultyName + "**",
            files: [{ attachment: image.buffer, name: image.name }],
          });
          emit("BOT_LOG", "谱面分析图发送完成");
        } catch (error) {
          try { await interaction.editReply("谱面分析图生成失败：" + safeError(error)); } catch {}
          throw error;
        }
      },
    });
    if (!accepted) {
      queuedUsers.delete(userKey);
      await interaction.editReply("当前队列已满，请稍后再试。 ");
      return;
    }
    const target = "`id" + match.song.id + "` " + escapeDiscordText(match.song.name) + " · " + match.difficultyName;
    await interaction.editReply(ahead === 0
      ? "已定位 " + target + "，正在计算分数线、判定容错与白金分，请稍候……"
      : "已定位 " + target + "，任务已加入队列，前面还有 " + ahead + " 项任务。 ");
  }

  async function handleConstant(interaction) {
    const query=interaction.options.getString('query',true).trim();
    if(!/^(?:[0-9]|1[0-9]|20)(?:\.[0-9])?$/.test(query) || Number(query)>20) return interaction.reply({content:'请输入 0–20 的整数或一位小数，例如 14、14.2。',flags:MessageFlags.Ephemeral});
    const userKey='constant:'+interaction.user.id;
    if(queuedUsers.has(userKey)) return interaction.reply({content:'你的定数表正在生成或排队。',flags:MessageFlags.Ephemeral});
    const remaining=GENERATE_COOLDOWN_MS-(Date.now()-(lastGenerateAt.get(userKey)||0));
    if(remaining>0) return interaction.reply({content:'请在 '+Math.ceil(remaining/1000)+' 秒后重试。',flags:MessageFlags.Ephemeral});
    await interaction.deferReply();
    queuedUsers.add(userKey);
    const accepted=enqueue({userKey,label:'正在生成定数表 '+query,run:async()=>{
      try {
        const result=await runCore(config,'--constant-job-stdin',{query,streamOutput:true},180000);
        const match=result.stdout.match(/^CONSTANT_OUTPUT_BASE64:([^:]+):(.+)$/m);
        if(!match) throw new Error('核心未返回定数表图片');
        const buffer=Buffer.from(match[2],'base64');
        if(buffer.length>Number(interaction.attachmentSizeLimit||10*1024*1024)) throw new Error('图片超过频道附件限制，请用小数定数缩小查询范围');
        await interaction.editReply({content:'音击定数表 · '+query,files:[{attachment:buffer,name:match[1]}]});
      } catch(error) {await interaction.editReply('定数表生成失败：'+safeError(error));throw error;}
    }});
    if(!accepted){queuedUsers.delete(userKey);await interaction.editReply('当前队列已满，请稍后重试。');}
    else lastGenerateAt.set(userKey,Date.now());
  }

  async function handleLevel(interaction) {
    const level = normalizeLevelCommandQuery(interaction.options.getString("level", true));
    const page = interaction.options.getInteger("page") || 1;
    if (!level) {
      await interaction.reply({ content: "不支持该查询。请输入显示等级（如 `14`、`14+`）、一位小数定数（如 `14.1`）或 `ABFB`。", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = levelCommandTarget(level);
    const binding = await getBinding(config, interaction.user.id);
    if (!binding) {
      await interaction.reply({ content: "你还没有绑定大饼账号。请先执行 `/bind`。", flags: MessageFlags.Ephemeral });
      return;
    }
    const userKey = "level:" + interaction.user.id;
    if (queuedUsers.has(userKey)) {
      await interaction.reply({ content: "你已经有一项等级成绩图正在生成或排队，请勿重复提交。", flags: MessageFlags.Ephemeral });
      return;
    }
    const remaining = GENERATE_COOLDOWN_MS - (Date.now() - (lastGenerateAt.get(userKey) || 0));
    if (remaining > 0) {
      await interaction.reply({ content: "生成冷却中，请在 " + Math.ceil(remaining / 1000) + " 秒后再试。", flags: MessageFlags.Ephemeral });
      return;
    }
    const ahead = queuePosition();
    await interaction.deferReply();
    queuedUsers.add(userKey);
    lastGenerateAt.set(userKey, Date.now());
    const accepted = enqueue({
      label: "正在生成 " + (binding.playerName || "玩家") + " 的 " + target + " 第 " + page + " 页成绩图",
      userKey,
      run: async () => {
        try {
          emit("BOT_LOG", "开始生成 " + target + " 第 " + page + " 页成绩图");
          const image = await generateLevelChart(config, binding, level, page, (line) => emit("BOT_LOG", safeError(line)));
          const size = image.buffer.length;
          const limit = Number(interaction.attachmentSizeLimit || 10 * 1024 * 1024);
          if (size > limit) throw new Error("生成图片为 " + (size / 1048576).toFixed(1) + " MiB，超过当前频道 " + (limit / 1048576).toFixed(1) + " MiB 的附件上限");
          const summary = image.meta || {};
          const progress = Number.isFinite(Number(summary.total))
            ? `\n第 ${summary.page}/${summary.totalPages} 页 · 本页 ${summary.to - summary.from + 1} 张 · ALL ${summary.total} · SSS+ ${summary.sssPlus} · SSS ${summary.sss} · AB ${summary.allBreak} · FB ${summary.fullBell} · ABFB ${summary.allBreakFullBell}`
            : "";
          emit("BOT_LOG", "正在向 Discord 上传等级成绩长图……");
          await interaction.editReply({
            content: "**" + escapeDiscordText(binding.playerName || "玩家") + "** 的 **" + target + "** 全谱面成绩（" + escapeDiscordText(summary.sortDescription || "技术分降序") + "）" + progress,
            files: [{ attachment: image.buffer, name: image.name }],
          });
          emit("BOT_LOG", "等级成绩长图发送完成");
        } catch (error) {
          try { await interaction.editReply("等级成绩图生成失败：" + safeError(error)); } catch {}
          throw error;
        }
      },
    });
    if (!accepted) {
      queuedUsers.delete(userKey);
      await interaction.editReply("当前队列已满，请稍后再试。 ");
      return;
    }
    await interaction.editReply(ahead === 0
      ? `已选择 **${target} · 第 ${page} 页**，正在读取并筛选全谱面成绩，请稍候……`
      : `已选择 **${target} · 第 ${page} 页**，任务已加入队列，前面还有 ${ahead} 项任务。`);
  }

  async function handleCommand(interaction) {
    const denied = assertAllowedInteraction(interaction, config);
    if (denied) {
      await interaction.reply({ content: denied, flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === "help") {
      await interaction.reply({ content: helpText() });
      return;
    }
    if (interaction.commandName === "bind") {
      await interaction.showModal(buildBindModal());
      return;
    }
    if (interaction.commandName === "chart") return handleChart(interaction);
    if (interaction.commandName === "plate") return handlePlate(interaction);
    if (["aliasadd", "aliasdelete", "aliases", "whatis"].includes(interaction.commandName)) return handleAliasCommand(interaction);
    if (interaction.commandName === "song") return handleSong(interaction);
    if (interaction.commandName === "chartinfo") return handleChartInfo(interaction);
    if (interaction.commandName === "constant") return handleConstant(interaction);
    if (interaction.commandName === "level") return handleLevel(interaction);
    if (interaction.commandName === "calculate") {
      const calculation = calculateSingleRating(
        interaction.options.getNumber("constant", true),
        interaction.options.getInteger("score", true),
        interaction.options.getString("bell", true),
        interaction.options.getString("combo", true),
      );
      await interaction.reply({ content: calculation.text });
      return;
    }
    if (interaction.commandName === "status") {
      const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
      await interaction.reply({
        content: "Takase Bot 运行正常\n当前：" + currentOperation + "\n等待队列：" + operationQueue.length + " 项\n已运行：" + minutes + " 分钟",
      });
      return;
    }
    if (interaction.commandName === "unbind") {
      const binding = await getBinding(config, interaction.user.id);
      if (!binding) {
        await interaction.reply({ content: "你目前没有绑定大饼账号。", flags: MessageFlags.Ephemeral });
        return;
      }
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("takase:unbind:" + interaction.user.id).setLabel("确认删除绑定").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("takase:cancel-unbind:" + interaction.user.id).setLabel("取消").setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ content: "确定删除本机加密保存的账号绑定吗？此操作无法恢复。", components: [row] });
    }
  }

  async function handleButton(interaction) {
    const denied = assertAllowedInteraction(interaction, config);
    if (denied) return interaction.reply({ content: denied, flags: MessageFlags.Ephemeral });
    const parts = interaction.customId.split(":");
    if (parts.length !== 3 || parts[0] !== "takase" || parts[2] !== interaction.user.id) {
      return interaction.reply({ content: "这个确认按钮不属于你。", flags: MessageFlags.Ephemeral });
    }
    if (parts[1] === "cancel-unbind") {
      return interaction.update({ content: "已取消解绑。", components: [] });
    }
    if (parts[1] === "unbind") {
      await vaultCall(config, "delete", [interaction.user.id]);
      emit("BOT_BINDING_COUNT", (await vaultCall(config, "count")).trim());
      return interaction.update({ content: "已删除你绑定的大饼账号。下次使用请重新执行 `/bind`。", components: [] });
    }
  }

  client.on("interactionCreate", async (interaction) => {
    if (isDuplicate(interaction.id)) return;
    try {
      if (interaction.isAutocomplete()) await handleAutocomplete(interaction, config);
      else if (interaction.isChatInputCommand()) await handleCommand(interaction);
      else if (interaction.isModalSubmit() && interaction.customId === "takase:bind") {
        const denied = assertAllowedInteraction(interaction, config);
        if (denied) await interaction.reply({ content: denied, flags: MessageFlags.Ephemeral });
        else await handleBindModal(interaction);
      } else if (interaction.isButton()) await handleButton(interaction);
    } catch (error) {
      const message = safeError(error);
      emit("BOT_ERROR", message);
      try {
        if (interaction.isAutocomplete()) {
          if (!interaction.responded) await interaction.respond([]);
        } else if (interaction.deferred || interaction.replied) await interaction.editReply({ content: "操作失败：" + message, components: [] });
        else await interaction.reply({ content: "操作失败：" + message, flags: MessageFlags.Ephemeral });
      } catch {}
    }
  });
  client.on("error", (error) => emit("BOT_ERROR", safeError(error)));
  client.on("warn", (warning) => emit("BOT_LOG", safeError(warning)));
  client.once("clientReady", async () => {
    emit("BOT_READY");
    emit("BOT_LOG", "Discord 核心版本 " + VERSION + "；Gateway 已连接；斜杠指令注册结果见启动日志");
    try { emit("BOT_BINDING_COUNT", (await vaultCall(config, "count")).trim()); }
    catch (error) { emit("BOT_ERROR", safeError(error)); }
  });

  emit("BOT_LOG", "正在注册服务器专用斜杠指令……");
  const rest = new REST(restAgent
    ? { version: "10", agent: restAgent, timeout: DISCORD_REST_TIMEOUT_MS }
    : { version: "10", timeout: DISCORD_REST_TIMEOUT_MS }).setToken(config.botToken);
  const commandsRegistered = await registerCommands(() => rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: COMMANDS }), { log: text => emit("BOT_LOG", text) });
  if (commandsRegistered) emit("BOT_LOG", "已注册 /help、/bind、/chart、/plate、/song、/level、/calculate、/status、/unbind");
  emit("BOT_LOG", "正在连接 Discord Gateway……");
  try { await client.login(config.botToken); }
  catch (error) {
    rioChat?.close();
    throw new Error("连接 Discord Gateway 失败（" + (startupErrorDetail(error) || "无状态码") + "）：" + safeError(error));
  }

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    emit("BOT_LOG", "正在断开 Discord 连接……");
    rioChat?.close();
    client.destroy();
    setTimeout(() => process.exit(0), 250);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  emit("BOT_FATAL", safeError(error));
  process.exitCode = 1;
});

