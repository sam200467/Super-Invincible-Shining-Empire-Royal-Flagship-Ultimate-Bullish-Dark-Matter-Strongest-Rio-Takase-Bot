"use strict";
// 停止 QQ Bot。
//
// 只结束命令行里带 takase-qq-bundle 的 node 进程 —— 绝不能用 taskkill /IM node.exe，
// 那会把机器上所有 node 进程（编辑器插件、别的开发工具）一起干掉。
//
// 用 PowerShell 而不是 wmic：wmic 已被微软弃用，Windows 11 较新版本上直接没有这个命令。

const { execFileSync } = require("node:child_process");

const POWERSHELL = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  $targets = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
  "    Where-Object { $_.CommandLine -like '*takase-qq-bundle*' }",
  "  if (-not $targets) { Write-Output 'NOT_RUNNING'; exit 0 }",
  "  foreach ($p in $targets) {",
  "    Write-Output ('KILLED ' + $p.ProcessId)",
  "    Stop-Process -Id $p.ProcessId -Force",
  "  }",
  "} catch { Write-Output ('ERROR ' + $_.Exception.Message); exit 1 }",
].join("\n");

let output;
try {
  output = execFileSync("powershell", ["-NoProfile", "-Command", POWERSHELL], { encoding: "utf8" }).trim();
} catch (error) {
  console.error("停止失败：" + (error.message || error));
  process.exitCode = 1;
  return;
}

if (output.includes("NOT_RUNNING")) {
  console.log("QQ Bot 当前没有在运行。");
} else {
  for (const line of output.split("\n")) {
    const killed = line.trim().match(/^KILLED (\d+)$/);
    if (killed) console.log("已停止进程 " + killed[1]);
  }
  console.log("QQ Bot 已停止。");
}
