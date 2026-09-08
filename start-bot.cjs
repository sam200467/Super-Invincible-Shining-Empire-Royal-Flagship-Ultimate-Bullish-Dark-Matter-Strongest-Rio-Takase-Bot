"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
function makeConfig(env, root = __dirname) {
  const required = ['DISCORD_APPLICATION_ID', 'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_IDS'];
  for (const key of required) if (!String(env[key] || '').trim()) throw new Error('Missing configuration: ' + key);
  const channelIds = env.DISCORD_CHANNEL_IDS.split(/[\s,]+/).filter(Boolean);
  for (const value of [env.DISCORD_APPLICATION_ID, env.DISCORD_GUILD_ID, ...channelIds]) {
    if (!/^\d{17,20}$/.test(value)) throw new Error('Discord IDs must contain 17-20 digits.');
  }
  const proxyUrl = (env.DISCORD_PROXY_URL || '').trim();
  if (proxyUrl && !/^https?:\/\/[^\s]+$/i.test(proxyUrl)) throw new Error('Proxy URL must use http:// or https://');
  const workDir = path.resolve(root, env.TAKASE_DATA_DIR || 'data');
  return {
    applicationId: env.DISCORD_APPLICATION_ID, botToken: env.DISCORD_BOT_TOKEN,
    guildId: env.DISCORD_GUILD_ID, channelIds, proxyUrl, workDir,
    outputDir: path.join(workDir, 'output'), corePath: path.join(root, 'ongeki-core.exe'),
    vaultPath: path.join(workDir, 'bindings.dat'), vaultHelperPath: path.join(root, 'takase-discord-vault.exe'),
  };
}
function main() {
  if (process.platform !== 'win32') throw new Error('This distribution requires Windows (DPAPI and rendering core).');
  const config = makeConfig(process.env);
  const service = path.join(__dirname, 'takase-discord-core.exe');
  for (const file of [service, config.corePath, config.vaultHelperPath]) if (!fs.existsSync(file)) throw new Error('Run npm run build first. Missing: ' + path.basename(file));
  fs.mkdirSync(config.outputDir, { recursive: true });
  const child = spawn(service, [], { cwd: __dirname, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', () => { console.error('Unable to start Discord service.'); process.exitCode = 1; });
  child.stdin.on('error', () => { console.error('Unable to pass configuration to Discord service.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code === null ? 1 : code; });
  child.stdin.end(JSON.stringify(config));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}
module.exports = { makeConfig };
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
