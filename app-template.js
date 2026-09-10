#!/usr/bin/env node
/**
 * 音击分表生成器 —— 整合版
 *
 * 一键完成：登录 u.otogame.net → 抓取 RATING 数据 → 在 reiwa.f5.si 渲染分表图片 → 保存 jpg
 *
 * 依赖：本机已安装的 Edge（Windows 11 自带）、Node 内置 fetch/WebSocket（无 npm 依赖）
 * 构建：build.js 生成单文件 ongenki-exe.js，再用 Node SEA 打包为 exe
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execSync } = require("node:child_process");
const readline = require("node:readline/promises");
const { pathToFileURL } = require("node:url");
const { ProxyAgent } = require("undici");

// 代理支持：Discord 版 GUI 通过 ONGEKI_HTTPS_PROXY / ONGEKI_HTTP_PROXY 传入本地 HTTP 代理；
// 无代理环境（旧版 GUI、直接运行）保持原有直连行为。
const proxyEnv = process.env.ONGEKI_HTTPS_PROXY || process.env.ONGEKI_HTTP_PROXY || "";
let proxyDispatcher = null;
if (proxyEnv) {
  try { proxyDispatcher = new ProxyAgent(proxyEnv); } catch { proxyDispatcher = null; }
}
function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* 内置：朋友的 reiwa 渲染脚本（构建时注入，见 build.js）                  */
/* ------------------------------------------------------------------ */
const FRIEND_SCRIPT_SOURCE = "__FRIEND_SCRIPT_JSON__";
const THEME_BUNDLE = "__THEME_BUNDLE_JSON__";
const THEME_BUNDLE_HASH = "__THEME_BUNDLE_HASH__";
const SONG_CATALOG_SOURCE = "__SONG_CATALOG_JSON__";
const INTERNAL_SONG_CATALOG_SOURCE = "__INTERNAL_SONG_CATALOG_JSON__";
const SDDT_EXTRAS_SOURCE = "__SDDT_EXTRAS_JSON__";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */
const API_BASE = "https://u.otogame.net/api";
const RATING_URL = `${API_BASE}/game/ongeki/rating`;
const PROFILE_URL = `${API_BASE}/game/ongeki/profile`;
const RECORD_URL = `${API_BASE}/game/ongeki/record`;
// 认证服务走 /aime/ 前缀（VITE_API_URL_PREFIX="aime"），请求体/响应都是 snake_case
const REFRESH_URL = `${API_BASE}/aime/token/refresh`;
const ID_TOKEN_URL = `${API_BASE}/aime/token/id`;
const REIWA_URL = "https://reiwa.f5.si/newbestimg/ongeki/";
const OTG_CDN_URL = "https://oss-hd1.bemanicn.com";
const SONG_JACKET_URL = "https://norca0721.github.io/otoge-db/ongeki/jacket/";
const DEFAULT_ONGEKI_AVATAR_URL = "https://u.otogame.net/img/ongeki/icon_proto_1.png";
// 优先 Chrome（用户常用），其次系统自带 Edge
const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(process.env.LOCALAPPDATA || "", "Microsoft\\Edge\\Application\\msedge.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const VERSION = "4.1.2-unplayed-fade";

// 开发模式（node ongenki-exe.js 直跑）时用 cwd，exe 模式用 exe 所在目录；
// GUI 会把核心解压到临时目录运行，用 ONGEKI_APP_DIR 指回 GUI 所在目录（配置文件放那里）
const appDir =
  process.env.ONGEKI_APP_DIR ||
  (path.basename(process.execPath).toLowerCase().startsWith("node") ? process.cwd() : path.dirname(process.execPath));
const CONFIG_PATH = path.join(appDir, "config.json");
const RATING_JSON_PATH = path.join(appDir, "ongeki-rating.json");

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const finalOptions = { ...options, signal: controller.signal };
    // 外网请求走代理（本机 Edge 调试端口等回环地址除外）
    if (proxyDispatcher && !isLoopbackUrl(url)) finalOptions.dispatcher = proxyDispatcher;
    return await fetch(url, finalOptions);
  } catch (e) {
    const cause = e?.cause;
    const abortLike = e?.name === "AbortError" || cause?.name === "AbortError" ||
      /(?:operation was aborted|operation was canceled|request aborted)/i.test(String(e?.message || e));
    if (timedOut || abortLike) {
      let host = "网络服务";
      try { host = new URL(url).host; } catch {}
      throw new Error(`连接 ${host} 超时或被网络中止（等待 ${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 非交互模式（管道/无 TTY）下跳过提问，用默认值
async function ask(rl, question, fallback) {
  if (!process.stdin.isTTY) return fallback;
  try {
    const ans = (await rl.question(question)).trim();
    return ans || fallback;
  } catch {
    return fallback;
  }
}

function pad(n) {
  return String(n).padStart(2, "0");
}
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeFilePart(value) {
  const cleaned = String(value || "PLAYER")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  return cleaned || "PLAYER";
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

function findBrowser() {
  return BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
}

function killBrowser(proc) {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill("SIGKILL"); // macOS/Linux：taskkill 不存在，直接强杀
  } catch {}
}

/* ------------------------------------------------------------------ */
/* CDP 客户端（Chrome DevTools Protocol，连接 Edge 自动化）               */
/* ------------------------------------------------------------------ */
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("无法连接浏览器调试端口")), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP 错误: ${msg.error.message}`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "未知错误";
      throw new Error("页面执行出错: " + String(d).slice(0, 500));
    }
    return r.result?.value;
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    // Page.navigate may return while Runtime.evaluate still targets the old
    // about:blank document. Wait for the navigation to commit before
    // accepting readyState.
    await this.waitFor(`location.href !== "about:blank" && document.readyState === "complete"`, 30000, 250);
    await sleep(1000);
  }

  async waitFor(expression, timeoutMs, intervalMs) {
    const start = Date.now();
    for (;;) {
      try {
        const v = await this.evaluate(expression);
        if (v) return v;
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error("等待超时: " + expression.slice(0, 80));
      await sleep(intervalMs);
    }
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* Edge 启动                                                           */
/* ------------------------------------------------------------------ */
async function launchEdge({ headless }) {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error("未找到 Chrome 或 Edge 浏览器");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ongeki-exe-"));
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=msEdgeFirstRunExperience",
    "--disable-popup-blocking",
    "--allow-file-access-from-files",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");
  const proc = spawn(browserPath, args, { stdio: "ignore", windowsHide: headless });

  const portPath = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(portPath) && Date.now() < deadline) await sleep(300);
  if (!fs.existsSync(portPath)) {
    killBrowser(proc);
    throw new Error("浏览器启动失败（未找到调试端口）");
  }
  const port = parseInt(fs.readFileSync(portPath, "utf8").split("\n")[0].trim(), 10);

  let target = null;
  for (let i = 0; i < 20 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetchWithTimeout(`http://127.0.0.1:${port}/json/list`, {}, 5000)).json();
      target = list.find((t) => t.type === "page");
    } catch {}
  }
  if (!target) throw new Error("无法获取浏览器页面目标");
  return { proc, wsUrl: target.webSocketDebuggerUrl, userDataDir };
}

/* ------------------------------------------------------------------ */
/* Cookie jar（无头登录用）                                              */
/* ------------------------------------------------------------------ */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

class CookieJar {
  constructor() {
    this.cookies = {}; // host -> {name: value(原始)}
  }
  setCookies(host, setCookieHeaders) {
    for (const c of setCookieHeaders || []) {
      const [pair, ...attrs] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      let target = host;
      for (const a of attrs) {
        const m = a.trim().match(/^domain=(.+)$/i);
        if (m) target = m[1].toLowerCase().replace(/^\./, "");
      }
      this.cookies[target] = this.cookies[target] || {};
      if (c.toLowerCase().includes("max-age=0") || c.toLowerCase().includes("expires=thu, 01 jan 1970")) {
        delete this.cookies[target][k]; // 过期删除
      } else {
        this.cookies[target][k] = v;
      }
    }
  }
  getRaw(host, name) {
    return (this.cookies[host] || {})[name];
  }
  headerFor(host) {
    const parts = [];
    for (const [h, map] of Object.entries(this.cookies)) {
      if (host.endsWith(h) || h.endsWith(host)) {
        for (const [k, v] of Object.entries(map)) parts.push(`${k}=${v}`);
      }
    }
    return parts.join("; ");
  }
}

async function httpFetch(jar, url, { method = "GET", json, form, headers = {}, accept = "application/json" } = {}) {
  const h = { Accept: accept, "User-Agent": UA, ...headers };
  if (json !== undefined) h["Content-Type"] = "application/json";
  if (form !== undefined) h["Content-Type"] = "application/x-www-form-urlencoded";
  const host = new URL(url).host;
  const cookie = jar.headerFor(host);
  if (cookie) h.Cookie = cookie;
  const res = await fetchWithTimeout(url, {
    method,
    headers: h,
    body: json !== undefined ? JSON.stringify(json) : form !== undefined ? form : undefined,
  }, 30000);
  jar.setCookies(new URL(res.url).host, res.headers.getSetCookie?.() || []);
  return res;
}

/* ------------------------------------------------------------------ */
/* u.otogame API                                                       */
/* ------------------------------------------------------------------ */
async function apiRating(token) {
  const res = await fetchWithTimeout(RATING_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }, 30000);
  return { status: res.status, text: await res.text() };
}

async function apiProfile(token) {
  const res = await fetchWithTimeout(PROFILE_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }, 30000);
  return { status: res.status, text: await res.text() };
}

async function apiRecordList(token, params) {
  const query = new URLSearchParams(params).toString();
  const res = await fetchWithTimeout(`${RECORD_URL}?${query}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }, 30000);
  return { status: res.status, text: await res.text() };
}

async function apiRecordDetail(token, musicId) {
  const res = await fetchWithTimeout(`${RECORD_URL}/${encodeURIComponent(musicId)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }, 30000);
  return { status: res.status, text: await res.text() };
}

async function apiRefresh(refreshToken) {
  const res = await fetchWithTimeout(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    // 认证接口用 snake_case 字段
    body: JSON.stringify({ refresh_token: refreshToken }),
  }, 30000);
  return { status: res.status, text: await res.text() };
}

// 用 access token 换 ID token（游戏 API 认证用的是 ID token）
async function apiGetIdToken(accessToken) {
  const res = await fetchWithTimeout(ID_TOKEN_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  }, 30000);
  return { status: res.status, text: await res.text() };
}

async function browserLogin() {
  console.log("  需要登录 u.otogame.net，正在打开浏览器窗口…");
  console.log("  （如弹出登录页请完成登录；如果没看到窗口请检查任务栏）");
  const b = await launchEdge({ headless: false });
  const cdp = new CDP(b.wsUrl);
  await cdp.connect();
  try {
    await cdp.navigate("https://u.otogame.net/");
    // 注意：站点把值存成 JSON 信封 {value,time,expire}，必须解包拿 .value
    const expr = `(() => {
      const unwrap = (v) => {
        try {
          const o = JSON.parse(v);
          return o && typeof o === "object" && "value" in o ? o.value : v;
        } catch { return v; }
      };
      const t = unwrap(localStorage.getItem("TOKEN"));
      if (!t) return null;
      return {
        TOKEN: t,
        REFRESH: unwrap(localStorage.getItem("REFRESH_TOKEN")) || "",
        ID: unwrap(localStorage.getItem("ID_TOKEN")) || "",
        USER: unwrap(localStorage.getItem("USER_INFO")) || "",
      };
    })()`;
    const tok = await cdp.waitFor(expr, 5 * 60 * 1000, 2000);
    let name = "";
    try {
      name = JSON.parse(tok.USER).name || "";
    } catch {}
    console.log("  检测到登录 ✓");
    return { TOKEN: tok.TOKEN, REFRESH_TOKEN: tok.REFRESH, ID_TOKEN: tok.ID, name };
  } finally {
    killBrowser(b.proc);
  }
}

