#!/usr/bin/env node
"use strict";
// 打包 QQ 版 Bot。
//
// 与 Discord 版构建的差别：
//   - **没有 injectGatewayProxyHook** —— 那段对 @discordjs/ws 内部 token 的字符串
//     patch 是整条流水线最脆弱的一环，QQ 路径完全不需要（discord.js 根本不进这个包）
//   - 必须 --external:bufferutil / --external:utf-8-validate —— ws 的这两个可选
//     peerDependency 没装，不排除的话 esbuild 解析失败
//   - 不做 SEA 单文件 exe：QQ 版要读同目录的配置和数据，跑在文件夹里更自然，
//     也省掉 npx postject 那个联网步骤
//
// 产物：qq/dist/takase-qq-bundle.cjs + 两个无窗口启动器

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, execSync } = require("node:child_process");

const QQ = __dirname;
const ROOT = path.resolve(QQ, "..");
const ENTRY = path.join(QQ, "qq-entry.cjs");
const DIST = path.join(QQ, "dist");
const BUNDLE = path.join(DIST, "takase-qq-bundle.cjs");
const ESBUILD = path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild");
const CONFIG = path.join(QQ, "qq-config.json");
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const SEA_CONFIG = path.join(QQ, "takase-qq-sea-config.json");
const SEA_BLOB = path.join(QQ, "takase-qq-sea.blob");
const QQ_CORE = path.join(QQ, "takase-qq-core.exe");
const GUI_SOURCE = path.join(QQ, "takase-qq-gui.cs");
const GUI_EXE = path.join(QQ, "Takase Bot QQ.exe");
const ONGEKI_CORE = path.join(ROOT, "ongeki-core.exe");
const VAULT_HELPER = path.join(ROOT, "takase-discord-vault.exe");
const ICON = path.join(ROOT, "ongeki-icon.ico");

const step = (text) => console.log("== " + text);

if (!fs.existsSync(ENTRY)) throw new Error("缺少入口文件：" + ENTRY);
if (!fs.existsSync(ESBUILD)) throw new Error("缺少 esbuild，请先在项目根目录执行 npm ci");

// ── 1/5 测试闸门：任何一步失败都中止 ────────────────────────────────
step("1/8 跑测试");
execFileSync(process.execPath, [path.join(ROOT, "test-takase-core.cjs")], { cwd: ROOT, stdio: "inherit" });
execFileSync(process.execPath, ["--test", path.join(QQ, "test-qq-onebot.cjs")], { cwd: ROOT, stdio: "inherit" });
execFileSync(process.execPath, ["--test", path.join(QQ, "test-qq-entry.cjs")], { cwd: ROOT, stdio: "inherit" });
// QQ 包里含 rio-chat/chat.cjs，工具调用契约坏了这边一样会挂
execFileSync(process.execPath, ["--test", path.join(ROOT, "rio-chat/chat.test.cjs")], { cwd: ROOT, stdio: "inherit" });
execFileSync(process.execPath, ["--test", path.join(ROOT, "rio-chat/knowledge.test.cjs")], { cwd: ROOT, stdio: "inherit" });
execFileSync(process.execPath, ["--test", path.join(ROOT, "rio-chat/search.test.cjs")], { cwd: ROOT, stdio: "inherit" });
execFileSync(process.execPath, ["--test", path.join(ROOT, "rio-chat/research-policy.test.cjs")], { cwd: ROOT, stdio: "inherit" });
// 共享核心被改坏的话 QQ 版一样会挂，所以 Discord 侧的自测也要过
execFileSync(process.execPath, [path.join(ROOT, "takase-discord-entry.mjs"), "--selftest"], { cwd: ROOT, stdio: "inherit" });

// ── 2/5 打包 ──────────────────────────────────────────────────────
step("2/8 打包 QQ 入口");
fs.mkdirSync(DIST, { recursive: true });
execFileSync(process.execPath, [
  ESBUILD, ENTRY,
  "--bundle", "--platform=node", "--format=cjs", "--target=node22",
  "--external:bufferutil", "--external:utf-8-validate",
  "--outfile=" + BUNDLE,
], { cwd: ROOT, stdio: "inherit" });

// ── 3/5 产物自测 ──────────────────────────────────────────────────
step("3/8 产物自测");
execFileSync(process.execPath, [BUNDLE, "--selftest"], { cwd: QQ, stdio: "inherit" });

