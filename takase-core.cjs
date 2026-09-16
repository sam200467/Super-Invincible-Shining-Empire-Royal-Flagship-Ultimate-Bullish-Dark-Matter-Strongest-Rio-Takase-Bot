"use strict";
// Takase Bot 平台无关核心。
//
// 这里只放与聊天平台无关的东西：曲库检索、定数计算、结果格式化、子进程调用、
// 凭据库读写、分表渲染任务。Discord 入口（takase-discord-entry.mjs）与 QQ 入口
// （qq/qq-entry.mjs）都从这里取用。
//
// 刻意**不**收进来的东西：
//   - 命令定义、按钮、弹窗、交互回复时序（各平台自己写）
//   - 队列 / 冷却 / 去重（Discord 侧的 handler 直接引用这些闭包变量，共 36 处，
//     等二期 handler 统一到 ctx 接口时再一起搬；QQ 侧目前自带一份）
//   - helpText（Discord 专属文案与 markdown 风格，QQ 需要自己的版本）

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Converter } = require("opencc-js");
const { SongAliasStore } = require("./song-alias-store.cjs");
const INTERNAL_SONGS = require("./ongeki-music-internal.json");

const GENERATE_COOLDOWN_MS = 60 * 1000;
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

// 给宿主 GUI 的日志协议。tag 名与分隔符是**冻结**的：takase-discord-gui.cs 用硬编码
// Substring 偏移解析（BOT_READY / BOT_BINDING_COUNT: / BOT_BINDING_SAVED: / BOT_BUSY: /
// BOT_FATAL: / BOT_ERROR: / BOT_LOG:），一个字符都不能改。未知 tag 会被 GUI 兜底打进
// 日志区，所以新增 tag 是安全的。
// BOT_NAPCAT:1|0 是 QQ 版专有的：NapCat 连接状态，只有 qq/takase-qq-gui.cs 认识它，
// Discord 侧不会发。加新 tag 时记得同步 GUI 的 HandleLine，否则会原样打进日志区。
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

function getAliasStore() {
  return songAliases;
}

function setAliasStore(store) {
  songAliases = store;
  return songAliases;
}

// 别名文件按 scope 命名。Discord 传 guildId（文件名与旧版逐字节一致），QQ 传 "qq"
// （别名是社区词汇，不该按群各存一份）。
function configureAliases(config) {
  const scope = String(config.aliasScope || config.guildId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(scope)) throw new Error("别名作用域不合法：" + (scope || "（空）"));
  songAliases = new SongAliasStore(
    path.join(path.dirname(config.vaultPath), "song-aliases-" + scope + ".json"),
    normalizeSongQuery,
  );
  songAliases.load();
  return songAliases;
}

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

function escapeDiscordText(value) {
  return String(value || "").replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1");
}

// Discord 会对 * ` # - 之类的字符做反斜杠转义；QQ 不渲染任何 markdown，照搬会让用户
// 看到一堆裸反斜杠。所以曲名格式化走这个可配置的转义器，默认保持 Discord 行为不变。
let escapeText = escapeDiscordText;

function configureFormatting(options = {}) {
  escapeText = typeof options.escapeText === "function" ? options.escapeText : escapeDiscordText;
}

function chartInfoMatchLines(matches) {
  return matches.map(({ song, difficultyName }) =>
    `id${song.id}　${escapeText(song.name)}　[${difficultyName}]　— ${escapeText(song.artistName)}`
  );
}