/* ------------------------------------------------------------------ */
/* 无头登录（邮箱 + 密码，纯 HTTP，不弹浏览器）                           */
/* ------------------------------------------------------------------ */
// 凭据错误（邮箱/密码不对）：直接报错，不回退浏览器
class CredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialError";
  }
}
async function headlessLogin(email, password) {
  const jar = new CookieJar();

  // 1) 拿 OAuth 授权链接（bemanicn.com）
  const r1 = await httpFetch(jar, `${API_BASE}/aime/user/redirect`);
  const redirData = await r1.json();
  const authorizeUrl = redirData?.data?.redirect;
  if (!authorizeUrl) throw new Error("无法获取授权链接: " + JSON.stringify(redirData).slice(0, 200));
  console.log("  [登录1] 授权链接获取成功");

  // 2) 访问授权页（未登录会跳到 /login；必须用 text/html，否则服务器不重定向）
  const r2 = await httpFetch(jar, authorizeUrl, { accept: "text/html" });
  let finalUrl = r2.url;
  console.log("  [登录2] 授权页 -> " + new URL(finalUrl).host + new URL(finalUrl).pathname.slice(0, 40));

  // 3) 如果在登录页，提交邮箱密码（Jetstream 登录接口）
  if (/\/login/.test(new URL(finalUrl).pathname)) {
    const xsrf = jar.getRaw("bemanicn.com", "XSRF-TOKEN");
    const r3 = await httpFetch(jar, "https://bemanicn.com/login", {
      method: "POST",
      json: { email, password },
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "X-XSRF-TOKEN": xsrf ? decodeURIComponent(xsrf) : "",
      },
    });
    let loginBody = null;
    try {
      loginBody = await r3.json();
    } catch {}
    console.log("  [登录3] 提交账号密码 -> HTTP " + r3.status + " " + JSON.stringify(loginBody || {}).slice(0, 120));
    if (r3.status === 400 || r3.status === 401 || r3.status === 422) {
      const reason = loginBody?.message || `HTTP ${r3.status}`;
      throw new CredentialError("邮箱或密码错误，请检查后重新生成（服务器提示: " + reason + "）");
    }
    if (loginBody?.two_factor === true) {
      throw new Error("该账号开启了二次验证，无法无头登录，将改用浏览器登录");
    }
  } else {
    console.log("  [登录3] 未跳转到登录页，跳过账号密码提交（" + finalUrl.slice(0, 80) + "）");
  }

  // 4) 带会话重新访问授权页 → 302 到回调（自动批准）或 200 确认页
  const r4 = await httpFetch(jar, authorizeUrl, { accept: "text/html" });
  let callbackUrl = r4.url;
  if (/\/login/.test(new URL(callbackUrl).pathname)) {
    throw new CredentialError("邮箱或密码错误，登录后仍停留在登录页");
  }
  if (!callbackUrl.includes("/auth/callback")) {
    // Passport 确认页：提取隐藏字段并提交审批表单
    const html = await r4.text();
    const xsrf = jar.getRaw("bemanicn.com", "XSRF-TOKEN");
    const hidden = {};
    const formRe = /<form[^>]*action="([^"]*)"[^>]*>/i.exec(html);
    const action = formRe ? formRe[1] : "https://bemanicn.com/oauth/authorize";
    for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
      const nm = /name="([^"]*)"/i.exec(m[0]);
      const vl = /value="([^"]*)"/i.exec(m[0]);
      if (nm) hidden[nm[1]] = vl ? vl[1] : "";
    }
    console.log("  [登录4] 需要审批确认页，提交表单（字段: " + Object.keys(hidden).join(",") + "）");
    const params = new URLSearchParams(hidden).toString();
    const r5 = await httpFetch(jar, new URL(action, "https://bemanicn.com/").href, {
      method: "POST",
      form: params,
      accept: "text/html",
      headers: {
        "X-XSRF-TOKEN": xsrf ? decodeURIComponent(xsrf) : "",
      },
    });
    callbackUrl = r5.url;
    console.log("  [登录4] 审批提交 -> HTTP " + r5.status + " -> " + callbackUrl.slice(0, 100));
  } else {
    console.log("  [登录4] 自动批准，直接回调");
  }
  if (!callbackUrl.includes("/auth/callback")) {
    throw new Error("授权流程异常，未获得回调链接（最终地址: " + callbackUrl.slice(0, 120) + "）");
  }
  const cb = new URL(callbackUrl);
  const code = cb.searchParams.get("code");
  const state = cb.searchParams.get("state");
  if (!code || !state) throw new Error("授权回调缺少 code/state");

  // 5) 用 code 换 token
  const r6 = await httpFetch(jar, `${API_BASE}/aime/user/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  const cbData = await r6.json();
  const data = cbData?.data || {};
  if (data.authType === "need_register") {
    throw new Error("该 otogame 账号还没有绑定游戏卡片（需要先绑定 access code）");
  }
  const tok = data.token || {};
  if (!tok.accessToken) throw new Error("登录回调异常: " + JSON.stringify(cbData).slice(0, 200));
  console.log("  [登录5] 换取 access token 成功");

  // 6) 用 access token 换 ID token（游戏 API 认证用）
  const r7 = await httpFetch(jar, ID_TOKEN_URL, {
    headers: { Authorization: `Bearer ${tok.accessToken}` },
  });
  let idToken = "";
  try {
    idToken = (await r7.json()).data?.id_token || "";
  } catch {}
  console.log("  [登录6] 换取 ID token " + (idToken ? "成功" : "失败（可能为空）"));
  return {
    TOKEN: tok.accessToken,
    REFRESH_TOKEN: tok.refreshToken || "",
    ID_TOKEN: idToken,
    name: data.user?.name || "",
  };
}

/* ------------------------------------------------------------------ */
/* 浏览器凭据登录（GUI 使用）                                      */
/* ------------------------------------------------------------------ */
// bemanicn 的登录页由 Inertia/Jetstream 管理。直接伪造 HTTP POST 容易因
// Cookie、CSRF、Inertia 响应或站点安全策略而把有效凭据误判为错误。
// 这里在一个全新的临时浏览器配置中按真实页面流程填写并提交。
async function browserCredentialLogin(email, password, options = {}) {
  const allowVisibleFallback = options.allowVisibleFallback !== false;
  const attemptTimeoutMs = options.attemptTimeoutMs || 100000;
  let activeBrowser = null;

  const attempt = async (headless) => {
    const redirectResponse = await fetchWithTimeout(`${API_BASE}/aime/user/redirect`, {
      headers: { Accept: "application/json", "User-Agent": UA },
    }, 30000);
    const redirectData = await redirectResponse.json();
    const authorizeUrl = redirectData?.data?.redirect;
    if (!authorizeUrl) {
      throw new Error("无法获取授权链接: " + JSON.stringify(redirectData).slice(0, 200));
    }

    const b = await launchEdge({ headless });
    activeBrowser = b;
    const cdp = new CDP(b.wsUrl);
    await cdp.connect();
    try {
      console.log(`  [浏览器登录] 使用${headless ? "后台" : "可见"}模式打开授权页…`);
      await cdp.navigate(authorizeUrl);
      let currentUrl = await cdp.evaluate(`location.href`);
      let current = new URL(currentUrl);

      if (/\/login/.test(current.pathname)) {
        // The login page is mounted by JavaScript after the document load event.
        // Wait for the complete form instead of assuming a fixed delay is enough.
        await cdp.waitFor(`(() => {
          const emailInput = document.querySelector("#email, input[type=email]");
          const passwordInput = document.querySelector("#password, input[type=password]");
          const form = emailInput && emailInput.closest("form");
          const submit = form && form.querySelector("button[type=submit], input[type=submit]");
          return !!(emailInput && passwordInput && form && submit);
        })()`, 30000, 250);
        const submitted = await cdp.evaluate(`(() => {
          const emailInput = document.querySelector("#email, input[type=email]");
          const passwordInput = document.querySelector("#password, input[type=password]");
          const form = emailInput && emailInput.closest("form");
          const submit = form && form.querySelector("button[type=submit], input[type=submit]");
          if (!emailInput || !passwordInput || !form || !submit) return "登录表单元素缺失";
          const setValue = (input, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
            setter.call(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          };
          setValue(emailInput, ${JSON.stringify(email)});
          setValue(passwordInput, ${JSON.stringify(password)});
          if (form.requestSubmit) form.requestSubmit(submit); else submit.click();
          return "ok";
        })()`);
        if (submitted !== "ok") throw new Error("无法提交登录页: " + submitted);

        const loginOutcome = await cdp.waitFor(`(() => {
          if (location.pathname === "/two-factor-challenge") return "2FA:" + location.href;
          if (location.pathname !== "/login") return "NAV:" + location.href;
          const errors = [...document.querySelectorAll(".text-red-600, .text-red-500, [role=alert]")]
            .map(node => (node.textContent || "").trim()).filter(Boolean).join(" ");
          if (errors) return "ERROR:" + errors;
          return null;
        })()`, 30000, 500);

        if (loginOutcome.startsWith("ERROR:")) {
          throw new CredentialError(loginOutcome.slice(6).replace(/\s+/g, " ").trim());
        }
        if (loginOutcome.startsWith("2FA:")) {
          throw new Error("该账号开启了二次验证，当前版本暂不支持自动输入验证码");
        }
        currentUrl = loginOutcome.slice(4);
        current = new URL(currentUrl);
      }

      // 首次授权可能出现 Passport 确认页，提交“同意/授权”表单。
      for (let i = 0; i < 3 && current.hostname === "bemanicn.com"; i++) {
        if (current.pathname === "/two-factor-challenge") {
          throw new Error("该账号开启了二次验证，当前版本暂不支持自动输入验证码");
        }
        if (/\/login/.test(current.pathname)) {
          throw new CredentialError("登录后仍停留在登录页");
        }
        const before = current.href;
        const approval = await cdp.evaluate(`(() => {
          const forms = [...document.querySelectorAll("form")];
          const form = forms.find(f => /oauth\\/authorize/.test(f.action || "") &&
            !f.querySelector('input[name="_method"][value="DELETE"]'));
          if (!form) return "missing";
          const button = form.querySelector("button[type=submit], input[type=submit]");
          if (form.requestSubmit) form.requestSubmit(button || undefined);
          else if (button) button.click();
          else form.submit();
          return "submitted";
        })()`);
        if (approval !== "submitted") {
          throw new Error("授权流程异常，页面上没有找到授权表单（" + current.pathname + "）");
        }
        currentUrl = await cdp.waitFor(`location.href !== ${JSON.stringify(before)} && location.href`, 30000, 500);
        current = new URL(currentUrl);
      }

      if (!current.hostname.endsWith("otogame.net")) {
        throw new Error("授权后未返回 u.otogame.net（当前地址: " + current.href.slice(0, 160) + "）");
      }

      // u.otogame 回调页会用 code/state 换 token 并写入 localStorage。
      const tokenData = await cdp.waitFor(`(() => {
        const unwrap = (value) => {
          try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : value;
          } catch { return value; }
        };
        const token = unwrap(localStorage.getItem("TOKEN"));
        if (!token) return null;
        return {
          TOKEN: token,
          REFRESH_TOKEN: unwrap(localStorage.getItem("REFRESH_TOKEN")) || "",
          ID_TOKEN: unwrap(localStorage.getItem("ID_TOKEN")) || "",
          USER_INFO: unwrap(localStorage.getItem("USER_INFO")) || "",
        };
      })()`, 45000, 1000);

      let name = "";
      try {
        const userInfo = typeof tokenData.USER_INFO === "string" ? JSON.parse(tokenData.USER_INFO) : tokenData.USER_INFO;
        name = userInfo?.name || "";
      } catch {}
      console.log("  [浏览器登录] 凭据验证与 OAuth 授权成功");
      return { ...tokenData, name };
    } finally {
      killBrowser(b.proc);
      if (activeBrowser === b) activeBrowser = null;
      // 该配置目录只为本次登录创建，其中可能含短暂的登录会话。
      await sleep(1000);
      try { fs.rmSync(b.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
  };

  const timedAttempt = async (headless) => {
    let timer = null;
    try {
      return await Promise.race([
        attempt(headless),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            if (activeBrowser) {
              killBrowser(activeBrowser.proc);
              try { fs.rmSync(activeBrowser.userDataDir, { recursive: true, force: true }); } catch {}
              activeBrowser = null;
            }
            reject(new Error(`自动登录超时（${Math.round(attemptTimeoutMs / 1000)} 秒）`));
          }, attemptTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    return await timedAttempt(true);
  } catch (e) {
    if (e instanceof CredentialError || /二次验证/.test(e.message || "")) throw e;
    if (!allowVisibleFallback) {
      throw new Error("后台自动登录失败（本页不会打开浏览器）: " + (e.message || e));
    }
    console.log("  后台浏览器登录失败，改用可见窗口重试: " + (e.message || e));
    return await timedAttempt(false);
  }
}

/* ------------------------------------------------------------------ */
/* reiwa 渲染                                                          */
/* ------------------------------------------------------------------ */
async function renderOnReiwa(jsonText, name, mode) {
  const attempt = async (headless) => {
    const b = await launchEdge({ headless });
    const cdp = new CDP(b.wsUrl);
    await cdp.connect();
    try {
      console.log(`  [${headless ? "后台" : "窗口"}] 打开 reiwa 页面…`);
      await cdp.navigate(REIWA_URL);
      await cdp.waitFor(`document.readyState === "complete" && typeof initializeArea === "function"`, 30000, 500);
      await cdp.evaluate(FRIEND_SCRIPT_SOURCE);
      await cdp.waitFor(`!!document.querySelector("#otogame-rating-json-dialog")`, 15000, 500);

      const filled = await cdp.evaluate(`(() => {
        const dlg = document.querySelector("#otogame-rating-json-dialog");
        const inp = dlg.querySelector("input");
        const sel = dlg.querySelector("select");
        const ta = dlg.querySelector("textarea");
        const btn = [...dlg.querySelectorAll("button")].find(b => b.textContent.trim() === "Generate");
        if (!inp || !sel || !ta || !btn) return "弹窗元素缺失";
        inp.value = ${JSON.stringify(name)};
        sel.value = ${JSON.stringify(mode)};
        sel.dispatchEvent(new Event("change"));
        ta.value = ${JSON.stringify(jsonText)};
        btn.click();
        return "ok";
      })()`);
      if (filled !== "ok") throw new Error("填充表单失败: " + filled);

      console.log("  已提交数据，正在渲染（约 10~30 秒）…");
      const pollExpr = `(() => {
        const img = document.querySelector("#result-img");
        if (img && img.src && img.src.startsWith("data:image")) return "IMG:" + img.src;
        const dlg = document.querySelector("#otogame-rating-json-dialog");
        if (dlg) {
          const st = [...dlg.querySelectorAll("div")].find(d => d.style.minHeight);
          if (st) {
            const color = (st.style.color || "").toLowerCase();
            const isErrorColor = color.includes("c00") || color.includes("204, 0, 0");
            const txt = st.textContent || "";
            const isProgress = txt.startsWith("Parsing JSON");
            // 只有变红（脚本出错时会设 #c00）且不是进度提示时才报错
            if (isErrorColor && !isProgress) return "STATUS:" + txt;
          }
        }
        return null;
      })()`;
      const imgSrc = await cdp.waitFor(pollExpr, 180000, 3000);
      if (typeof imgSrc === "string" && imgSrc.startsWith("STATUS:")) {
        throw new Error("页面报错: " + imgSrc.slice(7));
      }
      if (typeof imgSrc !== "string" || !imgSrc.startsWith("IMG:")) {
        throw new Error("未获取到结果图片");
      }
      const dataUrl = imgSrc.slice(4);
      const buf = Buffer.from(dataUrl.split(",")[1], "base64");
      if (buf.length < 10000) throw new Error("图片数据异常（文件过小）");
      return { buf, ext: dataUrl.startsWith("data:image/png") ? "png" : "jpg" };
    } finally {
      killBrowser(b.proc);
    }
  };

  try {
    return await attempt(true);
  } catch (e) {
    console.log("  后台模式失败，改用窗口模式重试: " + e.message);
    return await attempt(false);
  }
}

/* ------------------------------------------------------------------ */
/* 双渲染 + 拼接（B50/N10 在上，P50 歌曲区在下）                         */
/* ------------------------------------------------------------------ */
async function renderBothOnReiwa(jsonText, name) {
  const attempt = async (headless) => {
    const b = await launchEdge({ headless });
    const cdp = new CDP(b.wsUrl);
    await cdp.connect();
    try {
      console.log(`  [${headless ? "后台" : "窗口"}] 打开 reiwa 页面…`);
      await cdp.navigate(REIWA_URL);
      // 等页面渲染函数就绪再注入脚本（headless 下加载时序不同）
      await cdp.waitFor(`document.readyState === "complete" && typeof initializeArea === "function" && typeof renderImage === "function"`, 30000, 500);
      await cdp.evaluate(FRIEND_SCRIPT_SOURCE);
      await cdp.evaluate(`window.__otogameCombinedRender = true`);

      const pollExpr = `(() => {
        const imgs = [...document.querySelectorAll("#result-img")];
        const img = imgs[imgs.length - 1];
        if (img && img.src && img.src.startsWith("data:image")) return "IMG:" + img.src;
        const dlg = document.querySelector("#otogame-rating-json-dialog");
        if (dlg) {
          const st = [...dlg.querySelectorAll("div")].find(d => d.style.minHeight);
          if (st) {
            const color = (st.style.color || "").toLowerCase();
            const isErrorColor = color.includes("c00") || color.includes("204, 0, 0");
            const txt = st.textContent || "";
            const isProgress = txt.startsWith("Parsing JSON");
            if (isErrorColor && !isProgress) return "STATUS:" + txt;
          }
        }
        return null;
      })()`;

      const dataUrls = [];
      // 顺序即最终布局：去掉底部声明的 B50/N10 在上，
      // 从“Top P-SCORE 50 Songs”开始并保留最终声明的 P50 在下。
      for (const mode of ["bestnew", "pscore"]) {
        console.log(`  渲染 ${mode === "bestnew" ? "B50/N10" : "P50"} 分表（${mode} 模式）…`);
        await cdp.evaluate(`window.openOtogameRatingJsonToReiwaOngeki && window.openOtogameRatingJsonToReiwaOngeki()`);
        await cdp.waitFor(`!!document.querySelector("#otogame-rating-json-dialog")`, 15000, 500);
        const filled = await cdp.evaluate(`(() => {
          const dlg = document.querySelector("#otogame-rating-json-dialog");
          const inp = dlg.querySelector("input");
          const sel = dlg.querySelector("select");
          const ta = dlg.querySelector("textarea");
          const btn = [...dlg.querySelectorAll("button")].find(b => b.textContent.trim() === "Generate");
          if (!inp || !sel || !ta || !btn) return "弹窗元素缺失";
          inp.value = ${JSON.stringify(name)};
          sel.value = ${JSON.stringify(mode)};
          sel.dispatchEvent(new Event("change"));
          ta.value = ${JSON.stringify(jsonText)};
          // 上一次的 #result-img 仍可能留在 DOM 中。先移除，避免 waitFor
          // 在第二次渲染刚开始时立即误取第一张图。
          [...document.querySelectorAll("#result-img")].forEach(img => img.remove());
          btn.click();
          return "ok";
        })()`);
        if (filled !== "ok") throw new Error("填充表单失败: " + filled);
        const imgSrc = await cdp.waitFor(pollExpr, 180000, 3000);
        if (typeof imgSrc === "string" && imgSrc.startsWith("STATUS:")) {
          throw new Error("页面报错: " + imgSrc.slice(7));
        }
        if (typeof imgSrc !== "string" || !imgSrc.startsWith("IMG:")) {
          throw new Error("未获取到结果图片");
        }
        const dataUrl = imgSrc.slice(4);
        if (dataUrls.includes(dataUrl)) {
          throw new Error("两次渲染返回了同一张图，已停止拼接");
        }
        dataUrls.push(dataUrl); // 立即保存，后面 initializeArea 会清掉 DOM
      }

      // 拼接：两张图纵向叠放
      console.log("  正在拼接两张图…");
      const combined = await cdp.evaluate(`(async () => {
        const load = (src) => new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error("图片解码失败"));
          im.src = src;
        });
        const [a, b] = await Promise.all([load(${JSON.stringify(dataUrls[0])}), load(${JSON.stringify(dataUrls[1])})]);
        const cv = document.createElement("canvas");
        cv.width = Math.max(a.width, b.width);
        cv.height = a.height + b.height;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(a, 0, 0);
        ctx.drawImage(b, 0, a.height);
        return cv.toDataURL("image/png");
      })()`);
      if (typeof combined !== "string" || !combined.startsWith("data:image")) {
        throw new Error("拼接失败");
      }
      const buf = Buffer.from(combined.split(",")[1], "base64");
      if (buf.length < 10000) throw new Error("图片数据异常（文件过小）");
      console.log("  ✓ 两张图拼接完成");
      return buf;
    } finally {
      killBrowser(b.proc);
    }
  };

  try {
    return await attempt(true);
  } catch (e) {
    console.log("  后台模式失败，改用窗口模式重试: " + e.message);
    return await attempt(false);
  }
}

/* ------------------------------------------------------------------ */
/* 本地自定义主题渲染（3600 × 1800，不再调用 reiwa）                       */
/* ------------------------------------------------------------------ */
let cachedThemeDir = null;
let cachedThemeCatalogIndex = null;

function themeCatalogRows(catalog) {
  if (Array.isArray(catalog)) return catalog;
  for (const key of ["songs", "music", "data", "items", "records"]) {
    if (Array.isArray(catalog?.[key])) return catalog[key];
  }
  throw new Error("内置曲库结构无法识别");
}

function themeNormalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s　]+/g, " ")
    .trim()
    .toLocaleLowerCase("ja-JP");
}

function themeChartKey(difficultyId) {
  return ({ 0: "basic", 1: "advanced", 2: "expert", 3: "master", 10: "lunatic" })[Number(difficultyId)];
}

function themeSongTitle(song) {
  return song?.meta?.name || song?.title || song?.name || song?.music_name || song?.musicName || "";
}

function themeSongArtist(song) {
  return song?.meta?.artist || song?.artist || song?.composer || song?.music_artist || song?.musicArtist || "";
}

function themeChartArray(song) {
  for (const key of ["charts", "chart", "difficulties", "level_list", "levels"]) {
    if (Array.isArray(song?.[key])) return song[key];
  }
  return [];
}

function themeChartDifficulty(chart) {
  const raw = chart?.difficulty ?? chart?.difficulty_id ?? chart?.difficultyId ?? chart?.type ?? chart?.name;
  if (typeof raw === "number") return themeChartKey(raw);
  return String(raw || "").trim().toLowerCase().replace(/re[:_-]?master/, "lunatic");
}

function themeChartConstant(chart) {
  for (const key of ["constant", "chart_constant", "chartConstant", "ds", "const", "level_decimal", "levelDecimal"]) {
    const value = Number(chart?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const value = Number(chart?.level);
  return Number.isFinite(value) && value > 0 && value < 20 ? value : null;
}

function themeDirectConstant(song, key) {
  for (const alias of [
    `${key}_constant`, `${key}Constant`, `${key}_const`, `${key}Const`, `${key}_ds`, `${key}Ds`,
  ]) {
    const value = Number(song?.[alias]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function buildThemeCatalogIndex() {
  if (cachedThemeCatalogIndex) return cachedThemeCatalogIndex;
  let supplement;
  let internalRows;
  let sddtExtras;
  try {
    supplement = JSON.parse(SONG_CATALOG_SOURCE);
  } catch (e) {
    throw new Error("补充曲库读取失败: " + (e.message || e));
  }
  try {
    internalRows = JSON.parse(INTERNAL_SONG_CATALOG_SOURCE);
  } catch (e) {
    throw new Error("完整内部曲库读取失败: " + (e.message || e));
  }
  try {
    sddtExtras = JSON.parse(SDDT_EXTRAS_SOURCE);
  } catch (e) {
    throw new Error("SDDT 曲目补充数据读取失败: " + (e.message || e));
  }
  if (!Array.isArray(internalRows) || !internalRows.length) throw new Error("完整内部曲库为空");

  const supplementByTitle = new Map();
  for (const song of themeCatalogRows(supplement)) {
    const title = themeNormalizeTitle(themeSongTitle(song));
    if (!title) continue;
    if (!supplementByTitle.has(title)) supplementByTitle.set(title, []);
    supplementByTitle.get(title).push(song);
  }

  const internalById = new Map();
  const internalByTitle = new Map();
  for (const song of internalRows) {
    const id = Number(song?.id);
    const title = themeNormalizeTitle(song?.name);
    if (Number.isInteger(id) && id > 0) internalById.set(id, song);
    if (!title) continue;
    if (!internalByTitle.has(title)) internalByTitle.set(title, []);
    internalByTitle.get(title).push(song);
  }

  cachedThemeCatalogIndex = { supplementByTitle, internalById, internalByTitle, sddtExtras };
  return cachedThemeCatalogIndex;
}

function findThemeSong(index, title, artist, difficultyId) {
  const candidates = index.supplementByTitle.get(themeNormalizeTitle(title)) || [];
  if (candidates.length <= 1) return candidates[0] || null;
  const artistKey = themeNormalizeTitle(artist);
  const artistMatch = candidates.find((song) => themeNormalizeTitle(themeSongArtist(song)) === artistKey);
  if (artistMatch) return artistMatch;
  const key = themeChartKey(difficultyId);
  return candidates.find((song) => themeChartArray(song).some((chart) => themeChartDifficulty(chart) === key)) || candidates[0];
}

function getThemeInternalConstant(song, difficultyId) {
  const position = ({ 0: 0, 1: 1, 2: 2, 3: 3, 10: 4 })[Number(difficultyId)];
  if (!song || position === undefined || !Array.isArray(song.const)) return null;
  const raw = song.const[position];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function findThemeInternalSong(index, item, title, artist, difficultyId) {
  const itemMusicId = Number(item?.music_id ?? item?.musicId ?? item?.song_id ?? item?.songId);
  if (Number.isInteger(itemMusicId) && itemMusicId > 0) {
    const exact = index.internalById.get(itemMusicId);
    if (getThemeInternalConstant(exact, difficultyId) !== null) return exact;
  }

  const candidates = index.internalByTitle.get(themeNormalizeTitle(title)) || [];
  const withChart = candidates.filter((song) => getThemeInternalConstant(song, difficultyId) !== null);
  if (withChart.length <= 1) return withChart[0] || null;
  const artistKey = themeNormalizeTitle(artist);
  return withChart.find((song) => themeNormalizeTitle(song?.artistName) === artistKey) || withChart[0];
}

function getThemeConstant(song, difficultyId) {
  const key = themeChartKey(difficultyId);
  if (!song || !key) return null;
  const compactKey = ({ basic: "BAS", advanced: "ADV", expert: "EXP", master: "MAS", lunatic: "LUN" })[key];
  const compactValue = Number(song?.[compactKey]?.const);
  if (Number.isFinite(compactValue) && compactValue > 0) return compactValue;
  const chart = themeChartArray(song).find((item) => themeChartDifficulty(item) === key);
  return themeChartConstant(chart) ?? themeDirectConstant(song, key);
}

function mapThemeRatingItem(item, catalogIndex) {
  const music = item?.music || {};
  const title = music.name || item.music_name || item.title || "未命名曲目";
  const artist = music.artist || item.artist || "";
  const difficultyId = Number(item.difficulty_id ?? music?.level_info?.difficulty ?? 3);
  const song = findThemeSong(catalogIndex, title, artist, difficultyId);
  const internalSong = findThemeInternalSong(catalogIndex, item, title, artist, difficultyId);
  const constant = getThemeInternalConstant(internalSong, difficultyId) ?? getThemeConstant(song, difficultyId);
  if (!Number.isFinite(constant)) {
    throw new Error(`曲目“${title}”的 ${themeChartKey(difficultyId) || difficultyId} 定数未找到，已中止生成`);
  }
  const coverId = music.music_id || item.resource_id || item.music_resource_id;
  if (!coverId) throw new Error(`曲目“${title}”缺少曲绘资源 ID，已中止生成`);
  return {
    title,
    artist,
    difficulty_id: difficultyId,
    constant,
    score: Number(item.score || 0),
    rating: Number(item.rating || 0),
    isAllBreak: Boolean(item.is_all_break),
    isFullCombo: Boolean(item.is_full_combo),
    isFullBell: Boolean(item.is_full_bell),
    platinumScoreStar: Number(item.platinum_score_star || 0),
    platinumScoreMax: Number(item.platinum_score_max || 0),
    platinumScoreTheory: Number(item.platinum_score_theory || 0),
    jacketUrl: `${OTG_CDN_URL}/SDDT/cover/${encodeURIComponent(coverId)}.webp-thumbnail`,
  };
}

function unwrapThemeRating(payload) {
  const root = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const firstArray = (...keys) => {
    for (const key of keys) if (Array.isArray(root?.[key])) return root[key];
    return [];
  };
  return {
    root,
    best: firstArray("best_rating_list", "best", "b50", "best_list", "bestList"),
    newest: firstArray("best_new_rating_list", "new", "n10", "new_list", "newList"),
    platinum: firstArray("p_score_rating_list", "platinum", "p50", "platinum_list", "platinumList"),
  };
}

function formatProfileLastPlay(value) {
  if (typeof value === "string") {
    const direct = value.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}    ${direct[4]}:${direct[5]}:${direct[6]}`;
  }
  const numeric = Number(value);
  let date;
  if (Number.isFinite(numeric) && numeric > 0) {
    date = new Date(numeric < 100000000000 ? numeric * 1000 : numeric);
  } else {
    date = new Date(value);
  }
  if (!Number.isFinite(date.getTime())) throw new Error("玩家档案中的最后游玩时间无效");
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}    ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function profileField(profile, ...names) {
  for (const name of names) {
    if (profile && Object.prototype.hasOwnProperty.call(profile, name)) return profile[name];
  }
  return undefined;
}