// ── 4/8 SEA 无 Node 运行时核心 ─────────────────────────────────────
step("4/8 构建 QQ SEA 核心");
execFileSync(process.execPath, ["--experimental-sea-config", SEA_CONFIG], { cwd: QQ, stdio: "inherit" });
fs.copyFileSync(process.execPath, QQ_CORE);
try {
  execSync(`npx --yes postject "${QQ_CORE}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, { cwd: QQ, stdio: "inherit" });
} catch (error) { fs.rmSync(QQ_CORE, { force: true }); throw error; }
fs.rmSync(SEA_BLOB, { force: true });
execFileSync(QQ_CORE, ["--selftest"], { cwd: QQ, stdio: "inherit" });

// ── 5/8 图形化控制台 ───────────────────────────────────────────────
step("5/8 编译 QQ 图形化控制台");
for (const file of [CSC, GUI_SOURCE, ONGEKI_CORE, VAULT_HELPER, ICON]) if (!fs.existsSync(file)) throw new Error("构建文件缺失：" + file);
fs.rmSync(GUI_EXE, { force: true });
execFileSync(CSC, [
  "/nologo", "/target:winexe", "/out:" + GUI_EXE, "/win32icon:" + ICON, GUI_SOURCE,
  "/resource:" + QQ_CORE + ",takase-qq-core.exe",
  "/resource:" + ONGEKI_CORE + ",ongeki-core.exe",
  "/resource:" + VAULT_HELPER + ",takase-discord-vault.exe",
  "/r:" + path.join(path.dirname(CSC), "Microsoft.VisualBasic.dll"),
  "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll", "/r:System.Web.Extensions.dll", "/r:System.Security.dll",
], { cwd: ROOT, stdio: "inherit" });
execFileSync(GUI_EXE, ["--selftest"], { cwd: QQ, stdio: "inherit" });

// ── 4/5 启动器 ────────────────────────────────────────────────────
step("6/8 写兼容用无窗口启动器");

// VBScript 的字符串转义是「双写引号」，不是 JSON 的 \"
const vbsQuote = (value) => '"' + String(value).replace(/"/g, '""') + '"';

function writeLauncher(fileName, command, comment, visible = false) {
  const lines = [
    "' " + comment,
    'Set shell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    "shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)",
    // 窗口模式 0=隐藏 1=显示；可见时用 True 等它跑完，好让用户看到结果
    "shell.Run " + vbsQuote(command) + (visible ? ", 1, True" : ", 0, False"),
    "",
  ];
  // VBScript 只认 ANSI 或 **UTF-16LE**。UTF-8 带 BOM 会被报「无效字符」，
  // 不带 BOM 又会让中文注释乱码 —— 所以必须写成 UTF-16LE + BOM。
  const body = "﻿" + lines.join("\r\n");
  fs.writeFileSync(path.join(QQ, fileName), Buffer.from(body, "utf16le"));
  console.log("   " + fileName);
}

writeLauncher("启动QQBot.vbs",
  'cmd /c node "dist\\takase-qq-bundle.cjs" "qq-config.json" > "bot.log" 2>&1',
  "无窗口启动 QQ Bot。日志写到同目录 bot.log。停止：双击 停止QQBot.vbs");

// 停止脚本故意显示窗口：用户点了「停止」就该看到结果，不该去翻日志。
// 真正的筛选逻辑在 stop-qq-bot.cjs 里（只杀命令行带 takase-qq-bundle 的 node）。
writeLauncher("停止QQBot.vbs",
  'cmd /c node "stop-qq-bot.cjs" & timeout /t 3',
  "停止 QQ Bot。只结束命令行里带 takase-qq-bundle 的 node 进程，不动别的 node",
  true);

// ── 5/5 NapCat 启动器（路径取自配置，不硬编码）──────────────────────
step("7/8 写 NapCat 启动器");
const config = JSON.parse(fs.readFileSync(CONFIG, "utf8").replace(/^﻿/, ""));
const napCatLauncher = config.napCatLauncher;
if (!napCatLauncher || !fs.existsSync(napCatLauncher)) {
  console.log("   跳过：qq-config.json 里的 napCatLauncher 没配或路径不存在");
  console.log("   （配好后重跑本脚本即可生成）");
} else {
  // cmd.exe 对正斜杠路径处理不良（会当成参数开关），这里必须转成反斜杠
  const napCatNative = napCatLauncher.replace(/\//g, "\\");
  writeLauncher("启动NapCat.vbs",
    "cmd /c " + vbsQuote(napCatNative),
    "无窗口启动 NapCat。若要重新扫码登录，请直接双击 " + napCatNative + " 看二维码");
}

console.log("");
step("8/8 完成");
console.log("打包完成 -> " + BUNDLE);
console.log("  体积 " + (fs.statSync(BUNDLE).size / 1048576).toFixed(1) + " MiB");
console.log("");
console.log("图形界面 -> " + GUI_EXE);
console.log("日常使用：双击 Takase Bot QQ.exe，在界面里启动 NapCat 和 Bot");
