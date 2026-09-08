#!/usr/bin/env node
/** Build the ONGEKI rendering core for the Discord service. */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync, execFileSync } = require("node:child_process");

const DIR = __dirname;
const FRIEND_SCRIPT = path.join(DIR, "reiwa-ongeki-from-otogame-rating-json.js");
const TEMPLATE = path.join(DIR, "app-template.js");
const GENERATED = path.join(DIR, "ongeki-exe.js");
// undici（代理支持）需要由 esbuild 打包进单文件；SEA 环境不提供 node:undici 内置模块
const BUNDLED = path.join(DIR, "ongeki-bundle.cjs");
const SEA_CONFIG = path.join(DIR, "sea-config.json");
const BLOB = path.join(DIR, "sea-prep.blob");
const CORE = path.join(DIR, "ongeki-core.exe");
const INTERNAL_SONGS = path.join(DIR, "ongeki-music-internal.json");
const SUPPLEMENTAL_SONGS = path.join(DIR, "ongeki-song-catalog.json");
const SDDT_EXTRAS = path.join(DIR, "ongeki-sddt-extras.json");
const THEME_ROOT = path.join(DIR, "themes");

function step(msg) {
  console.log("== " + msg);
}

step("1/5 注入朋友脚本，生成 ongenki-exe.js");
const friend = fs.readFileSync(FRIEND_SCRIPT, "utf8");
if (!friend.includes("window.openOtogameRatingJsonToReiwaOngeki")) {
  throw new Error("朋友脚本内容异常，缺少 window.openOtogameRatingJsonToReiwaOngeki");
}
const template = fs.readFileSync(TEMPLATE, "utf8");
const marker = '"__FRIEND_SCRIPT_JSON__"';
if (!template.includes(marker)) throw new Error("模板中未找到注入标记 " + marker);
const themeMarker = '"__THEME_BUNDLE_JSON__"';
const themeHashMarker = '"__THEME_BUNDLE_HASH__"';
const catalogMarker = '"__SONG_CATALOG_JSON__"';
const internalCatalogMarker = '"__INTERNAL_SONG_CATALOG_JSON__"';
const sddtExtrasMarker = '"__SDDT_EXTRAS_JSON__"';
for (const value of [themeMarker, themeHashMarker, catalogMarker, internalCatalogMarker, sddtExtrasMarker]) {
  if (!template.includes(value)) throw new Error("模板中未找到注入标记 " + value);
}