function findThemeProfileObject(payload) {
  const wanted = [
    ["userName", "user_name"],
    ["level"],
    ["playCount", "play_count"],
    ["lastPlayDate", "last_play_date"],
  ];
  const queue = [{ value: payload, depth: 0 }];
  const seen = new Set();
  let best = null;
  let bestScore = -1;
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value) || depth > 6) continue;
    seen.add(value);
    if (!Array.isArray(value)) {
      let score = 0;
      for (const aliases of wanted) {
        if (aliases.some((name) => Object.prototype.hasOwnProperty.call(value, name))) score += 1;
      }
      if (score > bestScore) {
        best = value;
        bestScore = score;
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return bestScore > 0 ? best : null;
}

function profileStructure(value, depth = 0) {
  if (depth > 3) return "…";
  if (Array.isArray(value)) return `[${value.length ? profileStructure(value[0], depth + 1) : ""}]`;
  if (!value || typeof value !== "object") return typeof value;
  const entries = Object.keys(value).slice(0, 20).map((key) => `${key}:${profileStructure(value[key], depth + 1)}`);
  return `{${entries.join(",")}${Object.keys(value).length > 20 ? ",…" : ""}}`;
}

function normalizeThemeProfile(payload) {
  const profile = findThemeProfileObject(payload);
  if (!profile) throw new Error("玩家档案响应中没有找到资料对象；字段结构=" + profileStructure(payload));
  const playerName = String(profileField(profile, "userName", "user_name") || "").trim();
  if (!playerName) {
    throw new Error("玩家档案资料对象缺少真实游戏名；字段=" + Object.keys(profile).sort().join(","));
  }
  const baseLevel = Number(profileField(profile, "level"));
  const reincarnation = Number(profileField(profile, "reincarnationNum", "reincarnation_num") || 0);
  const playCount = Number(profileField(profile, "playCount", "play_count"));
  if (!Number.isFinite(baseLevel) || !Number.isFinite(reincarnation)) throw new Error("玩家档案缺少有效等级信息");
  if (!Number.isFinite(playCount) || playCount < 0) throw new Error("玩家档案缺少有效总游玩次数");
  const lastPlayDate = profileField(profile, "lastPlayDate", "last_play_date");
  if (lastPlayDate === null || lastPlayDate === undefined || lastPlayDate === "") {
    throw new Error("玩家档案缺少最后游玩时间");
  }
  const avatar = profileField(profile, "avatar", "avatarId", "avatar_id");
  let avatarUrl = DEFAULT_ONGEKI_AVATAR_URL;
  if (avatar) {
    const avatarValue = typeof avatar === "object"
      ? profileField(avatar, "id", "resourceId", "resource_id", "fileName", "file_name", "url")
      : avatar;
    const value = String(avatarValue || "").trim();
    if (/^https?:\/\//i.test(value)) avatarUrl = value;
    else if (value.startsWith("/")) avatarUrl = `https://u.otogame.net${value}`;
    else if (value) avatarUrl = `${OTG_CDN_URL}/SDDT/icon/${encodeURIComponent(value)}.webp-thumbnail`;
  }
  return {
    playerName,
    level: baseLevel + 100 * reincarnation,
    playCount,
    lastPlayTime: formatProfileLastPlay(lastPlayDate),
    avatarUrl,
  };
}

async function getThemeProfile(idToken) {
  if (!idToken) throw new Error("登录成功，但没有可用于读取玩家档案的 ID token");
  const response = await apiProfile(idToken);
  if (response.status !== 200) {
    throw new Error(`玩家档案读取失败 HTTP ${response.status}: ${response.text.slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("玩家档案响应不是有效 JSON");
  }
  return normalizeThemeProfile(parsed);
}

function buildLocalThemeData(jsonText, profile) {
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch (e) {
    throw new Error("RATING 数据不是有效 JSON: " + (e.message || e));
  }
  const catalogIndex = buildThemeCatalogIndex();
  const { root, best, newest, platinum } = unwrapThemeRating(payload);
  const mapAll = (items) => items.map((item) => mapThemeRatingItem(item, catalogIndex));
  return {
    generatedAt: new Date().toISOString(),
    generatorName: "Takase bot",
    profile,
    summary: {
      rating: Number(root.rating || 0),
      bestRating: Number(root.best_rating ?? root.bestRating ?? 0),
      bestNewRating: Number(root.best_new_rating ?? root.bestNewRating ?? 0),
      pScoreRating: Number(root.p_score_rating ?? root.pScoreRating ?? 0),
    },
    best: mapAll(best),
    new: mapAll(newest),
    platinum: mapAll(platinum),
  };
}

function ensureLocalThemeFiles() {
  if (cachedThemeDir && fs.existsSync(path.join(cachedThemeDir, "rating-chart", "renderer", "theme.html"))) return cachedThemeDir;
  if (!THEME_BUNDLE || typeof THEME_BUNDLE !== "object" || Array.isArray(THEME_BUNDLE)) {
    throw new Error("内置主题资源未正确打包");
  }
  const themeDir = path.join(os.tmpdir(), "ongeki-local-theme", THEME_BUNDLE_HASH);
  for (const [relativeName, base64] of Object.entries(THEME_BUNDLE)) {
    const safeName = String(relativeName).replace(/\\/g, "/");
    if (safeName.startsWith("/") || safeName.split("/").includes("..")) throw new Error("内置主题资源路径异常");
    const target = path.join(themeDir, ...safeName.split("/"));
    const content = Buffer.from(base64, "base64");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target) || fs.statSync(target).size !== content.length) fs.writeFileSync(target, content);
  }
  const htmlPath = path.join(themeDir, "rating-chart", "renderer", "theme.html");
  if (!fs.existsSync(htmlPath)) throw new Error("内置主题缺少 rating-chart/renderer/theme.html");
  cachedThemeDir = themeDir;
  return themeDir;
}

async function waitForLocalTheme(cdp, timeoutMs) {
  const start = Date.now();
  for (;;) {
    let state;
    try {
      state = await cdp.evaluate(`({ ready: window.__THEME_READY__ === true, error: window.__THEME_ERROR__ || null })`);
    } catch {}
    if (state?.error) throw new Error(state.error);
    if (state?.ready) return;
    if (Date.now() - start > timeoutMs) throw new Error("等待本地主题的曲绘、头像和字体加载超时");
    await sleep(250);
  }
}

async function renderLocalTheme(jsonText, profile) {
  const themeDir = ensureLocalThemeFiles();
  const rendererDir = path.join(themeDir, "rating-chart", "renderer");
  const dataPath = path.join(rendererDir, "preview-data.js");
  const data = buildLocalThemeData(jsonText, profile);
  fs.writeFileSync(dataPath, `window.__THEME_DATA__ = ${JSON.stringify(data)};\n`, "utf8");

  let browser = null;
  let cdp = null;
  try {
    console.log("  正在使用内置自定义主题渲染 3600×1800 分表…");
    browser = await launchEdge({ headless: true });
    cdp = new CDP(browser.wsUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 3600,
      height: 1800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.navigate(pathToFileURL(path.join(rendererDir, "theme.html")).href);
    await waitForLocalTheme(cdp, 120000);
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 3600, height: 1800, scale: 1 },
    });
    const buffer = Buffer.from(shot.data || "", "base64");
    if (buffer.length < 100000) throw new Error("本地主题截图数据异常（文件过小）");
    console.log("  ✓ 内置主题渲染完成");
    return buffer;
  } finally {
    cdp?.close();
    if (browser) {
      killBrowser(browser.proc);
      await sleep(300);
      try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
    }
    try { if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { force: true }); } catch {}
  }
}

function songTechnicalRank(score) {
  const value = Number(score);
  if (value >= 1007500) return "SSS+";
  if (value >= 1000000) return "SSS";
  if (value >= 990000) return "SS";
  if (value >= 970000) return "S";
  if (value >= 940000) return "AAA";
  if (value >= 900000) return "AA";
  if (value >= 850000) return "A";
  if (value >= 800000) return "BBB";
  if (value >= 750000) return "BB";
  if (value >= 700000) return "B";
  if (value >= 500000) return "C";
  return "D";
}

function findSongSupplement(index, internalSong) {
  const candidates = index.supplementByTitle.get(themeNormalizeTitle(internalSong?.name)) || [];
  const artistKey = themeNormalizeTitle(internalSong?.artistName);
  const artistMatches = candidates.filter((song) => themeNormalizeTitle(themeSongArtist(song)) === artistKey);
  const pool = artistMatches.length ? artistMatches : candidates;
  const compactKey = internalSong?.isLunatic ? "LUN" : "MAS";
  return pool.find((song) => song?.[compactKey]?.has_chart === true) || pool[0] || null;
}

function songJacketPlaceholder(title, songId) {
  const escape = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char]);
  const safeTitle = escape(String(title || "ONGEKI").slice(0, 28));
  const safeId = escape(songId);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#7760c6"/><stop offset="1" stop-color="#62c8de"/></linearGradient></defs><rect width="640" height="640" fill="url(#g)"/><text x="320" y="280" text-anchor="middle" font-family="sans-serif" font-size="42" fill="white">${safeTitle}</text><text x="320" y="365" text-anchor="middle" font-family="sans-serif" font-size="32" fill="white">Song ID ${safeId}</text></svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

function buildSongDetailThemeData(internalSong, recordData = {}, playerName = "") {
  const index = buildThemeCatalogIndex();
  const supplement = findSongSupplement(index, internalSong);
  const meta = supplement?.meta || {};
  const extra = index.sddtExtras?.[String(internalSong.id)] || {};
  const personalByDifficulty = new Map((recordData.scores || []).map((score) => [Number(score.difficulty), score]));
  const difficulties = [0, 1, 2, 3, 10];
  const charts = difficulties.map((difficultyId, position) => {
    const level = Array.isArray(internalSong.level) ? internalSong.level[position] : null;
    const constant = Array.isArray(internalSong.const) ? Number(internalSong.const[position]) : NaN;
    const hasChart = level !== null && level !== undefined && String(level).trim() !== "" &&
      String(level).trim() !== "-" && Number.isFinite(constant) && constant >= 0;
    if (!hasChart) return { difficultyId, hasChart: false };
    const personal = personalByDifficulty.get(difficultyId);
    return {
      difficultyId,
      hasChart: true,
      level: String(level),
      constant,
      chartDesigner: internalSong.creator?.[position] ?? null,
      noteCount: internalSong.noteTotal?.[position] ?? null,
      bellCount: internalSong.bellTotal?.[position] ?? null,
      personal: personal ? {
        played: true,
        techScore: Number(personal.techScoreMax),
        technicalRank: songTechnicalRank(personal.techScoreMax),
        isAllBreak: personal.isAllBreak === true,
        isFullCombo: personal.isFullCombo === true,
        isFullBell: personal.isFullBell === true,
      } : {
        played: false,
        techScore: null,
        technicalRank: null,
        isAllBreak: false,
        isFullCombo: false,
        isFullBell: false,
      },
    };
  });
  let jacketUrl = "";
  if (recordData.musicId) jacketUrl = `${OTG_CDN_URL}/SDDT/cover/${encodeURIComponent(recordData.musicId)}.webp-thumbnail`;
  else if (meta.image_url) jacketUrl = SONG_JACKET_URL + encodeURIComponent(meta.image_url);
  else jacketUrl = songJacketPlaceholder(internalSong.name, internalSong.id);
  return {
    generatedAt: new Date().toISOString(),
    generatorName: "Takase bot",
    profile: { playerName: String(playerName || "") },
    song: {
      songId: internalSong.id,
      title: internalSong.name,
      artist: internalSong.artistName,
      category: internalSong.genre,
      bpm: internalSong.bpm,
      duration: recordData.duration || extra.duration || null,
      releaseDate: meta.song_release || null,
      version: internalSong.versionID,
      status: internalSong.status === "online" ? "online" : "unavailable",
      jacketUrl,
      bossName: internalSong.boss,
      bossCardId: internalSong.bossCardId,
      bossCardName: internalSong.bossCardName,
      bossLevel: internalSong.bossLevel,
      attribute: internalSong.attributeType,
    },
    charts,
  };
}

async function renderSongDetailTheme(internalSong, recordData, playerName) {
  const themeDir = ensureLocalThemeFiles();
  const rendererDir = path.join(themeDir, "song-detail", "renderer");
  const htmlPath = path.join(rendererDir, "theme.html");
  if (!fs.existsSync(htmlPath)) throw new Error("内置主题缺少 song-detail/renderer/theme.html");
  const dataPath = path.join(rendererDir, "preview-data.js");
  const data = buildSongDetailThemeData(internalSong, recordData, playerName);
  fs.writeFileSync(dataPath, `window.__THEME_DATA__ = ${JSON.stringify(data)};\n`, "utf8");

  let browser = null;
  let cdp = null;
  try {
    console.log("  正在使用定稿主题渲染 2160×1350 单曲全难度成绩图…");
    browser = await launchEdge({ headless: true });
    cdp = new CDP(browser.wsUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 2160,
      height: 1350,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.navigate(pathToFileURL(htmlPath).href);
    await waitForLocalTheme(cdp, 120000);
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 2160, height: 1350, scale: 1 },
    });
    const buffer = Buffer.from(shot.data || "", "base64");
    if (buffer.length < 50000) throw new Error("单曲主题截图数据异常（文件过小）");
    console.log("  ✓ 单曲全难度成绩图渲染完成");
    return buffer;
  } finally {
    cdp?.close();
    if (browser) {
      killBrowser(browser.proc);
      await sleep(300);
      try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
    }
    try { if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { force: true }); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* 单谱面分数线、容错与白金分分析（1800 × 1200）                       */
/* ------------------------------------------------------------------ */
const CHART_INFO_DIFFICULTIES = Object.freeze({
  0: { position: 0, name: "BASIC", color: "#35c980" },
  1: { position: 1, name: "ADVANCED", color: "#efc94c" },
  2: { position: 2, name: "EXPERT", color: "#ee5e73" },
  3: { position: 3, name: "MASTER", color: "#9b63ea" },
  10: { position: 4, name: "LUNATIC", color: "#d5d9e6" },
});

function chartInfoDefinition(difficultyId) {
  return CHART_INFO_DIFFICULTIES[Number(difficultyId)] || null;
}

function chartInfoBaseRating(constant, score) {
  if (score >= 1010000) return constant + 2;
  if (score >= 1007500) return constant + 1.75 + (score - 1007500) * 0.25 / 2500;
  if (score >= 1000000) return constant + 1.25 + (score - 1000000) * 0.5 / 7500;
  if (score >= 990000) return constant + 0.75 + (score - 990000) * 0.5 / 10000;
  if (score >= 970000) return constant + (score - 970000) * 0.75 / 20000;
  if (score >= 900000) return constant - 4 + (score - 900000) * 4 / 70000;
  if (score >= 800000) return constant - 6 + (score - 800000) * 2 / 100000;
  if (score >= 500000) return (score - 500000) * 6 / 300000;
  return 0;
}

function chartInfoRatingAtTarget(constant, score) {
  const scoreBonus = score >= 1007500 ? 0.30 : score >= 1000000 ? 0.20 : score >= 990000 ? 0.10 : 0;
  return chartInfoBaseRating(constant, score) + scoreBonus;
}

function chartInfoTruncateThree(value) {
  return (Math.floor(Number(value) * 1000 + 1e-9) / 1000).toFixed(3);
}

function chartInfoTruncateTwo(value) {
  return Math.floor(Number(value) * 100 + 1e-9) / 100;
}

function buildChartInfoThemeData(song, difficultyId) {
  const definition = chartInfoDefinition(difficultyId);
  if (!definition) throw new Error(`不支持的谱面难度 ID：${difficultyId}`);
  const position = definition.position;
  const level = song?.level?.[position];
  const constant = Number(song?.const?.[position]);
  const noteCount = Number(song?.noteTotal?.[position]);
  const bellCount = Number(song?.bellTotal?.[position]);
  const hasChart = level !== null && level !== undefined && String(level).trim() !== "" && String(level) !== "-" &&
    Number.isFinite(constant) && constant >= 0 && Number.isFinite(noteCount) && noteCount > 0;
  if (!hasChart) throw new Error(`曲目“${song?.name || song?.id || "未知"}”没有 ${definition.name} 谱面`);

  const catalogIndex = buildThemeCatalogIndex();
  const supplement = findSongSupplement(catalogIndex, song);
  const meta = supplement?.meta || {};
  const artist = String(song?.artistName || meta.artist || "");
  const imageUrl = String(meta.image_url || "").trim();
  const jacketUrl = imageUrl
    ? SONG_JACKET_URL + encodeURIComponent(imageUrl)
    : songJacketPlaceholder(song?.name, song?.id);

  const breakLoss = 95000 / noteCount;
  const hitLoss = 380000 / noteCount;
  const missLoss = 950000 / noteCount;
  const bellValue = Number.isFinite(bellCount) && bellCount > 0 ? 60000 / bellCount : null;
  const targets = [
    { rank: "SSS+", target: 1007500 },
    { rank: "SSS", target: 1000000 },
    { rank: "SS", target: 990000 },
    { rank: "S", target: 970000 },
    { rank: "AAA", target: 940000 },
  ];
  const scoreRows = targets.map((item) => {
    const lossBudget = 1010000 - item.target;
    return {
      ...item,
      rating: chartInfoTruncateThree(chartInfoRatingAtTarget(constant, item.target)),
      lossBudget,
      maxBreak: chartInfoTruncateTwo(lossBudget / breakLoss),
      maxHit: chartInfoTruncateTwo(lossBudget / hitLoss),
      maxMiss: chartInfoTruncateTwo(lossBudget / missLoss),
    };
  });

  const platinumTheory = noteCount * 2;
  const platinumDefinitions = [
    { stars: 5, rainbow: true, lower: 0.99, range: "99% ～ 100%" },
    { stars: 5, rainbow: false, lower: 0.98, range: "98% ～ 99%" },
    { stars: 4, rainbow: false, lower: 0.97, range: "97% ～ 98%" },
    { stars: 3, rainbow: false, lower: 0.96, range: "96% ～ 97%" },
    { stars: 2, rainbow: false, lower: 0.95, range: "95% ～ 96%" },
    { stars: 1, rainbow: false, lower: 0.94, range: "94% ～ 95%" },
  ];
  const platinumRows = platinumDefinitions.map((item) => {
    const minimum = Math.ceil(platinumTheory * item.lower);
    const lossBudget = platinumTheory - minimum;
    return {
      ...item,
      minimum,
      lossBudget,
      maxMinusOne: lossBudget,
      maxMinusTwo: Math.floor(lossBudget / 2),
      rating: (item.stars * constant * constant / 1000).toFixed(3),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    generatorName: "Takase bot",
    chart: {
      songId: Number(song.id),
      title: String(song.name || ""),
      artist,
      jacketUrl,
      difficultyId: Number(difficultyId),
      difficulty: definition.name,
      color: definition.color,
      level: String(level),
      constant,
      noteCount,
      bellCount: Number.isFinite(bellCount) && bellCount >= 0 ? bellCount : 0,
    },
    scoreRows,
    units: {
      breakLoss,
      hitLoss,
      missLoss,
      bellValue,
      bellToBreak: bellValue === null ? null : bellValue / breakLoss,
      bellToHit: bellValue === null ? null : bellValue / hitLoss,
      bellToMiss: bellValue === null ? null : bellValue / missLoss,
    },
    platinumTheory,
    platinumRows,
  };
}

async function renderChartInfoTheme(data) {
  const themeDir = ensureLocalThemeFiles();
  const rendererDir = path.join(themeDir, "chart-info", "renderer");
  const htmlPath = path.join(rendererDir, "theme.html");
  if (!fs.existsSync(htmlPath)) throw new Error("内置主题缺少 chart-info/renderer/theme.html");
  const dataPath = path.join(rendererDir, "preview-data.js");
  fs.writeFileSync(dataPath, `window.__THEME_DATA__ = ${JSON.stringify(data)};\n`, "utf8");

  let browser = null;
  let cdp = null;
  try {
    console.log("  正在渲染 1800×1200 单谱面分析图…");
    browser = await launchEdge({ headless: true });
    cdp = new CDP(browser.wsUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1800,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.navigate(pathToFileURL(htmlPath).href);
    await waitForLocalTheme(cdp, 120000);
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 1800, height: 1200, scale: 1 },
    });
    const buffer = Buffer.from(shot.data || "", "base64");
    if (buffer.length < 40000) throw new Error("单谱面分析图截图数据异常（文件过小）");
    console.log("  ✓ 单谱面分析图渲染完成");
    return buffer;
  } finally {
    cdp?.close();
    if (browser) {
      killBrowser(browser.proc);
      await sleep(300);
      try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
    }
    try { if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { force: true }); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* 版本牌子完成度（1080 × 1920）                                        */
/* ------------------------------------------------------------------ */
let cachedCompletionPlates = null;

function completionPlateDefinitions() {
  if (cachedCompletionPlates) return cachedCompletionPlates;
  const relativePath = "completion-search/assets/special-plates.json";
  const encoded = THEME_BUNDLE?.[relativePath];
  if (!encoded) throw new Error("内置主题缺少 " + relativePath);
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (error) {
    throw new Error("牌子资源索引解析失败: " + (error.message || error));
  }
  const plates = Array.isArray(manifest?.plates) ? manifest.plates : [];
  if (plates.length !== 11) throw new Error("牌子资源索引数量异常，应为 11 个");
  cachedCompletionPlates = plates.map((plate) => ({
    ...plate,
    id: String(plate.id || ""),
    catalogVersion: String(plate.catalogVersion || ""),
    recordVersionIndex: Number(plate.recordVersionIndex),
  }));
  return cachedCompletionPlates;
}

function getCompletionPlate(plateId) {
  const wanted = String(plateId || "").trim();
  const plate = completionPlateDefinitions().find((item) => item.id === wanted);
  if (!plate) throw new Error("不支持的牌子编号：" + wanted);
  if (!plate.catalogVersion || !Number.isInteger(plate.recordVersionIndex)) {
    throw new Error("牌子“" + (plate.nameJa || plate.id) + "”缺少曲库版本映射");
  }
  return plate;
}

function completionHasChart(song, position) {
  const level = Array.isArray(song?.level) ? song.level[position] : null;
  const constant = Array.isArray(song?.const) ? Number(song.const[position]) : NaN;
  return level !== null && level !== undefined && String(level).trim() !== "" &&
    String(level).trim() !== "-" && Number.isFinite(constant) && constant >= 0;
}

function completionIsBonusTrack(song) {
  // 内部曲库以 7000～7999 作为 BONUS TRACK（当前均为角色 Solo 版）命名空间。
  // 它们虽然有独立曲绘和成绩，也会带版本字段，但官方明确不计入特殊牌子。
  const songId = Number(song?.id);
  return Number.isInteger(songId) && songId >= 7000 && songId < 8000;
}

function completionVersionSongs(plate) {
  const index = buildThemeCatalogIndex();
  return [...index.internalById.values()]
    .filter((song) => String(song?.versionID || "") === plate.catalogVersion)
    .filter((song) => song?.isLunatic !== true)
    .filter((song) => !completionIsBonusTrack(song))
    .filter((song) => song?.status === "online")
    .filter((song) => completionHasChart(song, 3))
    .filter((song) => findSongSupplement(index, song)?.meta?.is_deleted !== true)
    .sort((left, right) => Number(left.id) - Number(right.id));
}

function completionRecordTitle(record) {
  return String(record?.music?.name || record?.music?.title || record?.music_name || record?.title || "").trim();
}

function completionRecordArtist(record) {
  return String(record?.music?.artist || record?.artist || "").trim();
}

function completionRecordCoverId(record) {
  const candidates = [
    record?.music?.musicId,
    record?.music?.music_id,
    record?.resource_id,
    record?.resourceId,
    record?.music_resource_id,
    record?.musicResourceId,
  ];
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (!text || /^\d+$/.test(text)) continue;
    return text;
  }
  return "";
}

function completionAchievement(record) {
  const score = record?.score || record?.highScore || record?.high_score || record || {};
  return {
    isAllBreak: !!(score.isAllBreak ?? score.is_all_break ?? record?.isAllBreak ?? record?.is_all_break),
    isFullCombo: !!(score.isFullCombo ?? score.is_full_combo ?? record?.isFullCombo ?? record?.is_full_combo),
    isFullBell: !!(score.isFullBell ?? score.is_full_bell ?? record?.isFullBell ?? record?.is_full_bell),
    techScore: Number(score.techScoreMax ?? score.tech_score_max ?? score.techScore ?? score.tech_score ?? 0) || 0,
    platinumScoreStar: Math.max(0, Number(
      score.platinumScoreStar ?? score.platinum_score_star ?? score.platinumStar ?? score.platinum_star ??
      score.platinumInfo?.stars ?? score.platinum_info?.stars ??
      record?.platinumScoreStar ?? record?.platinum_score_star ?? 0
    ) || 0),
  };
}

function completionRecordSong(record, songsByTitle) {
  const title = themeNormalizeTitle(completionRecordTitle(record));
  const candidates = songsByTitle.get(title) || [];
  if (candidates.length <= 1) return candidates[0] || null;
  const artist = themeNormalizeTitle(completionRecordArtist(record));
  return candidates.find((song) => themeNormalizeTitle(song.artistName) === artist) || candidates[0];
}

function indexCompletionRecords(versionSongs, recordsByDifficulty) {
  const songsByTitle = new Map();
  for (const song of versionSongs) {
    const title = themeNormalizeTitle(song.name);
    if (!songsByTitle.has(title)) songsByTitle.set(title, []);
    songsByTitle.get(title).push(song);
  }

  const achievements = new Map();
  const coverBySong = new Map();
  for (const difficultyId of [0, 1, 2, 3]) {
    const rows = recordsByDifficulty instanceof Map
      ? (recordsByDifficulty.get(difficultyId) || [])
      : (recordsByDifficulty?.[difficultyId] || []);
    const bySong = new Map();
    for (const record of rows) {
      const song = completionRecordSong(record, songsByTitle);
      if (!song) continue;
      const achievement = completionAchievement(record);
      const previous = bySong.get(Number(song.id));
      if (!previous || achievement.techScore >= previous.techScore) bySong.set(Number(song.id), achievement);
      const coverId = completionRecordCoverId(record);
      if (coverId) coverBySong.set(Number(song.id), coverId);
    }
    achievements.set(difficultyId, bySong);
  }
  return { achievements, coverBySong };
}

function completionSongJacket(index, song, coverBySong) {
  const coverId = coverBySong.get(Number(song.id));
  if (coverId) return `${OTG_CDN_URL}/SDDT/cover/${encodeURIComponent(coverId)}.webp-thumbnail`;
  const supplement = findSongSupplement(index, song);
  const imageUrl = String(supplement?.meta?.image_url || "").trim();
  if (imageUrl) return SONG_JACKET_URL + encodeURIComponent(imageUrl);
  return songJacketPlaceholder(song.name, song.id);
}

function buildCompletionThemeData(plate, versionSongs, recordsByDifficulty, profile) {
  const index = buildThemeCatalogIndex();
  const { achievements, coverBySong } = indexCompletionRecords(versionSongs, recordsByDifficulty);
  const master = achievements.get(3) || new Map();
  const songs = versionSongs.map((song) => {
    const personal = master.get(Number(song.id)) || {};
    return {
      songId: Number(song.id),
      title: song.name,
      jacketUrl: completionSongJacket(index, song, coverBySong),
      masterLevel: String(song.level[3]),
      masterConstant: Number(song.const[3]),
      isAllBreak: personal.isAllBreak === true,
      isFullCombo: personal.isFullCombo === true,
      isFullBell: personal.isFullBell === true,
    };
  });

  const summary = {};
  const keys = ["basic", "advanced", "expert", "master"];
  for (let difficultyId = 0; difficultyId <= 3; difficultyId += 1) {
    const eligible = versionSongs.filter((song) => completionHasChart(song, difficultyId));
    const personal = achievements.get(difficultyId) || new Map();
    summary[keys[difficultyId]] = {
      allBreak: eligible.filter((song) => personal.get(Number(song.id))?.isAllBreak === true).length,
      fullBell: eligible.filter((song) => personal.get(Number(song.id))?.isFullBell === true).length,
      total: eligible.length,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    profile,
    plate: {
      id: plate.id,
      nameJa: plate.nameJa,
      nameZhHans: plate.nameZhHans,
      version: plate.version,
      layoutUrl: `../assets/${plate.fullLayout}`,
    },
    songs,
    summary,
  };
}

async function fetchCompletionRecordsForDifficulty(token, plate, difficultyId) {
  const rows = [];
  let page = 1;
  let totalPage = 1;
  do {
    const result = await apiRecordList(token, {
      sort: "version",
      sort_type: String(plate.recordVersionIndex),
      diff: String(difficultyId),
      page: String(page),
      per_page: "20",
    });
    if (result.status !== 200) {
      if (result.status === 401 || result.status === 403) {
        throw new Error(
          `账号登录成功，但游戏数据服务未接受当前登录状态（HTTP ${result.status}）。` +
          "请确认该账号已绑定可用的 Aime 卡后重试"
        );
      }
      throw new Error(`获取${["BASIC", "ADVANCED", "EXPERT", "MASTER"][difficultyId]}版本记录失败 HTTP ${result.status}: ${result.text.slice(0, 240)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      throw new Error("版本成绩响应不是有效 JSON");
    }
    const current = readRecordPage(parsed);
    rows.push(...current.list);
    totalPage = Number(current.pagination.totalPage ?? current.pagination.total_page ?? 1) || 1;
    page += 1;
  } while (page <= totalPage && page <= 100);
  return rows;
}

async function fetchCompletionRecords(token, plate) {
  const results = await Promise.all([0, 1, 2, 3].map(async (difficultyId) => {
    const rows = await fetchCompletionRecordsForDifficulty(token, plate, difficultyId);
    console.log(`  ✓ ${["BASIC", "ADVANCED", "EXPERT", "MASTER"][difficultyId]}：读取 ${rows.length} 条版本记录`);
    return [difficultyId, rows];
  }));
  return new Map(results);
}

function fakeCompletionRecords(versionSongs) {
  const records = new Map();
  for (const difficultyId of [0, 1, 2, 3]) {
    records.set(difficultyId, versionSongs
      .filter((song) => completionHasChart(song, difficultyId))
      .map((song, index) => ({
        music: { name: song.name, artist: song.artistName },
        levelInfo: { difficulty: difficultyId },
        score: {
          tech_score_max: 990000 + ((Number(song.id) * 137 + difficultyId * 101) % 20001),
          is_all_break: (index + difficultyId) % 17 === 0,
          is_full_combo: (index + difficultyId) % 9 === 0,
          is_full_bell: (index + difficultyId) % 7 === 0,
        },
      })));
  }
  return records;
}

async function renderCompletionTheme(data) {
  const themeDir = ensureLocalThemeFiles();
  const rendererDir = path.join(themeDir, "completion-search", "renderer");
  const htmlPath = path.join(rendererDir, "theme.html");
  if (!fs.existsSync(htmlPath)) throw new Error("内置主题缺少 completion-search/renderer/theme.html");
  const dataPath = path.join(rendererDir, "preview-data.js");
  fs.writeFileSync(dataPath, `window.__THEME_DATA__ = ${JSON.stringify(data)};\n`, "utf8");

  let browser = null;
  let cdp = null;
  try {
    console.log("[3/4] 正在渲染 1080×1920 版本牌子完成度图…");
    browser = await launchEdge({ headless: true });
    cdp = new CDP(browser.wsUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1080,
      height: 1920,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.navigate(pathToFileURL(htmlPath).href);
    await waitForLocalTheme(cdp, 120000);
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 1080, height: 1920, scale: 1 },
    });
    const buffer = Buffer.from(shot.data || "", "base64");
    if (buffer.length < 100000) throw new Error("牌子完成度主题截图数据异常（文件过小）");
    console.log("  ✓ 牌子完成度图渲染完成");
    return buffer;
  } finally {
    cdp?.close();
    if (browser) {
      killBrowser(browser.proc);
      await sleep(300);
      try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
    }
    try { if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { force: true }); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* 按显示等级查询的全谱面成绩长图                             */
/* ------------------------------------------------------------------ */
const LEVEL_SCORE_LABELS = Object.freeze([
  "0", "1", "2", "3", "4", "5", "6", "7", "7+", "8", "8+", "9", "9+",
  "10", "10+", "11", "11+", "12", "12+", "13", "13+", "14", "14+", "15", "15+",
]);
const LEVEL_SCORE_COLUMNS = 7;
const LEVEL_SCORE_ROWS_PER_PAGE = 10;
const LEVEL_SCORE_PAGE_SIZE = LEVEL_SCORE_COLUMNS * LEVEL_SCORE_ROWS_PER_PAGE;
const LEVEL_SCORE_CANVAS_WIDTH = 1440;

function normalizeLevelScoreLabel(raw) {
  const label = String(raw ?? "")
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/^LEVEL\s*/i, "")
    .replace(/^LV\.?\s*/i, "")
    .replace(/\s+/g, "");
  if (!LEVEL_SCORE_LABELS.includes(label)) {
    throw new Error(`不支持的谱面等级“${String(raw ?? "").trim()}”，请选择 LEVEL 0～15+`);
  }
  return label;
}

function normalizeLevelScoreQuery(raw) {
  const value = String(raw ?? "")
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/^LEVEL\s*/i, "")
    .replace(/^LV\.?\s*/i, "")
    .replace(/\s+/g, "");
  if (value === "ABFB") {
    return {
      mode: "abfb",
      label: "ABFB",
      pageTitle: "ABFB 全谱面成绩",
      sortDescription: "LUNATIC→紫→红→黄→绿，组内单曲 Rating 降序",
    };
  }
  if (LEVEL_SCORE_LABELS.includes(value)) {
    return {
      mode: "level",
      label: value,
      recordLevel: value,
      pageTitle: `Lv.${value} 全谱面成绩`,
      sortDescription: "技术分降序",
    };
  }
  if (/^\d{1,2}\.\d$/.test(value)) {
    const constant = Number(value);
    if (constant >= 0 && constant <= 15.9) {
      const integer = Math.floor(constant);
      const recordLevel = `${integer}${Math.round(constant * 10) % 10 >= 7 ? "+" : ""}`;
      return {
        mode: "constant",
        label: constant.toFixed(1),
        constant,
        recordLevel,
        pageTitle: `定数 ${constant.toFixed(1)} 全谱面成绩`,
        sortDescription: "技术分降序",
      };
    }
  }
  throw new Error(`不支持的 LEVEL 查询“${String(raw ?? "").trim()}”，请输入显示等级、精确定数（如 14.1）或 ABFB`);
}

function levelScoreSortType(level) {
  const index = LEVEL_SCORE_LABELS.indexOf(normalizeLevelScoreLabel(level));
  // u.otogame 的既有 LEVEL 1～15+ 编号是 1～24；新增的 LEVEL 0 使用 0。
  return index;
}

function normalizeLevelScorePage(raw) {
  const page = Number(raw ?? 1);
  if (!Number.isInteger(page) || page < 1) throw new Error("页码必须是从 1 开始的整数");
  return page;
}

function levelScoreCharts(queryInput) {
  const query = queryInput?.mode ? queryInput : normalizeLevelScoreQuery(queryInput);
  const index = buildThemeCatalogIndex();
  const difficulties = [0, 1, 2, 3, 10];
  const charts = [];
  for (const song of index.internalById.values()) {
    // 等级表包含所有难度和 BONUS TRACK，只排除曲库明确标记为已删除的歌曲。
    const status = String(song?.status || "").trim().toLowerCase();
    const deletedByStatus = ["unavailable", "deleted", "removed"].includes(status);
    if (deletedByStatus || findSongSupplement(index, song)?.meta?.is_deleted === true) continue;
    difficulties.forEach((difficultyId, position) => {
      if (!completionHasChart(song, position)) return;
      const displayLevel = String(song.level[position]).trim();
      const constant = Number(song.const[position]);
      if (query.mode === "level" && displayLevel !== query.label) return;
      if (query.mode === "constant" && Math.round(constant * 10) !== Math.round(query.constant * 10)) return;
      charts.push({ song, songId: Number(song.id), difficultyId, position, displayLevel, constant });
    });
  }
  return charts.sort((left, right) =>
    right.constant - left.constant ||
    left.songId - right.songId ||
    left.difficultyId - right.difficultyId
  );
}

function levelScoreRecordDifficulty(record) {
  const candidates = [
    record?.levelInfo?.difficulty,
    record?.level_info?.difficulty,
    record?.difficulty,
    record?.diff,
    record?.score?.difficulty,
    record?.score?.diff,
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if ([0, 1, 2, 3, 10].includes(parsed)) return parsed;
  }
  return null;
}

function levelScoreChartKey(songId, difficultyId) {
  return `${Number(songId)}:${Number(difficultyId)}`;
}

function levelScoreRecordChart(record, chartsByTitle) {
  const candidates = chartsByTitle.get(themeNormalizeTitle(completionRecordTitle(record))) || [];
  if (!candidates.length) return null;
  const difficultyId = levelScoreRecordDifficulty(record);
  const sameDifficulty = difficultyId === null
    ? candidates
    : candidates.filter((chart) => chart.difficultyId === difficultyId);
  if (!sameDifficulty.length) return null;
  const songNo = extractSongNo(record);
  if (Number.isInteger(songNo)) {
    const idMatch = sameDifficulty.find((chart) => chart.songId === songNo);
    if (idMatch) return idMatch;
  }
  if (sameDifficulty.length === 1) return sameDifficulty[0];
  const artist = themeNormalizeTitle(completionRecordArtist(record));
  return sameDifficulty.find((chart) => themeNormalizeTitle(chart.song?.artistName) === artist) || sameDifficulty[0];
}

function indexLevelScoreRecords(charts, records) {
  const chartsByTitle = new Map();
  for (const chart of charts) {
    const title = themeNormalizeTitle(chart.song.name);
    if (!chartsByTitle.has(title)) chartsByTitle.set(title, []);
    chartsByTitle.get(title).push(chart);
  }
  const achievements = new Map();
  const coverByChart = new Map();
  for (const record of records || []) {
    const chart = levelScoreRecordChart(record, chartsByTitle);
    if (!chart) continue;
    const key = levelScoreChartKey(chart.songId, chart.difficultyId);
    const achievement = completionAchievement(record);
    const previous = achievements.get(key);
    // 成绩列表会为未游玩谱面返回 tech_score_max = 0；0 分不能视为已游玩。
    if (achievement.techScore > 0 && (!previous || achievement.techScore >= previous.techScore)) {
      achievements.set(key, achievement);
    }
    const coverId = completionRecordCoverId(record);
    if (coverId) coverByChart.set(key, coverId);
  }
  return { achievements, coverByChart };
}

function levelScoreJacket(index, chart, coverByChart) {
  const key = levelScoreChartKey(chart.songId, chart.difficultyId);
  const coverId = coverByChart.get(key);
  if (coverId) return `${OTG_CDN_URL}/SDDT/cover/${encodeURIComponent(coverId)}.webp-thumbnail`;
  const supplement = findSongSupplement(index, chart.song);
  const imageUrl = String(supplement?.meta?.image_url || "").trim();
  if (imageUrl) return SONG_JACKET_URL + encodeURIComponent(imageUrl);
  return songJacketPlaceholder(chart.song.name, chart.songId);
}

function calculateLevelScoreBaseRating(constant, score) {
  if (score >= 1010000) return constant + 2.0;
  if (score >= 1007500) return constant + 1.75 + (score - 1007500) * 0.25 / 2500;
  if (score >= 1000000) return constant + 1.25 + (score - 1000000) * 0.5 / 7500;
  if (score >= 990000) return constant + 0.75 + (score - 990000) * 0.5 / 10000;
  if (score >= 970000) return constant + (score - 970000) * 0.75 / 20000;
  if (score >= 900000) return constant - 4.0 + (score - 900000) * 4.0 / 70000;
  if (score >= 800000) return constant - 6.0 + (score - 800000) * 2.0 / 100000;
  if (score >= 500000) return (score - 500000) * -6.0 / 300000;
  return 0;
}

function calculateLevelScoreRating(constant, score, isAllBreak, isFullBell) {
  if (!(score > 0)) return 0;
  const scoreBonus = score >= 1007500 ? 0.30 : score >= 1000000 ? 0.20 : score >= 990000 ? 0.10 : 0;
  return calculateLevelScoreBaseRating(constant, score) + scoreBonus + (isAllBreak ? 0.30 : 0) + (isFullBell ? 0.05 : 0);
}

function levelScoreDifficultyGroup(difficultyId) {
  if (Number(difficultyId) === 10) return 0;
  if (Number(difficultyId) === 3) return 1;
  if (Number(difficultyId) === 2) return 2;
  if (Number(difficultyId) === 1) return 3;
  return 4;
}

function buildLevelScoreThemeData(queryInput, charts, records, profile, requestedPage = 1) {
  const query = queryInput?.mode ? queryInput : normalizeLevelScoreQuery(queryInput);
  const page = normalizeLevelScorePage(requestedPage);
  const index = buildThemeCatalogIndex();
  const { achievements, coverByChart } = indexLevelScoreRecords(charts, records);
  let mapped = charts.map((chart) => {
    const personal = achievements.get(levelScoreChartKey(chart.songId, chart.difficultyId));
    const played = Number(personal?.techScore) > 0;
    const constant = Number(chart.constant ?? chart.song.const[chart.position]);
    const isAllBreak = played && personal?.isAllBreak === true;
    const isFullBell = played && personal?.isFullBell === true;
    const techScore = played ? Number(personal.techScore) : null;
    return {
      songId: chart.songId,
      title: chart.song.name,
      artist: chart.song.artistName || "",
      difficultyId: chart.difficultyId,
      level: String(chart.displayLevel ?? chart.song.level[chart.position]),
      constant,
      jacketUrl: levelScoreJacket(index, chart, coverByChart),
      played,
      techScore,
      rating: calculateLevelScoreRating(constant, techScore, isAllBreak, isFullBell),
      platinumScoreStar: played ? Number(personal.platinumScoreStar || 0) : 0,
      isAllBreak,
      isFullCombo: played && personal?.isFullCombo === true,
      isFullBell,
    };
  });
  if (query.mode === "abfb") {
    mapped = mapped
      .filter((chart) => chart.isAllBreak && chart.isFullBell)
      .sort((left, right) =>
        levelScoreDifficultyGroup(left.difficultyId) - levelScoreDifficultyGroup(right.difficultyId) ||
        right.rating - left.rating ||
        Number(right.techScore || 0) - Number(left.techScore || 0) ||
        right.constant - left.constant ||
        left.songId - right.songId ||
        left.difficultyId - right.difficultyId
      );
  } else {
    mapped.sort((left, right) =>
      Number(right.played) - Number(left.played) ||
      Number(right.techScore || 0) - Number(left.techScore || 0) ||
      right.constant - left.constant ||
      left.songId - right.songId ||
      left.difficultyId - right.difficultyId
    );
  }
  const totalPages = Math.max(1, Math.ceil(mapped.length / LEVEL_SCORE_PAGE_SIZE));
  if (page > totalPages) {
    throw new Error(`${query.label} 查询结果只有 ${totalPages} 页，无法显示第 ${page} 页`);
  }
  const start = (page - 1) * LEVEL_SCORE_PAGE_SIZE;
  const pageCharts = mapped.slice(start, start + LEVEL_SCORE_PAGE_SIZE).map((chart, indexOnPage) => ({
    ...chart,
    listPosition: start + indexOnPage + 1,
  }));
  const rows = Math.max(1, Math.ceil(pageCharts.length / LEVEL_SCORE_COLUMNS));
  // 顶部 285px；卡片每行 250px、行距 14px；底部 footer 预留 70px。
  const canvasHeight = Math.max(1080, 285 + rows * 250 + Math.max(0, rows - 1) * 14 + 70);
  return {
    generatedAt: new Date().toISOString(),
    targetLevel: query.label,
    pageTitle: query.pageTitle,
    queryMode: query.mode,
    sortDescription: query.sortDescription,
    canvas: { width: LEVEL_SCORE_CANVAS_WIDTH, height: canvasHeight },
    profile,
    charts: pageCharts,
    pagination: {
      page,
      totalPages,
      pageSize: LEVEL_SCORE_PAGE_SIZE,
      from: pageCharts.length ? start + 1 : 0,
      to: start + pageCharts.length,
      total: mapped.length,
    },
    summary: {
      total: mapped.length,
      played: mapped.filter((chart) => chart.played).length,
      unplayed: mapped.filter((chart) => !chart.played).length,
      theory: mapped.filter((chart) => chart.techScore === 1010000).length,
      sssPlus: mapped.filter((chart) => chart.played && chart.techScore >= 1007500).length,
      sss: mapped.filter((chart) => chart.played && chart.techScore >= 1000000 && chart.techScore < 1007500).length,
      allBreak: mapped.filter((chart) => chart.isAllBreak && !chart.isFullBell).length,
      fullBell: mapped.filter((chart) => chart.isFullBell && !chart.isAllBreak).length,
      allBreakFullBell: mapped.filter((chart) => chart.isAllBreak && chart.isFullBell).length,
      star5: mapped.filter((chart) => chart.platinumScoreStar >= 5).length,
      star4: mapped.filter((chart) => chart.platinumScoreStar === 4).length,
      star3: mapped.filter((chart) => chart.platinumScoreStar === 3).length,
      star2: mapped.filter((chart) => chart.platinumScoreStar === 2).length,
      star1: mapped.filter((chart) => chart.platinumScoreStar === 1).length,
    },
  };
}

async function fetchPagedLevelScoreRecords(token, params, label) {
  const rows = [];
  let page = 1;
  let totalPage = 1;
  do {
    const result = await apiRecordList(token, { ...params, page: String(page), per_page: "20" });
    if (result.status !== 200) {
      if (result.status === 401 || result.status === 403) {
        throw new Error(
          `账号登录成功，但游戏数据服务未接受当前登录状态（HTTP ${result.status}）。` +
          "请确认该账号已绑定可用的 Aime 卡后重试"
        );
      }
      throw new Error(`获取${label}成绩失败 HTTP ${result.status}: ${result.text.slice(0, 240)}`);
    }
    let parsed;
    try { parsed = JSON.parse(result.text); }
    catch { throw new Error(`${label}成绩响应不是有效 JSON`); }
    const current = readRecordPage(parsed);
    rows.push(...current.list);
    totalPage = Number(current.pagination.totalPage ?? current.pagination.total_page ?? 1) || 1;
    page += 1;
  } while (page <= totalPage && page <= 200);
  return rows;
}

async function fetchLevelScoreRecords(token, queryInput) {
  const query = queryInput?.mode ? queryInput : normalizeLevelScoreQuery(queryInput);
  if (query.mode === "abfb") {
    const difficulties = [3, 2, 10, 1, 0];
    const groups = await Promise.all(difficulties.map(async (difficultyId) => {
      const rows = await fetchPagedLevelScoreRecords(token, {
        sort: "genre",
        sort_type: "99",
        diff: String(difficultyId),
      }, ["BASIC", "ADVANCED", "EXPERT", "MASTER"][difficultyId] || "LUNATIC");
      console.log(`  ✓ ${["BASIC", "ADVANCED", "EXPERT", "MASTER"][difficultyId] || "LUNATIC"}：读取 ${rows.length} 条全曲记录`);
      return rows;
    }));
    return groups.flat();
  }
  const targetLevel = query.recordLevel;
  // 当前 LEVEL 0 全部为 LUNATIC，直接从下面的 LUNATIC 索引读取，避免向
  // 普通等级入口发送未定义的 sort_type=0。
  const normal = targetLevel === "0" ? [] : await fetchPagedLevelScoreRecords(token, {
    sort: "level",
    sort_type: String(levelScoreSortType(targetLevel)),
  }, `LEVEL ${targetLevel}`);
  // u.otogame 的“按等级”列表与 LUNATIC 列表是两个入口。
  // 额外读取全部 LUNATIC 成绩，再用本地曲库过滤到目标等级。
  const lunatic = await fetchPagedLevelScoreRecords(token, {
    sort: "genre",
    sort_type: "99",
    diff: "10",
  }, "LUNATIC");
  console.log(`  ✓ ${query.mode === "constant" ? `定数 ${query.label}` : `LEVEL ${targetLevel}`}：读取 ${normal.length} 条候选成绩；LUNATIC 索引 ${lunatic.length} 条`);
  return [...normal, ...lunatic];
}

function fakeLevelScoreRecords(charts) {
  // 模拟真实接口：即使未游玩也可能返回一条 tech_score_max = 0 的记录。
  return charts.map((chart, index) => ({
    music: { name: chart.song.name, artist: chart.song.artistName, music_id: chart.songId },
    levelInfo: { difficulty: chart.difficultyId },
    score: {
      tech_score_max: index % 6 === 5 ? 0 : index === 0 ? 1010000 : 1009800 - ((index * 347) % 32000),
      is_all_break: index % 11 === 0,
      is_full_combo: index % 7 === 0,
      is_full_bell: index % 5 === 0,
      platinum_score_star: index % 4 === 0 ? (index % 5) + 1 : 0,
    },
  }));
}


function buildConstantTableData(input) {
  const query=String(input ?? '').trim();
  if (!/^(?:[0-9]|1[0-9]|20)(?:\.[0-9])?$/.test(query) || Number(query)>20) throw new Error('请输入 0–20 的整数或一位小数，例如 14、14.2。');
  const exact=query.includes('.');
  const charts=levelScoreCharts('ABFB').filter(c=>Number.isFinite(c.constant) && (exact ? Math.round(c.constant*10)===Math.round(Number(query)*10) : Math.floor(c.constant)===Number(query)));
  if (!charts.length) throw new Error('当前曲库没有该定数的谱面。');
  const index=buildThemeCatalogIndex();
  const groups=[];
  for(const chart of charts){const constant=chart.constant.toFixed(1);let group=groups[groups.length-1];if(!group || group.constant!==constant){group={constant,charts:[]};groups.push(group)}group.charts.push({songId:chart.songId,difficultyId:chart.difficultyId,title:chart.song.name,jacketUrl:levelScoreJacket(index,chart,new Map())})}
  const height=48+88+76+groups.reduce((n,g)=>n+30+Math.ceil(g.charts.length/8)*148+(Math.ceil(g.charts.length/8)-1)*14,0);
  return {query,total:charts.length,groups,canvas:{width:1440,height}};
}
async function runConstantTableJobData(job){
  const data=buildConstantTableData(job.query);
  const image=await renderConstantTableTheme(data);
  const name='音击定数表_'+data.query+'.jpg';
  if(job.streamOutput) console.log('CONSTANT_OUTPUT_BASE64:'+name+':'+image.toString('base64'));
  else {const output=path.join(job.saveDir || appDir,name);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,image);console.log('CONSTANT_OUTPUT_FILE:'+output)}
}
async function renderConstantTableTheme(data) {
  const themeDir = ensureLocalThemeFiles();
  const rendererDir = path.join(themeDir, "constant-table", "renderer");
  const htmlPath = path.join(rendererDir, "theme.html");
  if (!fs.existsSync(htmlPath)) throw new Error("内置主题缺少 constant-table/renderer/theme.html");
  const dataPath = path.join(rendererDir, "preview-data.js");
  fs.writeFileSync(dataPath, `window.__THEME_DATA__ = ${JSON.stringify(data)};\n`, "utf8");

  let browser = null;
  let cdp = null;
  try {
    const width = Number(data?.canvas?.width) || LEVEL_SCORE_CANVAS_WIDTH;
    const height = Number(data?.canvas?.height) || 1080;
    console.log(`[3/4] 正在渲染 ${width}×${height} 定数表…`);
    browser = await launchEdge({ headless: true });
    cdp = new CDP(browser.wsUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.navigate(pathToFileURL(htmlPath).href);
    await waitForLocalTheme(cdp, 120000);
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 90,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const buffer = Buffer.from(shot.data || "", "base64");
    if (buffer.length < 1000) throw new Error("定数表截图数据异常（文件过小）");
    console.log(`  ✓ 定数表渲染完成（${Math.round(buffer.length / 1024)} KB）`);
    return buffer;
  } finally {
    cdp?.close();
    if (browser) {
      killBrowser(browser.proc);
      await sleep(300);
      try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
    }
    try { if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { force: true }); } catch {}
  }
}

