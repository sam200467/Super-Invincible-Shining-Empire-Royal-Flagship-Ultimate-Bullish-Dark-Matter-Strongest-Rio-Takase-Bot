#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, execSync } = require("node:child_process");

const DIR = __dirname;
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const ENTRY = path.join(DIR, "takase-discord-entry.mjs");
const BUNDLE = path.join(DIR, "takase-discord-bundle.cjs");
const SEA_CONFIG = path.join(DIR, "takase-discord-sea-config.json");
const SEA_BLOB = path.join(DIR, "takase-discord-sea.blob");
const DISCORD_CORE = path.join(DIR, "takase-discord-core.exe");
const ONGEKI_CORE = path.join(DIR, "ongeki-core.exe");
const VAULT_SOURCE = path.join(DIR, "takase-discord-vault.cs");
const VAULT_HELPER = path.join(DIR, "takase-discord-vault.exe");

function step(text) { console.log("== " + text); }

function injectGatewayProxyHook(bundlePath) {
  const needle = "handshakeTimeout: this.strategy.options.handshakeTimeout ?? void 0";
  const replacement = needle + ",\n          agent: globalThis.__TAKASE_DISCORD_WS_AGENT ?? void 0";
  const source = fs.readFileSync(bundlePath, "utf8");
  const occurrences = source.split(needle).length - 1;
  if (occurrences !== 1) throw new Error("Discord Gateway 代理挂钩定位失败，命中数量：" + occurrences);
  fs.writeFileSync(bundlePath, source.replace(needle, replacement), "utf8");
}

if (!process.execPath.toLowerCase().endsWith("node.exe")) throw new Error("请用 node 运行本脚本");
for (const file of [ENTRY, SEA_CONFIG, VAULT_SOURCE]) {
  if (!fs.existsSync(file)) throw new Error("构建文件缺失：" + file);
}

execFileSync(process.execPath, [path.join(DIR, "test-song-alias-store.cjs")], { cwd: DIR, stdio: "inherit" });

step("1/5 重建分表核心");
execFileSync(process.execPath, [path.join(DIR, "build.js")], { cwd: DIR, stdio: "inherit" });
if (!fs.existsSync(ONGEKI_CORE)) throw new Error("分表核心构建失败");

step("2/5 打包 Discord.js 与 Bot 服务");
execFileSync(process.execPath, [
  path.join(DIR, "node_modules", "esbuild", "bin", "esbuild"),
  ENTRY,
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node22",
  "--outfile=" + BUNDLE,
], { cwd: DIR, stdio: "inherit" });
injectGatewayProxyHook(BUNDLE);
console.log("   已为 Discord Gateway WebSocket 注入代理支持");
execFileSync(process.execPath, [BUNDLE, "--selftest"], { cwd: DIR, stdio: "inherit" });

step("3/5 构建 Discord SEA 核心");
execFileSync(process.execPath, ["--experimental-sea-config", SEA_CONFIG], { cwd: DIR, stdio: "inherit" });
fs.copyFileSync(process.execPath, DISCORD_CORE);
try {
  execSync(
    `npx --yes postject "${DISCORD_CORE}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { cwd: DIR, stdio: "inherit" }
  );
} catch (error) {
  fs.rmSync(DISCORD_CORE, { force: true });
  throw error;
}
fs.rmSync(SEA_BLOB, { force: true });

step("4/5 Discord 核心离线自测");
execFileSync(DISCORD_CORE, ["--selftest"], { cwd: DIR, stdio: "inherit" });

step("5/5 编译并自测 Discord DPAPI 多用户凭据库");
if (!fs.existsSync(CSC)) throw new Error("找不到 C# 编译器：" + CSC);
fs.rmSync(VAULT_HELPER, { force: true });
execFileSync(CSC, [
  "/nologo",
  "/target:exe",
  "/out:" + VAULT_HELPER,
  VAULT_SOURCE,
  "/r:System.Web.Extensions.dll",
  "/r:System.Security.dll",
], { cwd: DIR, stdio: "inherit" });
execFileSync(VAULT_HELPER, ["--selftest"], { cwd: DIR, stdio: "inherit" });


console.log("Discord service and encrypted vault built. Run npm start after configuring .env.");
