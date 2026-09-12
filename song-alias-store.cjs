"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

class SongAliasStore {
  constructor(filePath, normalize) {
    this.filePath = filePath;
    this.normalize = normalize;
    this.entries = [];
    this.bySong = new Map();
  }
  validateAlias(value) {
    const alias = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!alias || alias.length > 80 || /[\p{Cc}\p{Cf}]/u.test(alias)) throw Error("别名需为 1–80 个字符，不能包含控制字符。");
    if (/^(?:id\s*)?\d+$/i.test(alias)) throw Error("别名不能是纯数字或 Song ID，请使用文字昵称。");
    return alias;
  }
  rebuild() {
    this.bySong = new Map();
    for (const entry of this.entries) {
      if (!this.bySong.has(entry.songId)) this.bySong.set(entry.songId, []);
      this.bySong.get(entry.songId).push({ ...entry, key: this.normalize(entry.alias) });
    }
  }
  load() {
    let text;
    try { text = fs.readFileSync(this.filePath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    try {
      const data = JSON.parse(text);
      if (data.version !== 1 || !Array.isArray(data.entries)) throw Error("格式错误");
      const seen = new Set();
      for (const entry of data.entries) {
        if (!Number.isSafeInteger(entry.songId) || entry.songId < 0 || typeof entry.alias !== "string" || this.validateAlias(entry.alias) !== entry.alias) throw Error("记录格式错误");
        const key = entry.songId + ":" + this.normalize(entry.alias);
        if (seen.has(key)) throw Error("重复记录");
        seen.add(key);
      }
      this.entries = data.entries;
      this.rebuild();
    } catch (error) {
      throw Error("歌曲别名文件读取失败，请检查或恢复备份（原文件未修改）：" + error.message);
    }
  }
  list(songId) { return (this.bySong.get(Number(songId)) || []).map(entry => entry.alias); }
  matches(songId, needle, exact = false) {
    return (this.bySong.get(Number(songId)) || []).some(entry => exact ? entry.key === needle : entry.key.includes(needle));
  }
  add(songId, value, userId) {
    if (!Number.isSafeInteger(songId) || songId < 0) throw Error("无效 Song ID。");
    const alias = this.validateAlias(value);
    if (this.matches(songId, this.normalize(alias), true)) return { added: false, alias };
    const next = [...this.entries, { songId, alias, addedBy: String(userId), addedAt: new Date().toISOString() }];
    this.save(next);
    return { added: true, alias };
  }
  remove(songId, value) {
    const alias = this.validateAlias(value);
    const key = this.normalize(alias);
    const next = this.entries.filter(entry => entry.songId !== Number(songId) || this.normalize(entry.alias) !== key);
    if (next.length === this.entries.length) return { removed: false, alias };
    this.save(next);
    return { removed: true, alias };
  }
  save(next) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: next }, null, 2) + "\n", { flag: "wx" });
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
    this.entries = next;
    this.rebuild();
  }
}
module.exports = { SongAliasStore };