async function renderLevelScoreTheme(data) {
  const themeDir = ensureLocalThemeFiles();
  const rendererDir = path.join(themeDir, "level-score", "renderer");
  const htmlPath = path.join(rendererDir, "theme.html");
  if (!fs.existsSync(htmlPath)) throw new Error("内置主题缺少 level-score/renderer/theme.html");
  const dataPath = path.join(rendererDir, "preview-data.js");
  fs.writeFileSync(dataPath, `window.__THEME_DATA__ = ${JSON.stringify(data)};\n`, "utf8");

  let browser = null;
  let cdp = null;
  try {
    const width = Number(data?.canvas?.width) || LEVEL_SCORE_CANVAS_WIDTH;
    const height = Number(data?.canvas?.height) || 1080;
    console.log(`[3/4] 正在渲染 ${width}×${height} 等级成绩长图…`);
    browser = await launchEdge({ headless: true });
    cdp = new CDP(browser.wsUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.navigate(pathToFileURL(htmlPath).href);
    await waitForLocalTheme(cdp, 120000);
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 90,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const buffer = Buffer.from(shot.data || "", "base64");
    if (buffer.length < 100000) throw new Error("等级成绩长图截图数据异常（文件过小）");
    console.log(`  ✓ 等级成绩长图渲染完成（${Math.round(buffer.length / 1024)} KB）`);
    return buffer;
  } finally {
    cdp?.close();
    if (browser) {
      killBrowser(browser.proc);
      await sleep(300);
      try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
    }
    try { if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { force: true }); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* 假数据（自测用：ONGEKI_FAKE=1 时跳过 API 与登录）                      */
/* ------------------------------------------------------------------ */
function fakeItem(title, artist, resourceId, diffId, score, rating) {
  return {
    music: { name: title, artist, music_id: resourceId },
    difficulty_id: diffId,
    score,
    rating,
    is_full_combo: true,
    is_all_break: false,
    is_full_bell: false,
    platinum_score_max: 1010000,
    platinum_score_star: 0,
  };
}
function fakeRatingJson() {
  return JSON.stringify({
    code: "ok",
    message: "ok",
    data: {
      rating: 15000,
      best_rating: 15000,
      best_new_rating: 14850,
      p_score_rating: 10000,
      best_rating_list: [
        fakeItem("Ai C", "Feryquitous", "bbee74ade736fd083c014d6eddf9b5c5", 3, 1003567, 16537),
        fakeItem("U.A.D", "HAYAKO", "74aac83fa9cfbecb1c1afa60df980b8c", 3, 1006474, 16431),
      ],
      best_new_rating_list: [
        fakeItem("Synthesis.", "tn-shi", "b45e7a0bf17f5a273ef7f01e8e407199", 3, 991031, 15801),
      ],
      p_score_rating_list: [
        fakeItem("Don't Fight The Music", "黒魔", "5eda3df824b1e22c2184faa52741599c", 3, 989088, 15615),
      ],
    },
    timestamp: 1234567890,
  });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
// 站点 localStorage 里存的是 {value,time,expire} 信封，解包拿 .value
function unwrapToken(v) {
  if (!v || typeof v !== "string") return v;
  try {
    const o = JSON.parse(v);
    if (o && typeof o === "object" && "value" in o) return o.value;
  } catch {}
  return v;
}

async function loginWithJobCredentials(job, options = {}) {
  if (!job?.email || !job?.password) {
    throw new Error("请先在“分表生成”选项卡填写大饼账号邮箱和密码");
  }
  console.log("  正在验证本次输入的邮箱和密码…");
  let login;
  try {
    login = await browserCredentialLogin(job.email, job.password, options);
  } catch (e) {
    if (e instanceof CredentialError) throw new Error("登录失败: " + e.message);
    throw new Error("自动登录失败: " + (e.message || e));
  }
  if (!login.ID_TOKEN && login.TOKEN) {
    const idRes = await apiGetIdToken(login.TOKEN);
    if (idRes.status === 200) login.ID_TOKEN = JSON.parse(idRes.text).data?.id_token || "";
  }
  if (!login.ID_TOKEN) throw new Error("登录成功，但未获取到游戏 ID token");
  console.log("  ✓ 本次账号密码验证成功");
  return login;
}

async function getRatingData(cfg, job) {
  // 0) 兼容旧配置里可能存在的信封 token
  cfg.TOKEN = unwrapToken(cfg.TOKEN);
  cfg.REFRESH_TOKEN = unwrapToken(cfg.REFRESH_TOKEN);
  cfg.ID_TOKEN = unwrapToken(cfg.ID_TOKEN);

  // GUI 每次都明确提供账号密码：必须校验本次凭据，绝不先用旧 token。
  // 否则用户即使输错密码，也会因 config.json 中的历史登录态而继续出图。
  const hasJobCredentials = !!(job?.email && job?.password);
  if (hasJobCredentials) {
    // GUI 的分表生成必须全程静默。后台登录失败时直接把原因返回界面，
    // 禁止退回可见浏览器，否则用户会看到突然弹出的登录窗口。
    const login = await loginWithJobCredentials(job, {
      allowVisibleFallback: false,
      attemptTimeoutMs: 90000,
    });
    if (login.name) cfg.name = login.name;

    const credentialResult = await apiRating(login.ID_TOKEN);
    if (credentialResult.status !== 200) {
      throw new Error(`登录后获取数据失败 HTTP ${credentialResult.status}: ${credentialResult.text.slice(0, 300)}`);
    }
    const credentialParsed = JSON.parse(credentialResult.text);
    if (!credentialParsed?.data?.best_rating_list) {
      throw new Error("响应格式异常: " + credentialResult.text.slice(0, 300));
    }
    return { text: credentialResult.text, data: credentialParsed.data, idToken: login.ID_TOKEN };
  }

  // 1) 游戏 API 认证用 ID token，直接用现有 ID token 尝试
  let r = cfg.ID_TOKEN ? await apiRating(cfg.ID_TOKEN) : { status: 401, text: "" };
  // 2) 401 时用 refresh token 换新 access token，再换 ID token
  if (r.status === 401 && cfg.REFRESH_TOKEN) {
    console.log("  token 已过期，正在刷新…");
    const rr = await apiRefresh(cfg.REFRESH_TOKEN);
    if (rr.status === 200) {
      const tok = JSON.parse(rr.text).data?.token || {};
      cfg.TOKEN = tok.access_token;
      if (tok.refresh_token) cfg.REFRESH_TOKEN = tok.refresh_token;
      const idRes = await apiGetIdToken(cfg.TOKEN);
      if (idRes.status === 200) {
        cfg.ID_TOKEN = JSON.parse(idRes.text).data?.id_token || "";
      }
      saveConfig(cfg);
      if (cfg.ID_TOKEN) r = await apiRating(cfg.ID_TOKEN);
    }
  }
  // 3) 命令行模式没有提供账号密码时，再回退到浏览器登录。
  if (r.status === 401) {
    const login = await browserLogin();
    cfg.TOKEN = login.TOKEN;
    cfg.REFRESH_TOKEN = login.REFRESH_TOKEN || cfg.REFRESH_TOKEN;
    cfg.ID_TOKEN = login.ID_TOKEN;
    if (!cfg.ID_TOKEN && cfg.TOKEN) {
      const idRes = await apiGetIdToken(cfg.TOKEN);
      if (idRes.status === 200) cfg.ID_TOKEN = JSON.parse(idRes.text).data?.id_token || "";
    }
    if (login.name && !cfg.name) cfg.name = login.name;
    saveConfig(cfg);
    r = await apiRating(cfg.ID_TOKEN);
  }
  if (r.status !== 200) {
    const hint = r.status === 401 ? "\n  （提示：登录状态失效，可删除同目录 config.json 后重试，会重新弹出登录窗口）" : "";
    throw new Error(`获取数据失败 HTTP ${r.status}: ${r.text.slice(0, 300)}${hint}`);
  }
  const parsed = JSON.parse(r.text);
  if (!parsed?.data?.best_rating_list) {
    throw new Error("响应格式异常: " + r.text.slice(0, 300));
  }
  return { text: r.text, data: parsed.data, idToken: cfg.ID_TOKEN };
}

function readRecordPage(parsed) {
  const body = parsed?.data;
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  const pagination = parsed?.pagination || body?.pagination || {};
  return { list, pagination };
}

function sameSongTitle(record, job) {
  const music = record?.music || {};
  const wantedTitle = String(job.title || "").trim();
  const title = String(music.name || music.title || "").trim();
  return title === wantedTitle;
}

function categorySortType(category) {
  const value = String(category || "").toUpperCase().replace(/\s+/g, "");
  if (value.includes("POPS") || value.includes("ANIME")) return "1";
  if (value.includes("NICONICO")) return "2";
  if (value.includes("東方")) return "3";
  if (value.includes("VARIETY")) return "4";
  if (value.includes("チュウマイ")) return "5";
  if (value.includes("オンゲキ")) return "6";
  return "99";
}

function extractSongNo(record) {
  const candidates = [
    record?.musicId,
    record?.music_id,
    record?.songId,
    record?.song_id,
    record?.id,
    record?.music?.id,
    record?.music?.songId,
    record?.music?.song_id,
    record?.score?.musicId,
    record?.score?.music_id,
    record?.score?.songId,
    record?.score?.song_id,
    record?.levelInfo?.musicId,
    record?.level_info?.music_id,
  ];
  for (const value of candidates) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed < 100000) return parsed;
  }
  // 不同版本的响应可能把数字编号放在 score/detail 的更深层；只接受
  // 名称明确为 music/song id/no 且值为短整数的字段，避开 UUID 与成绩 ID。
  const seen = new Set();
  const stack = [{ value: record, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value) || depth > 5) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.replace(/_/g, "").toLowerCase();
      if (/^(music|song)(id|no|number)$/.test(normalizedKey)) {
        const parsed = Number(child);
        if (Number.isInteger(parsed) && parsed > 0 && parsed < 10000) return parsed;
      }
      if (child && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

async function findRecordForSong(token, job) {
  // record 列表按难度分页。优先 MASTER，未命中时再查其它难度，
  // 这样只玩过某一个难度的歌曲也能够定位。
  // LUNATIC 在 u.otogame 中使用独立难度 10；若按普通 MASTER 先匹配，
  // 同名的普通谱面会抢先命中，最终就会显示成未游玩。
  const difficulties = job.isLunatic ? [10] : [3, 2, 1, 0];
  const wantedSongNo = Number(job.songNo);
  for (const diff of difficulties) {
    let page = 1;
    let totalPage = 1;
    do {
      const result = await apiRecordList(token, {
        sort: "genre",
        diff: String(diff),
        sort_type: categorySortType(job.category),
        page: String(page),
        // u.otogame 前端当前固定每页 20 条；过大的 per_page 会直接返回 HTTP 400。
        per_page: "20",
      });
      if (result.status !== 200) {
        if (result.status === 401 || result.status === 403) {
          throw new Error(
            `账号登录成功，但游戏数据服务未接受当前登录状态（HTTP ${result.status}）。` +
            "请确认该账号已绑定可用的 Aime 卡后重试"
          );
        }
        throw new Error(`获取单曲记录列表失败 HTTP ${result.status}: ${result.text.slice(0, 240)}`);
      }
      const parsed = JSON.parse(result.text);
      const { list, pagination } = readRecordPage(parsed);
      const titleMatches = list.filter((item) => sameSongTitle(item, job));
      if (titleMatches.length) {
        const wantedArtist = String(job.artist || "").trim();
        if (Number.isInteger(wantedSongNo) && wantedSongNo > 0) {
          const idMatch = titleMatches.find((item) => extractSongNo(item) === wantedSongNo);
          if (idMatch) return idMatch;
        }
        return titleMatches.find((item) => String(item?.music?.artist || "").trim() === wantedArtist) || titleMatches[0];
      }
      totalPage = Number(pagination.totalPage ?? pagination.total_page ?? 1) || 1;
      page += 1;
    } while (page <= totalPage && page <= 200);
  }
  return null;
}

function extractMusicDuration(...sources) {
  const directKeys = new Set([
    "duration", "durationseconds", "durationsec", "playtime", "playtimeseconds",
    "musiclength", "lengthseconds", "songduration",
  ]);
  const format = (value) => {
    if (typeof value === "string") {
      const text = value.trim();
      if (/^\d{1,3}:\d{2}(?:\.\d+)?$/.test(text)) return text;
      if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
      value = Number(text);
    }
    if (!Number.isFinite(value) || value <= 0) return null;
    let seconds = Number(value);
    if (seconds > 10000) seconds /= 1000;
    if (seconds < 20 || seconds > 1800) return null;
    const rounded = Math.round(seconds);
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
  };
  for (const source of sources) {
    const seen = new Set();
    const stack = [{ value: source, depth: 0 }];
    while (stack.length) {
      const { value, depth } = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value) || depth > 5) continue;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        const normalizedKey = key.replace(/[_\s-]/g, "").toLowerCase();
        if (directKeys.has(normalizedKey)) {
          const result = format(child);
          if (result) return result;
        }
        if (child && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return null;
}

function normalizeSongScores(detailParsed) {
  const body = detailParsed?.data?.data || detailParsed?.data || detailParsed || {};
  const scores = Array.isArray(body.scores) ? body.scores : [];
  return scores.map((score) => {
    // 浏览器前端会把 API 的 snake_case 深度转换成 camelCase；本程序直接
    // 请求原始 API，因此两种命名都要兼容，否则真实成绩会被误读为 0。
    const scoreValue = score.techScoreMax ?? score.tech_score_max ?? score.techScore ?? score.tech_score;
    if (scoreValue === undefined || scoreValue === null || scoreValue === "") return null;
    return {
      difficulty: Number(score.difficulty ?? score.diff ?? 0),
      techScoreMax: Number(scoreValue),
      isAllBreak: !!(score.isAllBreak ?? score.is_all_break),
      isFullCombo: !!(score.isFullCombo ?? score.is_full_combo),
      isFullBell: !!(score.isFullBell ?? score.is_full_bell),
    };
  }).filter((score) => score && Number.isFinite(score.techScoreMax));
}

async function getSongRecordData(job) {
  let output;
  if (process.env.ONGEKI_FAKE === "1") {
    const fakeScores = job.isLunatic ? [
      { difficulty: 10, tech_score_max: 1008123, is_all_break: true, is_full_combo: true, is_full_bell: true },
    ] : [
      { difficulty: 0, tech_score_max: 990123, is_all_break: false, is_full_combo: true, is_full_bell: false },
      { difficulty: 3, tech_score_max: 1008123, is_all_break: true, is_full_combo: true, is_full_bell: true },
    ];
    output = {
      found: true,
      songNo: Number(job.songNo) || 498,
      duration: "2:47",
      scores: normalizeSongScores({ data: { scores: fakeScores } }),
    };
  } else {
    console.log("[1/2] 登录并查找该曲目的个人记录…");
    // 单曲成绩页必须完全静默：后台登录失败就把原因返回 GUI，绝不再
    // 打开一个可见浏览器让用户卡在不知该做什么的登录窗口。
    const login = await loginWithJobCredentials(job, {
      allowVisibleFallback: false,
      attemptTimeoutMs: 90000,
    });
    const record = await findRecordForSong(login.ID_TOKEN, job);
    if (!record) {
      output = { found: false, scores: [] };
      console.log("  未找到该曲目的游玩记录，将显示为未游玩");
    } else {
      const musicId = record?.music?.musicId || record?.music?.music_id;
      if (!musicId) throw new Error("已匹配曲目，但响应中缺少 musicId");
      console.log("[2/2] 获取该曲目的全难度最佳成绩…");
      const result = await apiRecordDetail(login.ID_TOKEN, musicId);
      if (result.status !== 200) {
        if (result.status === 401 || result.status === 403) {
          throw new Error(
            `账号登录成功，但游戏数据服务未接受当前登录状态（HTTP ${result.status}）。` +
            "请确认该账号已绑定可用的 Aime 卡后重试"
          );
        }
        throw new Error(`获取单曲详细成绩失败 HTTP ${result.status}: ${result.text.slice(0, 240)}`);
      }
      const parsed = JSON.parse(result.text);
      const detailScores = normalizeSongScores(parsed);
      const listDifficulty = record?.levelInfo?.difficulty ?? record?.level_info?.difficulty;
      const listScore = record?.score && listDifficulty !== undefined
        ? normalizeSongScores({ data: { scores: [{ ...record.score, difficulty: listDifficulty }] } })
        : [];
      for (const score of listScore) {
        if (!detailScores.some((item) => item.difficulty === score.difficulty)) detailScores.push(score);
      }
      output = {
        found: detailScores.length > 0,
        musicId,
        songNo: extractSongNo(record) ?? extractSongNo(parsed),
        duration: extractMusicDuration(record, parsed),
        scores: detailScores,
      };
      console.log(`  ✓ 已获取 ${output.scores.length} 个难度的成绩`);
    }
  }
  return output;
}

async function runSongRecordJob(jobPath) {
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8").replace(/^﻿/, ""));
  if (!job.resultPath) throw new Error("单曲成绩任务缺少 resultPath");
  const output = await getSongRecordData(job);
  fs.writeFileSync(job.resultPath, JSON.stringify(output), "utf8");
  console.log("SONG_RECORD_DONE");
}

async function runSongDetailJobData(job) {
  if (!job || typeof job !== "object") throw new Error("单曲成绩任务参数格式无效");
  const songId = Number(job.songId);
  if (!Number.isInteger(songId) || songId <= 0) throw new Error("单曲成绩任务缺少有效 Song ID");
  const index = buildThemeCatalogIndex();
  const song = index.internalById.get(songId);
  if (!song) throw new Error("内置曲库中不存在 Song ID " + songId);
  console.log(`[1/3] 已定位曲目 id${song.id} ${song.name}`);
  const recordData = await getSongRecordData({
    ...job,
    title: song.name,
    artist: song.artistName || "",
    category: song.genre || "",
    songNo: String(song.id),
    isLunatic: song.isLunatic === true,
  });
  console.log("[2/3] 正在生成单曲全难度成绩图…");
  const image = await renderSongDetailTheme(song, recordData, job.playerName || "");
  const outName = `音击单曲_${safeFilePart(song.name)}_id${song.id}_${timestamp()}.png`;
  if (job.streamOutput) {
    console.log(`[3/3] ✓ 已输出（${Math.round(image.length / 1024)} KB）`);
    console.log(`SONG_OUTPUT_BASE64:${outName}:${image.toString("base64")}`);
  } else {
    const saveDir = job.saveDir || appDir;
    fs.mkdirSync(saveDir, { recursive: true });
    const outPath = path.join(saveDir, outName);
    fs.writeFileSync(outPath, image);
    console.log(`[3/3] ✓ 已保存: ${outPath}（${Math.round(image.length / 1024)} KB）`);
    console.log(`SONG_OUTPUT_FILE:${outPath}`);
  }
  console.log("SONG_JOB_DONE");
}

async function runChartInfoJobData(job) {
  if (!job || typeof job !== "object") throw new Error("谱面分析任务参数格式无效");
  const songId = Number(job.songId);
  const difficultyId = Number(job.difficultyId);
  if (!Number.isInteger(songId) || songId <= 0) throw new Error("谱面分析任务缺少有效 Song ID");
  if (!chartInfoDefinition(difficultyId)) throw new Error("谱面分析任务缺少有效难度");
  const index = buildThemeCatalogIndex();
  const song = index.internalById.get(songId);
  if (!song) throw new Error("内置曲库中不存在 Song ID " + songId);
  const data = buildChartInfoThemeData(song, difficultyId);
  console.log(`[1/2] 已定位 id${song.id} ${song.name} ${data.chart.difficulty}`);
  const image = await renderChartInfoTheme(data);
  const outName = `音击谱面分析_${safeFilePart(song.name)}_${data.chart.difficulty}_id${song.id}_${timestamp()}.png`;
  if (job.streamOutput) {
    console.log(`[2/2] ✓ 已输出（${Math.round(image.length / 1024)} KB）`);
    console.log(`CHART_INFO_OUTPUT_BASE64:${outName}:${image.toString("base64")}`);
  } else {
    const saveDir = job.saveDir || appDir;
    fs.mkdirSync(saveDir, { recursive: true });
    const outPath = path.join(saveDir, outName);
    fs.writeFileSync(outPath, image);
    console.log(`[2/2] ✓ 已保存: ${outPath}（${Math.round(image.length / 1024)} KB）`);
    console.log(`CHART_INFO_OUTPUT_FILE:${outPath}`);
  }
  console.log(`CHART_INFO_SUMMARY:${JSON.stringify(data.chart)}`);
  console.log("CHART_INFO_JOB_DONE");
}

async function runCompletionJobData(job) {
  if (!job || typeof job !== "object") throw new Error("牌子完成度任务参数格式无效");
  const plate = getCompletionPlate(job.plateId);
  const versionSongs = completionVersionSongs(plate);
  if (!versionSongs.length) throw new Error(`当前曲库中没有“${plate.nameJa}”对应的可游玩曲目`);
  console.log(`[1/4] 已选择 ${plate.nameJa} / ${plate.version}，当前有效曲目 ${versionSongs.length} 首`);

  let profile;
  let recordsByDifficulty;
  if (process.env.ONGEKI_FAKE === "1") {
    profile = {
      playerName: String(job.playerName || "DEMO PLAYER"),
      level: 49,
      playCount: 100,
      lastPlayTime: "2026-01-01    12:00:00",
      avatarUrl: DEFAULT_ONGEKI_AVATAR_URL,
    };
    recordsByDifficulty = fakeCompletionRecords(versionSongs);
    console.log("[2/4] （自测模式）已生成四难度模拟完成记录");
  } else {
    console.log("[2/4] 正在登录并读取四难度版本记录…");
    const login = await loginWithJobCredentials(job, {
      allowVisibleFallback: false,
      attemptTimeoutMs: 90000,
    });
    profile = await getThemeProfile(login.ID_TOKEN);
    recordsByDifficulty = await fetchCompletionRecords(login.ID_TOKEN, plate);
  }

  const data = buildCompletionThemeData(plate, versionSongs, recordsByDifficulty, profile);
  const image = await renderCompletionTheme(data);
  const outName = `音击牌子_${safeFilePart(plate.nameJa)}_${safeFilePart(profile.playerName)}_${timestamp()}.png`;
  if (job.streamOutput) {
    console.log(`[4/4] ✓ 已输出（${Math.round(image.length / 1024)} KB）`);
    console.log(`COMPLETION_OUTPUT_BASE64:${outName}:${image.toString("base64")}`);
  } else {
    const saveDir = job.saveDir || appDir;
    fs.mkdirSync(saveDir, { recursive: true });
    const outPath = path.join(saveDir, outName);
    fs.writeFileSync(outPath, image);
    console.log(`[4/4] ✓ 已保存: ${outPath}（${Math.round(image.length / 1024)} KB）`);
    console.log(`COMPLETION_OUTPUT_FILE:${outPath}`);
  }
  console.log(`COMPLETION_SUMMARY:${JSON.stringify({ plateId: plate.id, plateName: plate.nameJa, version: plate.version, songCount: versionSongs.length, summary: data.summary })}`);
  console.log("COMPLETION_JOB_DONE");
}

async function runLevelScoreJobData(job) {
  if (!job || typeof job !== "object") throw new Error("等级成绩任务参数格式无效");
  const query = normalizeLevelScoreQuery(job.level);
  const page = normalizeLevelScorePage(job.page);
  const charts = levelScoreCharts(query);
  if (!charts.length) throw new Error(`当前曲库中没有符合“${query.label}”的可游玩谱面`);
  console.log(`[1/4] ${query.pageTitle}：曲库候选 ${charts.length} 张，准备生成第 ${page} 页`);

  let profile;
  let records;
  if (process.env.ONGEKI_FAKE === "1") {
    profile = {
      playerName: String(job.playerName || "DEMO PLAYER"),
      level: 49,
      playCount: 100,
      lastPlayTime: "2026-01-01    12:00:00",
      avatarUrl: DEFAULT_ONGEKI_AVATAR_URL,
    };
    records = fakeLevelScoreRecords(charts);
    console.log(`[2/4] （自测模式）已生成 ${records.length} 条模拟成绩`);
  } else {
    console.log(`[2/4] 正在登录并读取“${query.label}”查询所需的个人最佳成绩…`);
    const login = await loginWithJobCredentials(job, {
      allowVisibleFallback: false,
      attemptTimeoutMs: 90000,
    });
    profile = await getThemeProfile(login.ID_TOKEN);
    records = await fetchLevelScoreRecords(login.ID_TOKEN, query);
  }

  const data = buildLevelScoreThemeData(query, charts, records, profile, page);
  const image = await renderLevelScoreTheme(data);
  const outName = `音击等级_${safeFilePart(query.label)}_P${page}_${safeFilePart(profile.playerName)}_${timestamp()}.jpg`;
  if (job.streamOutput) {
    console.log(`[4/4] ✓ 已输出（${Math.round(image.length / 1024)} KB）`);
    console.log(`LEVEL_OUTPUT_BASE64:${outName}:${image.toString("base64")}`);
  } else {
    const saveDir = job.saveDir || appDir;
    fs.mkdirSync(saveDir, { recursive: true });
    const outPath = path.join(saveDir, outName);
    fs.writeFileSync(outPath, image);
    console.log(`[4/4] ✓ 已保存: ${outPath}（${Math.round(image.length / 1024)} KB）`);
    console.log(`LEVEL_OUTPUT_FILE:${outPath}`);
  }
  console.log(`LEVEL_SUMMARY:${JSON.stringify({ level: query.label, queryMode: query.mode, sortDescription: query.sortDescription, ...data.pagination, ...data.summary })}`);
  console.log("LEVEL_JOB_DONE");
}

/* ------------------------------------------------------------------ */
/* job 模式（GUI 调用：--job <json>）                                    */
/* 全程静默：无头登录 -> 抓数据 -> 双渲染拼接 -> 保存                      */
/* ------------------------------------------------------------------ */
async function runJobData(job) {
  if (!job || typeof job !== "object") throw new Error("任务参数格式无效");
  const fake = process.env.ONGEKI_FAKE === "1";
  const cfg = loadConfig();

  // [1] 获取数据（含登录）
  console.log("[1/3] 获取 u.otogame RATING 数据…");
  let jsonText;
  let profile;
  if (fake) {
    jsonText = fs.existsSync(RATING_JSON_PATH) ? fs.readFileSync(RATING_JSON_PATH, "utf8") : fakeRatingJson();
    profile = {
      playerName: "DEMO PLAYER",
      level: 49,
      playCount: 100,
      lastPlayTime: "2026-01-01    12:00:00",
      avatarUrl: DEFAULT_ONGEKI_AVATAR_URL,
    };
    console.log(`  （自测模式：使用${fs.existsSync(RATING_JSON_PATH) ? "本地 RATING 快照" : "假数据"}）`);
  } else {
    const got = await getRatingData(cfg, job);
    jsonText = got.text;
    fs.writeFileSync(RATING_JSON_PATH, jsonText, "utf8");
    const d = got.data;
    console.log(`  ✓ B${d.best_rating_list.length} 曲 / N${d.best_new_rating_list.length} 曲 / P${d.p_score_rating_list.length} 曲`);
    console.log(`  RATING ${(d.rating || 0) / 1000}`);
    console.log("  正在读取 u.otogame 玩家档案…");
    profile = await getThemeProfile(got.idToken);
    console.log(`  ✓ 玩家 ${profile.playerName} / Lv.${profile.level} / 总游玩 ${profile.playCount} 次`);
  }

  const playerName = profile.playerName;
  console.log(`PLAYER_NAME:${playerName}`);

  // [2] 内置本地主题一次性完成 B50/N10/P50 渲染，不再调用日本分表网站。
  console.log("[2/3] 使用内置主题生成 B50/N10/P50 分表…");
  const combined = await renderLocalTheme(jsonText, profile);

  // [3] 保存
  const outName = `音击分表_${safeFilePart(playerName)}_${timestamp()}.png`;
  if (job.streamOutput) {
    // Discord 版（entry 指定 streamOutput）：图片不落盘，以 base64 输出到 stdout
    console.log(`[3/3] ✓ 已输出（${Math.round(combined.length / 1024)} KB）`);
    console.log(`OUTPUT_BASE64:${outName}:${combined.toString("base64")}`);
  } else {
    const saveDir = job.saveDir || appDir;
    fs.mkdirSync(saveDir, { recursive: true });
    const outPath = path.join(saveDir, outName);
    fs.writeFileSync(outPath, combined);
    console.log(`[3/3] ✓ 已保存: ${outPath}（${Math.round(combined.length / 1024)} KB）`);
    console.log(`OUTPUT_FILE:${outPath}`);
  }
  console.log("JOB_DONE");
}

async function runJob(jobPath) {
  // 兼容 BOM：某些编辑器/C# 写的 UTF-8 文件带 ﻿ 头
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8").replace(/^﻿/, ""));
  return runJobData(job);
}

async function readJsonFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "").trim();
  if (!text) throw new Error("标准输入中没有任务参数");
  return JSON.parse(text);
}

async function runVerifyJobData(job) {
  if (!job || typeof job !== "object") throw new Error("验证参数格式无效");
  if (process.env.ONGEKI_FAKE === "1") {
    console.log("（自测模式：跳过网络登录）");
    console.log("PLAYER_NAME:DEMO PLAYER");
    console.log("PLAYER_LEVEL:49");
    console.log("VERIFY_DONE");
    return;
  }
  const cfg = loadConfig();
  console.log("正在验证 u.otogame 账号并读取玩家档案…");
  const got = await getRatingData(cfg, job);
  const profile = await getThemeProfile(got.idToken);
  console.log(`PLAYER_NAME:${profile.playerName}`);
  console.log(`PLAYER_LEVEL:${profile.level}`);
  console.log("VERIFY_DONE");
}

async function main() {
  try {
    execSync("chcp 65001", { stdio: "ignore" });
  } catch {}

  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    const wrappedProfile = normalizeThemeProfile({
      data: { data: { profile: {
        userName: "DEMO PLAYER",
        level: 49,
        reincarnationNum: 0,
        playCount: 297,
        lastPlayDate: "2026-01-01 12:00:00",
        avatar: null,
      } } },
    });
    const snakeProfile = normalizeThemeProfile({ result: { game_profile: {
      user_name: "DEMO PLAYER",
      level: 49,
      reincarnation_num: 0,
      play_count: 297,
      last_play_date: "2026-01-01 12:00:00",
    } } });
    if (wrappedProfile.playerName !== "DEMO PLAYER" || wrappedProfile.playCount !== 297 ||
        snakeProfile.playerName !== "DEMO PLAYER" || snakeProfile.lastPlayTime !== "2026-01-01    12:00:00") {
      throw new Error("玩家档案兼容解析自测失败");
    }
    const catalogIndex = buildThemeCatalogIndex();
    if (catalogIndex.internalById.size < 1000) throw new Error("完整内部曲库索引自测失败");
    const donut = findThemeInternalSong(catalogIndex, { music_id: 223 }, "ドーナツホール", "ハチ", 1);
    if (getThemeInternalConstant(donut, 1) !== 7.4) {
      throw new Error("内部曲库定数自测失败：ドーナツホール ADVANCED 应为 7.4");
    }
    const viiiBit = catalogIndex.internalById.get(870);
    const songTheme = buildSongDetailThemeData(viiiBit, {
      duration: "2:13",
      scores: [{ difficulty: 3, techScoreMax: 1008123, isAllBreak: true, isFullCombo: true, isFullBell: true }],
    }, "SELFTEST");
    if (songTheme.song.title !== "VIIIbit Explorer" || songTheme.song.bossCardName !== "【R】高瀬 梨緒[体操着]" ||
        songTheme.charts.length !== 5 || songTheme.charts[3].personal.technicalRank !== "SSS+") {
      throw new Error("单曲主题数据映射自测失败");
    }
    const chartInfoTheme = buildChartInfoThemeData(viiiBit, 3);
    if (chartInfoTheme.chart.title !== "VIIIbit Explorer" || chartInfoTheme.chart.artist !== "Lime" ||
        !chartInfoTheme.chart.jacketUrl.endsWith("d9a711a807c5ab8c.png") || chartInfoTheme.chart.difficulty !== "MASTER" ||
        chartInfoTheme.chart.noteCount !== 1658 || chartInfoTheme.chart.bellCount !== 143 ||
        chartInfoTheme.scoreRows[0].rating !== "16.650" || chartInfoTheme.scoreRows[4].rating !== "12.885" ||
        chartInfoTheme.scoreRows[0].maxBreak !== 43.63 || chartInfoTheme.scoreRows[0].maxHit !== 10.9 ||
        Math.abs(chartInfoTheme.units.breakLoss - 57.29794933655006) > 1e-9 ||
        chartInfoTheme.platinumTheory !== 3316 || chartInfoTheme.platinumRows[0].minimum !== 3283 ||
        chartInfoTheme.platinumRows[0].rating !== "1.066" || chartInfoTheme.platinumRows[2].maxMinusTwo !== 49) {
      throw new Error("单谱面分析公式或数据映射自测失败");
    }
    const plates = completionPlateDefinitions();
    const versionSongCounts = plates.map((plate, index) => {
      if (plate.recordVersionIndex !== index) {
        throw new Error(`牌子完成度版本索引自测失败：${plate.nameJa}`);
      }
      const songs = completionVersionSongs(plate);
      const count = songs.length;
      if (count < 1) {
        throw new Error(`牌子完成度曲库映射为空：${plate.nameJa} / ${plate.catalogVersion}`);
      }
      if (songs.some(completionIsBonusTrack)) {
        throw new Error(`牌子完成度仍包含 BONUS TRACK：${plate.nameJa}`);
      }
      return count;
    });
    if (new Set(plates.map((plate) => plate.catalogVersion)).size !== plates.length) {
      throw new Error("牌子完成度曲库版本映射存在重复项");
    }
    const sakuraPlate = getCompletionPlate("040100");
    const sakuraSongs = completionVersionSongs(sakuraPlate);
    const plusSongs = completionVersionSongs(getCompletionPlate("040105"));
    const summerPlusSongs = completionVersionSongs(getCompletionPlate("040115"));
    const refreshSongs = completionVersionSongs(getCompletionPlate("040150"));
    if (!plusSongs.some((song) => Number(song.id) === 167) ||
        !summerPlusSongs.some((song) => Number(song.id) === 361) ||
        refreshSongs.some((song) => [7048, 7049, 7050, 7079, 7080].includes(Number(song.id)))) {
      throw new Error("合唱原曲与 BONUS TRACK Solo 版归属自测失败");
    }
    const completionTheme = buildCompletionThemeData(
      sakuraPlate,
      sakuraSongs,
      fakeCompletionRecords(sakuraSongs),
      { playerName: "SELFTEST", level: 49, avatarUrl: DEFAULT_ONGEKI_AVATAR_URL }
    );
    if (plates.length !== 11 || versionSongCounts.length !== 11 || sakuraSongs.length < 50 ||
        completionTheme.songs.length !== sakuraSongs.length ||
        completionTheme.summary.master.total !== sakuraSongs.length ||
        completionTheme.plate.layoutUrl !== "../assets/ui_userplate_040100.png") {
      throw new Error("牌子完成度数据映射自测失败");
    }
    const level0Charts = levelScoreCharts("lv0");
    const level14Charts = levelScoreCharts("lv14");
    const constant141Charts = levelScoreCharts("14.1");
    const allPlayableCharts = levelScoreCharts("ABFB");
    const fakeLevel14 = fakeLevelScoreRecords(level14Charts);
    const fakeLevel14Played = fakeLevel14.map(completionAchievement).filter((achievement) => achievement.techScore > 0);
    const expectedLevel14Summary = {
      sssPlus: fakeLevel14Played.filter((achievement) => achievement.techScore >= 1007500).length,
      sss: fakeLevel14Played.filter((achievement) => achievement.techScore >= 1000000 && achievement.techScore < 1007500).length,
      allBreak: fakeLevel14Played.filter((achievement) => achievement.isAllBreak && !achievement.isFullBell).length,
      fullBell: fakeLevel14Played.filter((achievement) => achievement.isFullBell && !achievement.isAllBreak).length,
      allBreakFullBell: fakeLevel14Played.filter((achievement) => achievement.isAllBreak && achievement.isFullBell).length,
      star5: fakeLevel14Played.filter((achievement) => achievement.platinumScoreStar >= 5).length,
      star4: fakeLevel14Played.filter((achievement) => achievement.platinumScoreStar === 4).length,
      star3: fakeLevel14Played.filter((achievement) => achievement.platinumScoreStar === 3).length,
      star2: fakeLevel14Played.filter((achievement) => achievement.platinumScoreStar === 2).length,
      star1: fakeLevel14Played.filter((achievement) => achievement.platinumScoreStar === 1).length,
    };
    const level14Theme = buildLevelScoreThemeData(
      "14",
      level14Charts,
      fakeLevel14,
      { playerName: "SELFTEST", level: 49, avatarUrl: DEFAULT_ONGEKI_AVATAR_URL },
      1
    );
    const level14Page4 = buildLevelScoreThemeData(
      "14",
      level14Charts,
      fakeLevel14,
      { playerName: "SELFTEST", level: 49, avatarUrl: DEFAULT_ONGEKI_AVATAR_URL },
      4
    );
    const abfbTheme = buildLevelScoreThemeData(
      "ABFB",
      allPlayableCharts,
      fakeLevelScoreRecords(allPlayableCharts),
      { playerName: "SELFTEST", level: 49, avatarUrl: DEFAULT_ONGEKI_AVATAR_URL },
      1
    );
    const abfbSortValid = abfbTheme.charts.every((chart, index, list) => {
      if (index === 0) return true;
      const previous = list[index - 1];
      const previousGroup = levelScoreDifficultyGroup(previous.difficultyId);
      const currentGroup = levelScoreDifficultyGroup(chart.difficultyId);
      return previousGroup < currentGroup ||
        (previousGroup === currentGroup && previous.rating + 1e-9 >= chart.rating);
    });
    const zeroScoreChart = level14Charts[0];
    const zeroScoreTheme = buildLevelScoreThemeData(
      "14",
      [zeroScoreChart],
      [{
        music: { name: zeroScoreChart.song.name, artist: zeroScoreChart.song.artistName },
        levelInfo: { difficulty: zeroScoreChart.difficultyId },
        score: {
          tech_score_max: 0,
          is_all_break: true,
          is_full_combo: true,
          is_full_bell: true,
          platinum_score_star: 5,
        },
      }],
      { playerName: "SELFTEST", level: 49, avatarUrl: DEFAULT_ONGEKI_AVATAR_URL },
      1
    );
    if (levelScoreSortType("LEVEL 0") !== 0 || levelScoreSortType("LEVEL 14") !== 21 ||
        normalizeLevelScoreQuery("lv.14.1").mode !== "constant" ||
        normalizeLevelScoreQuery("abfb").mode !== "abfb" ||
        constant141Charts.length < 5 || constant141Charts.some((chart) => Math.round(chart.constant * 10) !== 141) ||
        allPlayableCharts.length <= level14Charts.length || !allPlayableCharts.some((chart) => chart.difficultyId === 10) ||
        Math.abs(calculateLevelScoreRating(14.2, 1000000, true, true) - 16.0) > 1e-9 ||
        abfbTheme.queryMode !== "abfb" || abfbTheme.summary.total < 5 ||
        abfbTheme.summary.total !== abfbTheme.summary.allBreakFullBell ||
        abfbTheme.charts.some((chart) => !chart.isAllBreak || !chart.isFullBell) ||
        !abfbTheme.charts.some((chart) => chart.difficultyId === 10) ||
        abfbTheme.charts[0]?.difficultyId !== 10 || !abfbSortValid ||
        level0Charts.length < 20 || !level0Charts.some((chart) => chart.difficultyId === 10) ||
        level0Charts.some((chart) => ["unavailable", "deleted", "removed"].includes(String(chart.song?.status || "").toLowerCase())) ||
        level14Charts.length < 150 || !level14Charts.some((chart) => completionIsBonusTrack(chart.song)) ||
        !level14Charts.some((chart) => chart.difficultyId === 2) ||
        !level14Charts.some((chart) => chart.difficultyId === 10) ||
        level14Theme.charts.length !== LEVEL_SCORE_PAGE_SIZE ||
        level14Theme.charts[0].techScore !== 1010000 ||
        level14Theme.summary.total !== level14Charts.length ||
        level14Theme.summary.sssPlus !== expectedLevel14Summary.sssPlus ||
        level14Theme.summary.sss !== expectedLevel14Summary.sss ||
        level14Theme.summary.allBreak !== expectedLevel14Summary.allBreak ||
        level14Theme.summary.fullBell !== expectedLevel14Summary.fullBell ||
        level14Theme.summary.allBreakFullBell !== expectedLevel14Summary.allBreakFullBell ||
        level14Theme.summary.star5 !== expectedLevel14Summary.star5 ||
        level14Theme.summary.star4 !== expectedLevel14Summary.star4 ||
        level14Theme.summary.star3 !== expectedLevel14Summary.star3 ||
        level14Theme.summary.star2 !== expectedLevel14Summary.star2 ||
        level14Theme.summary.star1 !== expectedLevel14Summary.star1 ||
        level14Theme.pagination.totalPages !== 4 ||
        level14Page4.pagination.page !== 4 || level14Page4.charts.length !== level14Charts.length - LEVEL_SCORE_PAGE_SIZE * 3 ||
        level14Theme.canvas.height <= level14Page4.canvas.height ||
        zeroScoreTheme.summary.played !== 0 || zeroScoreTheme.summary.unplayed !== 1 ||
        zeroScoreTheme.summary.sssPlus !== 0 || zeroScoreTheme.summary.sss !== 0 ||
        zeroScoreTheme.summary.allBreak !== 0 || zeroScoreTheme.summary.fullBell !== 0 ||
        zeroScoreTheme.summary.allBreakFullBell !== 0 || zeroScoreTheme.summary.star5 !== 0 ||
        zeroScoreTheme.charts[0].played !== false || zeroScoreTheme.charts[0].techScore !== null ||
        zeroScoreTheme.charts[0].isAllBreak !== false || zeroScoreTheme.charts[0].isFullBell !== false ||
        zeroScoreTheme.charts[0].platinumScoreStar !== 0 ||
        !level14Theme.charts.some((chart) => chart.platinumScoreStar > 0)) {
      throw new Error("等级成绩筛选、排序或长图尺寸自测失败");
    }
    console.log("SELFTEST OK v" + VERSION);
    process.exit(0);
  }

  const songRecordIdx = args.indexOf("--song-record-job");
  if (songRecordIdx !== -1 && args[songRecordIdx + 1]) {
    try {
      await runSongRecordJob(args[songRecordIdx + 1]);
      process.exit(0);
    } catch (e) {
      console.error("SONG_RECORD_ERROR: " + (e.message || e));
      process.exit(1);
    }
  }

  if (args.includes("--song-job-stdin")) {
    try {
      await runSongDetailJobData(await readJsonFromStdin());
      process.exit(0);
    } catch (e) {
      console.error("SONG_JOB_ERROR: " + (e.message || e));
      process.exit(1);
    }
  }

  if (args.includes("--chart-info-job-stdin")) {
    try {
      await runChartInfoJobData(await readJsonFromStdin());
      process.exit(0);
    } catch (e) {
      console.error("CHART_INFO_JOB_ERROR: " + (e.message || e));
      process.exit(1);
    }
  }

  if (args.includes("--completion-job-stdin")) {
    try {
      await runCompletionJobData(await readJsonFromStdin());
      process.exit(0);
    } catch (e) {
      console.error("COMPLETION_JOB_ERROR: " + (e.message || e));
      process.exit(1);
    }
  }

  if (args.includes("--constant-job-stdin")) {
    try { await runConstantTableJobData(await readJsonFromStdin()); process.exit(0); }
    catch(e) { console.error('CONSTANT_JOB_ERROR: '+e.message); process.exit(1); }
  }
  if (args.includes("--level-job-stdin")) {
    try {
      await runLevelScoreJobData(await readJsonFromStdin());
      process.exit(0);
    } catch (e) {
      console.error("LEVEL_JOB_ERROR: " + (e.message || e));
      process.exit(1);
    }
  }

  // GUI job 模式
  if (args.includes("--verify-job-stdin")) {
    try {
      await runVerifyJobData(await readJsonFromStdin());
      process.exit(0);
    } catch (e) {
      console.error("VERIFY_ERROR: " + (e.message || e));
      process.exit(1);
    }
  }

  if (args.includes("--job-stdin")) {
    try {
      await runJobData(await readJsonFromStdin());
      process.exit(0);
    } catch (e) {
      console.error("JOB_ERROR: " + (e.message || e));
      process.exit(1);
    }
  }

  const jobIdx = args.indexOf("--job");
  if (jobIdx !== -1 && args[jobIdx + 1]) {
    try {
      await runJob(args[jobIdx + 1]);
      process.exit(0);
    } catch (e) {
      console.error("JOB_ERROR: " + (e.message || e));
      process.exit(1);
    }
  }

  const fake = process.env.ONGEKI_FAKE === "1";
  console.log("══════════════════════════════════════");
  console.log("  音击分表生成器 v" + VERSION + (fake ? "（自测模式）" : ""));
  console.log("══════════════════════════════════════");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cfg = loadConfig();

  // ---- 玩家名 / 模式 ----
  if (args.includes("--setup") || !cfg.name || !cfg.mode) {
    if (!fake) {
      const nameAns = await ask(rl, "请输入玩家名（直接回车可稍后用账号名）: ", "");
      if (nameAns) cfg.name = nameAns;
      const modeAns = await ask(rl, "显示模式: 1=Best/New 分表  2=Platinum Score 分表（默认 1）: ", "1");
      cfg.mode = modeAns === "2" ? "pscore" : "bestnew";
      saveConfig(cfg);
    } else {
      cfg.name = cfg.name || "テストプレイヤー";
      cfg.mode = cfg.mode || "bestnew";
    }
  }
  const modeLabel = cfg.mode === "pscore" ? "Platinum Score" : "Best/New";
  console.log(`[配置] 玩家: ${cfg.name || "(未设置)"} | 模式: ${modeLabel}`);

  // ---- 获取数据 ----
  console.log("[1/3] 获取 u.otogame RATING 数据…");
  let jsonText;
  if (fake) {
    jsonText = fakeRatingJson();
    console.log("  （自测模式：使用假数据）");
  } else {
    const got = await getRatingData(cfg);
    jsonText = got.text;
    fs.writeFileSync(RATING_JSON_PATH, jsonText, "utf8");
    const d = got.data;
    console.log(`  ✓ B${d.best_rating_list.length} 曲 / N${d.best_new_rating_list.length} 曲 / P${d.p_score_rating_list.length} 曲`);
    console.log(`  RATING ${(d.rating || 0) / 1000} | 原始数据已存: ${RATING_JSON_PATH}`);
  }

  // ---- 渲染 ----
  console.log("[2/3] 在 reiwa 页面渲染分表图片…");
  const img = await renderOnReiwa(jsonText, cfg.name || "PLAYER", cfg.mode);

  // ---- 保存 ----
  const outName = `音击分表_${timestamp()}.${img.ext}`;
  const outPath = path.join(appDir, outName);
  fs.writeFileSync(outPath, img.buf);
  console.log(`[3/3] ✓ 完成！图片已保存: ${outPath}（${Math.round(img.buf.length / 1024)} KB）`);

  const openAns = await ask(rl, "是否打开所在文件夹？(y/N): ", "n");
  if (openAns === "y" || openAns === "yes") {
    spawn("explorer", ["/select,", outPath], { stdio: "ignore" });
  }
  rl.close();
}

main().catch(async (err) => {
  try {
    execSync("chcp 65001", { stdio: "ignore" });
  } catch {}
  console.error("");
  console.error("✗ 出错: " + err.message);
  console.error(err.stack?.split("\n")[1] || "");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("按回车退出…");
  rl.close();
  process.exit(1);
});