const runtimeThemeFiles = [
  "rating-chart/renderer/theme.html",
  "rating-chart/renderer/theme.css",
  "rating-chart/renderer/theme.js",
  "song-detail/renderer/theme.html",
  "song-detail/renderer/theme.css",
  "song-detail/renderer/theme.js",
  "chart-info/renderer/theme.html",
  "chart-info/renderer/theme.css",
  "chart-info/renderer/theme.js",
  "chart-info/assets/spring-green-background.png",
  "completion-search/renderer/theme.html",
  "completion-search/renderer/theme.css",
  "completion-search/renderer/theme.js",
  "constant-table/renderer/theme.html",
  "constant-table/renderer/theme.css",
  "constant-table/renderer/theme.js",
  "level-score/renderer/theme.html",
  "level-score/renderer/theme.css",
  "level-score/renderer/theme.js",
  "level-score/assets/background.png",
  "level-score/assets/diff_basic_59x15.png",
  "level-score/assets/diff_advanced_59x15.png",
  "level-score/assets/diff_expert_59x15.png",
  "level-score/assets/diff_master_59x15.png",
  "level-score/assets/diff_lunatic_59x15.png",
  "level-score/assets/score_detail_ab.png",
  "level-score/assets/score_detail_fc.png",
  "level-score/assets/score_detail_fb.png",
  "level-score/assets/platinum_score_icon.png",
  "level-score/assets/score_tr_a.png",
  "level-score/assets/score_tr_aa.png",
  "level-score/assets/score_tr_aaa.png",
  "level-score/assets/score_tr_b.png",
  "level-score/assets/score_tr_bb.png",
  "level-score/assets/score_tr_bbb.png",
  "level-score/assets/score_tr_c.png",
  "level-score/assets/score_tr_d.png",
  "level-score/assets/score_tr_s.png",
  "level-score/assets/score_tr_ss.png",
  "level-score/assets/score_tr_sss.png",
  "level-score/assets/score_tr_sssplus.png",
  "shared/fonts/NotoSansCJKsc-Regular.otf",
  "shared/fonts/NotoSansCJKsc-Regular.otf",
  "shared/fonts/NotoSansCJKsc-Bold.otf",
  "shared/fonts/NotoSansSymbols2-Regular.ttf",
  "shared/fonts/NotoSansCJKsc-Bold.otf",
  "shared/fonts/NotoSansCJKsc-Bold.otf",
  "rating-chart/assets/overlay.png",
  "rating-chart/assets/basic_plate.png",
  "rating-chart/assets/advanced_plate.png",
  "rating-chart/assets/expert_plate.png",
  "rating-chart/assets/master_plate.png",
  "rating-chart/assets/lunatic_plate.png",
  "rating-chart/assets/basic_plate_platinum.png",
  "rating-chart/assets/advanced_plate_platinum.png",
  "rating-chart/assets/expert_plate_platinum.png",
  "rating-chart/assets/master_plate_platinum.png",
  "rating-chart/assets/lunatic_plate_platinum.png",
  "rating-chart/assets/diff_basic_59x15.png",
  "rating-chart/assets/diff_advanced_59x15.png",
  "rating-chart/assets/diff_expert_59x15.png",
  "rating-chart/assets/diff_master_59x15.png",
  "rating-chart/assets/diff_lunatic_59x15.png",
  "rating-chart/assets/platinum_score_icon.png",
  "rating-chart/assets/score_detail_ab.png",
  "rating-chart/assets/score_detail_fc.png",
  "rating-chart/assets/score_detail_fb.png",
  "rating-chart/assets/score_tr_a.png",
  "rating-chart/assets/score_tr_aa.png",
  "rating-chart/assets/score_tr_aaa.png",
  "rating-chart/assets/score_tr_b.png",
  "rating-chart/assets/score_tr_bb.png",
  "rating-chart/assets/score_tr_bbb.png",
  "rating-chart/assets/score_tr_c.png",
  "rating-chart/assets/score_tr_d.png",
  "rating-chart/assets/score_tr_s.png",
  "rating-chart/assets/score_tr_ss.png",
  "rating-chart/assets/score_tr_sss.png",
  "rating-chart/assets/score_tr_sssplus.png",
  "song-detail/assets/overlay.png",
  "completion-search/assets/back_base.png",
  "completion-search/assets/diff_basic_59x15.png",
  "completion-search/assets/diff_advanced_59x15.png",
  "completion-search/assets/diff_expert_59x15.png",
  "completion-search/assets/diff_master_59x15.png",
  "completion-search/assets/level.png",
  "completion-search/assets/score_detail_ab.png",
  "completion-search/assets/score_detail_fc.png",
  "completion-search/assets/score_detail_fb.png",
  "completion-search/assets/special-plates.json",
  "completion-search/assets/ui_userplate_040100.png",
  "completion-search/assets/ui_userplate_040105.png",
  "completion-search/assets/ui_userplate_040110.png",
  "completion-search/assets/ui_userplate_040115.png",
  "completion-search/assets/ui_userplate_040120.png",
  "completion-search/assets/ui_userplate_040125.png",
  "completion-search/assets/ui_userplate_040130.png",
  "completion-search/assets/ui_userplate_040135.png",
  "completion-search/assets/ui_userplate_040140.png",
  "completion-search/assets/ui_userplate_040145.png",
  "completion-search/assets/ui_userplate_040150.png",
];
const themeBundle = {};
const themeHasher = crypto.createHash("sha256");
for (const relativeName of runtimeThemeFiles) {
  const sourcePath = path.join(THEME_ROOT, ...relativeName.split("/"));
  if (!fs.existsSync(sourcePath)) throw new Error("缺少主题运行资源: " + sourcePath);
  const content = fs.readFileSync(sourcePath);
  themeBundle[relativeName] = content.toString("base64");
  themeHasher.update(relativeName).update(content);
}
const themeHash = themeHasher.digest("hex").slice(0, 16);
const catalogSource = fs.readFileSync(SUPPLEMENTAL_SONGS, "utf8");
const internalCatalogSource = fs.readFileSync(INTERNAL_SONGS, "utf8");
const sddtExtrasSource = fs.readFileSync(SDDT_EXTRAS, "utf8");
const generatedSource = template
  .replace(marker, JSON.stringify(friend))
  .replace(themeMarker, JSON.stringify(themeBundle))
  .replace(themeHashMarker, JSON.stringify(themeHash))
  .replace(catalogMarker, JSON.stringify(catalogSource))
  .replace(internalCatalogMarker, JSON.stringify(internalCatalogSource))
  .replace(sddtExtrasMarker, JSON.stringify(sddtExtrasSource));
fs.writeFileSync(GENERATED, generatedSource, "utf8");
console.log(`   已打包 ${runtimeThemeFiles.length} 个主题文件，主题版本 ${themeHash}`);

step("2/5 用 esbuild 打包 undici 依赖（SEA 不提供 node:undici）");
execFileSync(process.execPath, [
  path.join(DIR, "node_modules", "esbuild", "bin", "esbuild"),
  GENERATED,
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node22",
  "--outfile=" + BUNDLED,
], { cwd: DIR, stdio: "inherit" });
if (!fs.existsSync(BUNDLED)) throw new Error("esbuild 打包失败");

step("3/5 生成 SEA blob 并构建核心 ongenki-core.exe");
execSync(`node --experimental-sea-config "${SEA_CONFIG}"`, { stdio: "inherit", cwd: DIR });
if (!process.execPath.toLowerCase().endsWith("node.exe")) {
  throw new Error("请用 node 运行本脚本: node build.js");
}
fs.copyFileSync(process.execPath, CORE);
try {
  execSync(
    `npx --yes postject "${CORE}" NODE_SEA_BLOB "${BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { stdio: "inherit", cwd: DIR }
  );
} catch (e) {
  fs.rmSync(CORE, { force: true });
  throw e;
}
fs.rmSync(BLOB, { force: true });

step("4/5 核心自测");
execSync(`"${CORE}" --selftest`, { stdio: "inherit", cwd: DIR });