function songMatchLines(matches) {
  return matches.map((song) => {
    const lunaticMark = song.isLunatic === true ? " [LUNATIC]" : "";
    return `id${song.id}　${escapeText(song.name)}${lunaticMark}　— ${escapeText(song.artistName)}`;
  });
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

// 原名 splitDiscordLines；limit 默认值仍是 Discord 的 1900，QQ 侧调用时显式传自己的上限。
function splitLines(header, lines, footer, limit = 1900) {
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

// stdin 上的单个 JSON 配置块，各平台入口通用。
async function readConfig() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("未收到启动配置");
  return JSON.parse(text);
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

// 分表核心把图片以 base64 经 stdout 流式吐回来，那些行绝不能进日志 ——
// 否则整张图的 base64 会刷屏（safeError 只能把它打码成 [敏感内容已隐藏]，照样是几 MB）。
const PAYLOAD_LINE = /^(?:OUTPUT|SONG_OUTPUT|CHART_INFO_OUTPUT|COMPLETION_OUTPUT|LEVEL_OUTPUT|CONSTANT_OUTPUT)_(?:BASE64|FILE):|^(?:CHART|SONG|CHART_INFO|COMPLETION|LEVEL)_SUMMARY:/;

function isPayloadLine(line) {
  return PAYLOAD_LINE.test(line) || line.length > 500;
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
    // 行缓冲：数据是分块到达的，一行可能被切断。不缓冲的话，base64 的半截
    // 会因为既不以 OUTPUT_BASE64: 开头、又不够长而漏进日志。
    let stdoutRest = "";
    let stderrRest = "";
    const receive = (isError, data) => {
      const text = String(data);
      if (isError) stderr += text;
      else stdout += text;
      // 注意：stdout/stderr 仍然完整累积（图片数据在里面），只是不往日志里送
      const pending = (isError ? stderrRest : stdoutRest) + text;
      const lines = pending.split(/\r?\n/);
      const rest = lines.pop();
      if (isError) stderrRest = rest; else stdoutRest = rest;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !isPayloadLine(trimmed)) onLine(trimmed);
      }
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

// 核心的 XXX_SUMMARY 行是给程序看的结构化数据。解析失败只影响「摘要」，
// 不能用它把一次成功的生成判成失败 —— 所以一律吞掉异常返回 null。
function parseSummary(stdout, pattern) {
  try {
    const text = String(stdout || "").match(pattern)?.[1];
    return text ? JSON.parse(text) : null;
  } catch { return null; }
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
  const meta = parseSummary(result.stdout, /^CHART_SUMMARY:(.+)$/m);
  const streamed = result.stdout.match(/^OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64"), meta };
  // 兼容回退：旧核心仍可能写文件，读取后立即删除
  const outputPath = result.stdout.match(/^OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer, meta };
}

async function generateSongChart(config, binding, song, onLine) {
  const result = await runCore(config, "--song-job-stdin", {
    email: binding.email,
    password: binding.password,
    playerName: binding.playerName || "",
    songId: Number(song.id),
    streamOutput: true,
  }, 360000, onLine);
  const meta = parseSummary(result.stdout, /^SONG_SUMMARY:(.+)$/m);
  const streamed = result.stdout.match(/^SONG_OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64"), meta };
  const outputPath = result.stdout.match(/^SONG_OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的单曲图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer, meta };
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

// 读取 PNG 的 IHDR，返回 {width, height}。QQ 对图片边长有上限，发送前需要预判。
// 零依赖，只读前 24 字节。
function pngSize(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (data.length < 24) throw new Error("图片数据不完整");
  if (data.readUInt32BE(0) !== 0x89504e47 || data.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error("不是有效的 PNG 数据");
  if (data.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG 缺少 IHDR 数据块");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

// 图片本身读不到（聊天模型没有视觉），但**生成它的数据读得到** —— 把图上已经画出来的
// 关键数字压成一句话，记进群上下文，之后「他这首歌打多少分」「榜首是哪首」就答得上。
// 摘要失败一律退回原说明：这只是锦上添花，不能影响正常出图。
function describeImage(kind, image, caption) {
  const head = String(caption || "");
  const meta = image?.meta;
  if (!meta || typeof meta !== "object") return head;
  const difficultyName = (id) => CHART_INFO_DIFFICULTY_NAMES[id] || ("难度" + id);
  const marks = (item, sep = " ") => [item.allBreak ? "AB" : "", item.fullCombo ? "FC" : "", item.fullBell ? "FB" : ""].filter(Boolean).join(sep);
  const number = (value, digits) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : null);
  try {
    if (kind === "chart") {
      const counts = meta.counts || {};
      const top = Array.isArray(meta.top) ? meta.top[0] : null;
      const bits = [];
      if (meta.rating != null) bits.push("RATING " + Number(meta.rating).toFixed(3));
      if (counts.best != null) bits.push("三榜 " + counts.best + "/" + counts.new + "/" + counts.platinum + " 曲");
      if (top?.title) bits.push("榜首 " + top.title + (top.techScore != null ? " " + top.techScore + " 分" : "") + (marks(top) ? " " + marks(top) : ""));
      return bits.length ? head + "｜" + bits.join(" · ") : head;
    }
    if (kind === "song") {
      const scores = Array.isArray(meta.scores) ? meta.scores : [];
      // 只有核心明确说「没找到记录」才这么讲；摘要缺字段时退回原说明，别替它下结论
      if (!scores.length) return meta.found === false ? head + "｜没有该曲目的游玩记录" : head;
      return head + "｜" + scores.slice(0, 4).map((item) =>
        difficultyName(item.difficultyId) + " " + (item.techScore ?? "未游玩") + (marks(item) ? " " + marks(item, " · ") : "")).join("；");
    }
    if (kind === "level") {
      const bits = [
        meta.total != null ? "ALL " + meta.total : null,
        meta.sssPlus != null ? "SSS+ " + meta.sssPlus : null,
        meta.sss != null ? "SSS " + meta.sss : null,
        meta.allBreak != null ? "AB " + meta.allBreak : null,
        meta.fullBell != null ? "FB " + meta.fullBell : null,
        meta.allBreakFullBell != null ? "ABFB " + meta.allBreakFullBell : null,
      ].filter(Boolean);
      return bits.length ? head + "｜" + bits.join(" · ") : head;
    }
    if (kind === "plate") {
      const master = meta.summary?.master;
      if (!master) return head;
      return head + "｜MASTER AB " + master.allBreak + "/" + master.total + " · FB " + master.fullBell + "/" + master.total;
    }
    if (kind === "chartinfo") {
      const bits = [
        meta.difficulty || null,
        number(meta.constant, 1) ? "定数 " + number(meta.constant, 1) : null,
        Number.isFinite(Number(meta.noteCount)) ? "音符 " + meta.noteCount : null,
      ].filter(Boolean);
      return bits.length ? head + "｜" + bits.join(" · ") : head;
    }
  } catch { /* 摘要只是锦上添花 */ }
  return head;
}

// ── 能力（自然语言工具调用）──────────────────────────────────────────
// 聊天入口把 CAPABILITY_SPECS 写进模型提示词；模型挑一个名字加一句参数，
// resolveCapability 把它翻成「要发什么」。这里只解析和取数，**不发送任何东西** ——
// 两个平台的发送模型不同（Discord 走 message.reply，QQ 走 OneBot 消息段），
// 由各自入口 dispatch。井号/斜杠命令与自然语言聊天共用这一层，两条路不会漂移。
//
// 返回四种形态：
//   {kind:"notice", text}                    私聊优先的短提示（未绑定、冷却、队列满）
//   {kind:"text",   text}                    一条文本
//   {kind:"lines",  header, lines, footer}   需要分块的列表
//   {kind:"image",  key, label, failText, caption, run}   run() 出图
const CAPABILITY_SPECS = Object.freeze([
  { name: "help", label: "功能清单", argHint: "不需要参数", needsBinding: false },
  { name: "chart", label: "B50 + N10 + P50 分表", argHint: "不需要参数", needsBinding: true },
  { name: "plate", label: "版本牌子完成度图", argHint: "版本牌子名，如 闪击、赤击、想击", needsBinding: true },
  { name: "song", label: "单曲全难度成绩图", argHint: "曲名或 Song ID", needsBinding: true },
  { name: "chartinfo", label: "单张谱面分数线分析图", argHint: "曲名或 Song ID 加难度，如 id870 master", needsBinding: false },
  { name: "constant", label: "定数表", argHint: "0–20 的整数或一位小数，如 14 或 14.2", needsBinding: false },
  { name: "level", label: "等级成绩长图", argHint: "14、14+、14.1 或 ABFB，可再加页码", needsBinding: true },
  { name: "calculate", label: "单曲 Rating 计算", argHint: "定数、技术分、铃铛 none/fb、连击 none/fc/ab/ab-plus", needsBinding: false },
]);

// 少数几处必须写命令的地方，各平台叫法不同（Discord 是 /bind，QQ 是 #绑定）。
// 默认值按 Discord 写，QQ 入口在 start() 里覆盖。
// 值可以是字符串，也可以是**多句说法**的数组 —— 同一个提示反复出现时换着说，
// 免得像系统通知。数组里每句都要自带完整意思（含命令名），测试按共同关键字断言。
let capabilityHints = Object.freeze({
  bindNotice: [
    "唔，你还没把大饼账号交给我呢。执行 `/bind` 把账号给我，我才能帮你翻成绩。",
    "查成绩得先有账号呀 —— 执行 `/bind` 交给我，马上就能用了。",
    "你的绑定还没做哦。执行 `/bind`，之后想查什么我都给你翻出来。",
  ],
  // 查别人：对方没绑定 / 对方没开放。都要说清楚原因，别让人以为是机器人坏了
  targetNotBound: [
    "TA 还没绑定过大饼账号，我手里没有 TA 的数据，查不了。",
    "TA 没绑过账号呀，我上哪儿给 TA 翻成绩去。",
  ],
  // 默认按 Discord 写；QQ 入口在 start() 里换成 #允许查询
  targetNotAllowed: [
    "TA 没开放成绩查询，我不能替 TA 查。TA 想开的话，执行 `/allowquery` 就行。",
    "这个不行——TA 没把成绩开放给别人查。TA 自己执行 `/allowquery` 就能开了。",
  ],
  helpText: "发送 `/help` 查看 Takase Bot 的功能清单。",
  chartInfoUsage: "请在曲名或 Song ID 后写明难度，例如 `id870 master`、`初音ミクの激唱 lunatic`。支持 BASIC / ADVANCED / EXPERT / MASTER / LUNATIC 及常用缩写。",
  levelUsage: "请输入显示等级（如 14、14+）、一位小数定数（如 14.1）或 ABFB。",
  constantUsage: "请输入 0–20 的整数或一位小数，例如 14、14.2。",
  calculateUsage: "请给出定数、技术分、铃铛（none 或 fb）和连击（none / fc / ab / ab-plus），例如 14.2 1000737 fb none。",
});

function isValidHint(value) {
  if (Array.isArray(value)) return value.length > 0 && value.every((item) => String(item || "").trim());
  return Boolean(String(value || "").trim());
}

// 数组就随机挑一句。刻意用 Math.random：这些文案互不影响逻辑，
// 不需要为了测试可控而给 core 再开一个随机源。
function pickHint(value) {
  if (!Array.isArray(value)) return String(value || "");
  return String(value[Math.floor(Math.random() * value.length)]);
}

// 宿主自己实现的路径（比如 Discord 的斜杠命令）要复用同一批提示文案时用这个
function capabilityHint(name) {
  return pickHint(capabilityHints[name]);
}

function configureCapabilities(options = {}) {
  const merged = { ...capabilityHints, ...options };
  for (const key of Object.keys(merged)) {
    if (!isValidHint(merged[key])) throw new Error("能力提示文案不能为空：" + key);
  }
  capabilityHints = Object.freeze(merged);
}

// 宿主的集成测试会替换 core.getBinding / core.generateChart 这类函数（真实账号
// 和真实分表核心跑不了）。这里必须经由 module.exports 取调用目标 —— 直接写函数名
// 拿到的是模块内部引用，替换不掉：命令路径用的是替换后的，聊天路径用的还是原版。
function coreCall(name, ...args) {
  return module.exports[name](...args);
}

// targetUserId 非空且不是自己时，表示「替群里另一个人查」——取的是对方的数据，
// 所以对方必须绑定过、并且自己开过 #允许查询。
async function resolveCapability(config, userId, name, query, onLine = () => {}, targetUserId = null) {
  const spec = CAPABILITY_SPECS.find((item) => item.name === name);
  if (!spec) return { kind: "notice", text: "这个功能暂时没有开放。" };
  const q = String(query || "").normalize("NFKC").trim();
  const text = (value) => ({ kind: "text", text: value });
  if (spec.name === "help") return text(pickHint(capabilityHints.helpText));

  let binding = null;
  if (spec.needsBinding) {
    const targetId = targetUserId ? String(targetUserId) : "";
    if (targetId && targetId !== String(userId)) {
      // 查别人：用**对方**的绑定去取数，所以必须先确认对方自己开过口。
      // 这不是技术限制是隐私红线 —— 别人存的账号密码不是拿来给群里公开放的。
      const target = await coreCall("getBinding", config, targetId);
      if (!target) return { kind: "notice", text: pickHint(capabilityHints.targetNotBound) };
      if (target.allowOthers !== true) return { kind: "notice", text: pickHint(capabilityHints.targetNotAllowed) };
      binding = target;
    } else {
      binding = await coreCall("getBinding", config, userId);
      if (!binding) return { kind: "notice", text: pickHint(capabilityHints.bindNotice) };
    }
  }
  const player = binding?.playerName || "玩家";

  if (spec.name === "chart") {
    return {
      kind: "image", key: "chart", label: "正在生成 " + player + " 的分表", failText: "分表生成失败：",
      caption: escapeText(player) + " 的 B50 + N10 + P50 分表",
      run: () => coreCall("generateChart", config, binding, onLine),
    };
  }

  if (spec.name === "plate") {
    const needle = normalizeSongQuery(q);
    const plate = PLATE_CHOICES.find((item) => [item.id, item.nameJa, item.nameZhHans, item.version]
      .some((value) => normalizeSongQuery(value) === needle));
    if (!plate) {
      return text("请选择版本牌子：\n" + PLATE_CHOICES
        .map((item) => item.id + "：" + item.nameJa + "（" + item.nameZhHans + "）/ " + item.version).join("\n"));
    }
    return {
      kind: "image", key: "plate", label: "正在生成牌子完成度图", failText: "牌子完成度图生成失败：",
      caption: escapeText(player) + " 的 " + plate.nameJa + "（" + plate.nameZhHans + "）完成度 · " + plate.version,
      run: () => coreCall("generateCompletionChart", config, binding, plate, onLine),
    };
  }

  if (spec.name === "song") {
    const matches = searchSongs(q);
    if (matches.length !== 1) {
      return { kind: "lines", header: matches.length ? "找到多首曲目，请用完整 Song ID 明确选择：" : "没有找到曲目。", lines: songMatchLines(matches), footer: "" };
    }
    const song = matches[0];
    return {
      kind: "image", key: "song", label: "正在生成单曲成绩图", failText: "单曲成绩图生成失败：",
      caption: escapeText(player) + " 的单曲全难度成绩：id" + song.id + " " + escapeText(song.name),
      run: () => coreCall("generateSongChart", config, binding, song, onLine),
    };
  }

  if (spec.name === "chartinfo") {
    const result = searchChartInfo(q);
    if (!result.parsed) return text(capabilityHints.chartInfoUsage);
    if (result.matches.length !== 1) {
      return { kind: "lines", header: result.matches.length ? "找到多张谱面，请用完整 Song ID 明确选择：" : "没有找到符合要求的谱面。", lines: chartInfoMatchLines(result.matches), footer: "" };
    }
    const match = result.matches[0];
    return {
      kind: "image", key: "chartinfo", label: "正在生成谱面分析图", failText: "谱面分析图生成失败：",
      caption: "谱面分析：id" + match.song.id + " " + escapeText(match.song.name) + " · " + match.difficultyName,
      run: () => coreCall("generateChartInfo", config, match, onLine),
    };
  }

  if (spec.name === "constant") {
    const token = q.replace(/[^\d.]/g, " ").trim().split(/\s+/).filter(Boolean)[0] || "";
    if (!/^(?:[0-9]|1[0-9]|20)(?:\.[0-9])?$/.test(token) || Number(token) > 20) return text(capabilityHints.constantUsage);
    return {
      kind: "image", key: "constant", label: "正在生成定数表", failText: "定数表生成失败：",
      caption: "音击定数表 · " + token,
      run: async () => {
        const result = await coreCall("runCore", config, "--constant-job-stdin", { query: token, streamOutput: true }, 180000, onLine);
        const match = result.stdout.match(/^CONSTANT_OUTPUT_BASE64:([^:]+):(.+)$/m);
        if (!match) throw new Error("核心未返回定数表图片");
        return { buffer: Buffer.from(match[2], "base64"), name: match[1] };
      },
    };
  }

  if (spec.name === "level") {
    const parts = q.split(/\s+/).filter(Boolean);
    const level = normalizeLevelCommandQuery(parts[0]);
    let page = 1;
    if (parts.length > 1) {
      // 「第2页」这种写法也认，取数字就行
      const digits = parts.slice(1).join("").replace(/\D/g, "");
      if (!digits) return text(capabilityHints.levelUsage);
      page = Number(digits);
    }
    if (!level || !Number.isInteger(page) || page < 1 || page > 99) return text(capabilityHints.levelUsage);
    const target = levelCommandTarget(level);
    return {
      kind: "image", key: "level", label: "正在生成等级成绩图", failText: "等级成绩图生成失败：",
      caption: escapeText(player) + " 的 " + target + " 全谱面成绩 · 第 " + page + " 页",
      run: () => coreCall("generateLevelChart", config, binding, level, page, onLine),
    };
  }

  if (spec.name === "calculate") {
    // 位置参数与自然语序都吃：「14.2 1000737 fb none」和「定数 14.2，技术分 1000737，铃铛 fb，连击 ab+」等价
    const numbers = [...q.replace(/(\d)[,，](\d)/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]);
    if (numbers.length < 2) return text(capabilityHints.calculateUsage);
    const bell = /\bfb\b|fb/i.test(q) ? "fb" : "none";
    const combo = /ab\s*\+|abplus/i.test(q) ? "ab-plus" : /\bab\b/i.test(q) ? "ab" : /\bfc\b/i.test(q) ? "fc" : "none";
    try {
      return text(calculateSingleRating(Number(numbers[0]), Number(numbers[1]), bell, combo).text);
    } catch (error) {
      return text(safeError(error));
    }
  }

  return { kind: "notice", text: "这个功能暂时没有开放。" };
}

module.exports = {
  // 常量
  GENERATE_COOLDOWN_MS,
  MAX_QUEUE,
  PLATE_CHOICES,
  LEVEL_CHOICES,
  INTERNAL_SONGS,
  CHART_INFO_DIFFICULTY_NAMES,
  // 日志与错误
  emit,
  safeError,
  // 曲库检索
  normalizeSongQuery,
  normalizeLevelCommandQuery,
  levelCommandTarget,
  searchSongs,
  parseChartInfoQuery,
  songHasChartDifficulty,
  searchChartInfo,
  songAutocomplete,
  aliasAutocomplete,
  // 别名库
  getAliasStore,
  setAliasStore,
  configureAliases,
  // 格式化
  escapeDiscordText,
  configureFormatting,
  chartInfoMatchLines,
  songMatchLines,
  splitLines,
  describeImage,
  // 能力（自然语言工具调用）
  CAPABILITY_SPECS,
  configureCapabilities,
  capabilityHint,
  resolveCapability,
  // 定数
  calculateBaseRating,
  calculateSingleRating,
  // 配置
  readConfig,
  // 子进程与凭据库
  runProcess,
  vaultCall,
  getBinding,
  saveBinding,
  runCore,
  verifyAccount,
  generateChart,
  generateSongChart,
  generateChartInfo,
  generateCompletionChart,
  generateLevelChart,
  // 图片元数据
  pngSize,
};
