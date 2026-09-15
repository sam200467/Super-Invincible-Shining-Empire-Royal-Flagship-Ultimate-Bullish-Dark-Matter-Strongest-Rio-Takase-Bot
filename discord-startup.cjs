"use strict";
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"]);
function transient(error) {
  const status = Number(error?.status ?? error?.statusCode);
  return status >= 500 && status <= 599 || TRANSIENT_CODES.has(error?.code) || TRANSIENT_CODES.has(error?.cause?.code) ||
    error?.name === "AbortError" || error?.message === "Internal Server Error";
}
function detail(error) {
  const status = Number(error?.status ?? error?.statusCode);
  const code = error?.code ?? error?.cause?.code;
  return [status >= 100 && status <= 599 ? "HTTP " + status : "",
    typeof code === "number" || typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? "code " + code : ""].filter(Boolean).join(", ");
}
async function registerCommands(operation, {log, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await operation(); return true; }
    catch (error) {
      const description = detail(error);
      if (!transient(error)) throw new Error("注册 Discord 斜杠指令失败" + (description ? "（" + description + "）" : "") + "：请检查 Bot Token、应用 ID、服务器 ID 和授权。");
      if (attempt === 3) {
        log("斜杠指令注册暂时失败" + (description ? "（" + description + "）" : "") + "；继续连接聊天。已有指令保留，新指令需重启后重新注册。");
        return false;
      }
      log("注册指令遇到临时错误" + (description ? "（" + description + "）" : "") + "，" + (attempt * 2) + " 秒后重试（" + attempt + "/2）");
      await sleep(attempt * 2000);
    }
  }
}
module.exports = {registerCommands, detail};
