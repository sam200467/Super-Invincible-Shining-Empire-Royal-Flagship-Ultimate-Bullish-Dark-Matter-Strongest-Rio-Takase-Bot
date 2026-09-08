"use strict";

(() => {
  const PIC = "../assets/";
  const COLUMNS = 10;
  const GROUPS_BOTTOM = 1608;
  const SUMMARY_ORDER = ["basic", "advanced", "expert", "master"];
  const SUMMARY_ASSETS = {
    basic: "diff_basic_59x15.png",
    advanced: "diff_advanced_59x15.png",
    expert: "diff_expert_59x15.png",
    master: "diff_master_59x15.png",
  };

  const $ = (id) => document.getElementById(id);

  function image(src, className, alt) {
    const element = document.createElement("img");
    element.src = src;
    element.className = className || "";
    element.alt = alt || "";
    element.decoding = "sync";
    return element;
  }

  function div(className, text) {
    const element = document.createElement("div");
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function levelRank(raw) {
    const match = String(raw ?? "").trim().match(/^(\d+)(\+)?$/);
    if (!match) return null;
    return Number(match[1]) * 2 + (match[2] ? 1 : 0);
  }

  function rankLabel(rank) {
    const base = Math.floor(rank / 2);
    return String(base) + (rank % 2 ? "+" : "");
  }

  function normalizeSong(song, index) {
    const masterLevel = String(song?.masterLevel ?? song?.level ?? "").trim();
    const rank = levelRank(masterLevel);
    if (rank === null) return null;
    return {
      songId: song?.songId ?? song?.id ?? index + 1,
      title: String(song?.title || song?.name || `曲目 ${index + 1}`),
      jacketUrl: String(song?.jacketUrl || ""),
      masterLevel,
      rank,
      masterConstant: Number(song?.masterConstant ?? song?.constant ?? 0),
      isAllBreak: song?.isAllBreak === true,
      isFullCombo: song?.isFullCombo === true,
      isFullBell: song?.isFullBell === true,
    };
  }

  function groupRange(data, songs) {
    const songRanks = songs.map((song) => song.rank);
    const configuredMax = levelRank(data?.levelRange?.max);
    const configuredMin = levelRank(data?.levelRange?.min);
    const max = configuredMax ?? (songRanks.length ? Math.max(...songRanks) : 30);
    const min = configuredMin ?? (songRanks.length ? Math.min(...songRanks) : max);
    const high = Math.max(max, min);
    const low = Math.min(max, min);
    return Array.from({ length: high - low + 1 }, (_, index) => high - index);
  }

  function songTile(song) {
    const tile = div("song-tile");
    tile.title = `${song.title}（MASTER ${song.masterLevel}）`;
    const jacket = image(song.jacketUrl, "song-jacket", `${song.title} 曲绘`);
    jacket.addEventListener("error", () => jacket.classList.add("image-load-failed"), { once: true });
    tile.append(jacket);

    const badges = div("status-badges");
    // AB 已包含 FC：两者只显示优先级更高的一个；FB 与它们独立。
    if (song.isAllBreak) badges.append(image(`${PIC}score_detail_ab.png`, "status-badge-primary", "ALL BREAK"));
    else if (song.isFullCombo) badges.append(image(`${PIC}score_detail_fc.png`, "status-badge-primary", "FULL COMBO"));
    if (song.isFullBell) badges.append(image(`${PIC}score_detail_fb.png`, "status-badge-full-bell", "FULL BELL"));
    if (badges.childElementCount) tile.append(badges);
    return tile;
  }

  function renderGroups(data, songs) {
    const container = $("level-groups");
    const byRank = new Map();
    for (const song of songs) {
      if (!byRank.has(song.rank)) byRank.set(song.rank, []);
      byRank.get(song.rank).push(song);
    }
    for (const rows of byRank.values()) {
      rows.sort((left, right) =>
        right.masterConstant - left.masterConstant ||
        String(left.songId).localeCompare(String(right.songId), "ja") ||
        left.title.localeCompare(right.title, "ja")
      );
    }

    for (const rank of groupRange(data, songs)) {
      const group = div("level-group");
      group.dataset.level = rankLabel(rank);

      const levelTile = div("level-tile");
      levelTile.append(image(`${PIC}level.png`, "", ""));
      levelTile.append(div("level-value", rankLabel(rank)));
      group.append(levelTile);

      const grid = div("song-grid");
      for (const song of byRank.get(rank) || []) grid.append(songTile(song));
      group.append(grid);
      container.append(group);
    }
  }

  function integer(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  }

  function renderSummary(summary) {
    const container = $("difficulty-summary");
    for (const key of SUMMARY_ORDER) {
      const values = summary?.[key] || {};
      const total = integer(values.total);
      const card = div(`summary-card summary-${key}`);
      card.append(image(`${PIC}${SUMMARY_ASSETS[key]}`, "summary-difficulty", key.toUpperCase()));
      const lines = div("summary-values");
      const ab = div("summary-line");
      ab.innerHTML = `<span class="summary-label">AB:</span> ${integer(values.allBreak)}/${total}`;
      const fb = div("summary-line");
      fb.innerHTML = `<span class="summary-label">FB:</span> ${integer(values.fullBell)}/${total}`;
      lines.append(ab, fb);
      card.append(lines);
      container.append(card);
    }
  }

  function fitSingleLine(element, minimumSize) {
    if (!element) return;
    element.style.removeProperty("font-size");
    let size = Number.parseFloat(getComputedStyle(element).fontSize);
    if (!Number.isFinite(size)) return;
    while (element.scrollWidth > element.clientWidth && size > minimumSize) {
      size -= 0.5;
      element.style.fontSize = `${size}px`;
    }
  }

  function fitCompletionLayout() {
    const groups = $("level-groups");
    groups.style.removeProperty("--completion-compact");
    fitSingleLine($("player-name"), 25);

    const top = Number.parseFloat(getComputedStyle(groups).top) || 213;
    const available = GROUPS_BOTTOM - top;
    let compact = 1;
    while (groups.scrollHeight > available && compact > 0.7) {
      compact = Math.max(0.7, compact - 0.01);
      groups.style.setProperty("--completion-compact", compact.toFixed(2));
    }
    groups.dataset.verticalScale = compact.toFixed(2);
  }

  window.__FIT_COMPLETION_THEME__ = fitCompletionLayout;

  async function waitForImages() {
    const images = [...document.images];
    await Promise.all(images.map((element) => {
      if (element.complete) return Promise.resolve();
      return new Promise((resolve) => {
        element.addEventListener("load", resolve, { once: true });
        element.addEventListener("error", resolve, { once: true });
      });
    }));
  }

  function showError(error) {
    const message = error?.message || String(error);
    const target = $("render-error");
    target.textContent = `渲染失败：${message}`;
    target.classList.add("visible");
    window.__THEME_ERROR__ = message;
  }

  async function render() {
    const data = window.__THEME_DATA__;
    if (!data || typeof data !== "object") throw new Error("缺少 window.__THEME_DATA__");
    const songs = (Array.isArray(data.songs) ? data.songs : [])
      .map(normalizeSong)
      .filter(Boolean);

    const plateUrl = data?.plate?.layoutUrl || `${PIC}ui_userplate_040100.png`;
    $("plate-frame").src = plateUrl;
    $("avatar").src = data?.profile?.avatarUrl || "";
    const levelText = `Lv.${integer(data?.profile?.level)}`;
    $("player-level").textContent = levelText;
    $("player-level").dataset.text = levelText;
    const playerName = String(data?.profile?.playerName || "PLAYER");
    $("player-name").textContent = playerName;
    $("player-name").dataset.text = playerName;

    renderGroups(data, songs);
    renderSummary(data.summary || {});
    await document.fonts.ready;
    await waitForImages();
    fitCompletionLayout();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__THEME_READY__ = true;
  }

  render().catch(showError);
})();
