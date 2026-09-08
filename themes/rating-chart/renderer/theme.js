"use strict";

(() => {
  const PIC = "../assets/";
  const DIFFICULTIES = {
    0: { name: "basic", chartKey: "BASIC" },
    1: { name: "advanced", chartKey: "ADVANCED" },
    2: { name: "expert", chartKey: "EXPERT" },
    3: { name: "master", chartKey: "MASTER" },
    10: { name: "lunatic", chartKey: "LUNATIC" },
  };

  const $ = (id) => document.getElementById(id);
  const fmt3 = (raw) => (Number(raw || 0) / 1000).toFixed(3);
  const comma = (value) => Number(value || 0).toLocaleString("en-US");
  const two = (value) => String(value).padStart(2, "0");

  function rankName(score) {
    const s = Number(score || 0);
    if (s >= 1007500) return "sssplus";
    if (s >= 1000000) return "sss";
    if (s >= 990000) return "ss";
    if (s >= 970000) return "s";
    if (s >= 940000) return "aaa";
    if (s >= 900000) return "aa";
    if (s >= 850000) return "a";
    if (s >= 800000) return "bbb";
    if (s >= 750000) return "bb";
    if (s >= 700000) return "b";
    if (s >= 500000) return "c";
    return "d";
  }

  function difficultyInfo(item) {
    return DIFFICULTIES[Number(item.difficulty_id)] || DIFFICULTIES[3];
  }

  function image(src, className, alt = "") {
    const el = document.createElement("img");
    el.src = src;
    el.className = className;
    el.alt = alt;
    el.dataset.loadLabel = alt || "图片资源";
    el.decoding = "sync";
    return el;
  }

  function div(className, text = "") {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    return el;
  }

  function normalCard(item, index) {
    const d = difficultyInfo(item);
    const card = div("score-card normal-card");
    card.append(image(`${PIC}${d.name}_plate.png`, "card-plate"));
    card.append(image(item.jacketUrl, "jacket", `${item.title} 曲绘`));
    card.append(div("rank-number", `#${index + 1}`));
    card.append(image(`${PIC}diff_${d.name}_59x15.png`, "difficulty", d.chartKey));
    card.append(div("title", item.title));
    card.append(div("score", comma(item.score)));
    card.append(div("rating-detail", `${item.constant.toFixed(1)}→${fmt3(item.rating)}`));
    card.append(image(`${PIC}score_tr_${rankName(item.score)}.png`, "rank-icon", rankName(item.score)));

    const status = div("status-icons");
    // AB 本身已经包含 FC，因此只显示 AB；FB 是独立状态，可与 AB/FC 并列。
    if (item.isAllBreak) status.append(image(`${PIC}score_detail_ab.png`, "", "AB"));
    else if (item.isFullCombo) status.append(image(`${PIC}score_detail_fc.png`, "", "FC"));
    if (item.isFullBell) status.append(image(`${PIC}score_detail_fb.png`, "", "FB"));
    card.append(status);
    return card;
  }

  function platinumCard(item, index) {
    const d = difficultyInfo(item);
    const card = div("score-card platinum-card");
    card.append(image(`${PIC}${d.name}_plate_platinum.png`, "card-plate"));
    card.append(image(item.jacketUrl, "jacket", `${item.title} 曲绘`));
    card.append(div("rank-number", `#${index + 1}`));
    card.append(image(`${PIC}diff_${d.name}_59x15.png`, "difficulty", d.chartKey));

    const star = div("platinum-star");
    star.append(image(`${PIC}platinum_score_icon.png`, "", "白金星"));
    star.append(document.createTextNode(String(item.platinumScoreStar || 0)));
    card.append(star);

    card.append(div("platinum-values", `${comma(item.platinumScoreMax)} / ${comma(item.platinumScoreTheory)}`));
    card.append(div("rating-detail", `${item.constant.toFixed(1)}→${fmt3(item.rating)}`));
    card.append(div("title", item.title));
    return card;
  }

  function renderGrid(id, items, cardFactory, limit) {
    const grid = $(id);
    items.slice(0, limit).forEach((item, i) => grid.append(cardFactory(item, i)));
  }

  function fitPlayerName() {
    const el = $("player-name");
    el.style.removeProperty("font-size");
    let size = Number.parseFloat(getComputedStyle(el).fontSize);
    if (!Number.isFinite(size) || size <= 0) return;
    const floor = Math.min(size, 36);
    while (el.scrollWidth > el.clientWidth && size > floor) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  }

  function layoutPlayerIdentity() {
    const level = $("level");
    const playerName = $("player-name");
    if (!level || !playerName) return;

    // 两至四位等级共用同一垂直中心；等级变长时，按实际宽度为 ID 腾出空间。
    const configured = getComputedStyle(playerName);
    const fixedNameLeft = Number.parseFloat(configured.left) || 610;
    const configuredWidth = Number.parseFloat(configured.maxWidth) || Number.parseFloat(configured.width) || 372;
    const nameRight = fixedNameLeft + configuredWidth;
    const safeNameLeft = Math.ceil(level.getBoundingClientRect().right) + 28;
    const nameLeft = Math.max(fixedNameLeft, safeNameLeft);
    playerName.style.left = `${nameLeft}px`;
    playerName.style.width = `${Math.max(240, nameRight - nameLeft)}px`;
    playerName.style.maxWidth = "none";
    fitPlayerName();
  }

  function fitSingleLineText(el, minimumSize) {
    if (!el) return;
    el.style.removeProperty("font-size");
    let size = Number.parseFloat(getComputedStyle(el).fontSize);
    if (!Number.isFinite(size) || size <= 0) return;
    const floor = Math.min(size, minimumSize);
    while (el.scrollWidth > el.clientWidth && size > floor) {
      size -= 0.5;
      el.style.fontSize = `${size}px`;
    }
  }

  function fitPlatinumCardText() {
    document.querySelectorAll(".platinum-card").forEach((card) => {
      fitSingleLineText(card.querySelector(".platinum-values"), 14);
      fitSingleLineText(card.querySelector(".rating-detail"), 13);
      fitSingleLineText(card.querySelector(".title"), 10);
    });
  }

  function layoutRatingSeparator() {
    // const separator = document.querySelector(".rating-separator");
    // const n10Number = $("n10-average").querySelector(".average-number");
    // const rating = $("rating");
    // if (!separator || !n10Number || !rating) return;

    // // N10 的原始平均值位数会因玩家而异。根据实际文字宽度留出间隔，
    // // 同时固定破折号组的右边界，避免向右挤到总 Rating 大字。
    // const configuredLeft = Number.parseFloat(getComputedStyle(separator).left) || 1370;
    // const safeLeft = Math.ceil(n10Number.getBoundingClientRect().right) + 8;
    // const right = Math.floor(rating.getBoundingClientRect().left) - 18;
    // const left = Math.max(configuredLeft, Math.min(safeLeft, right - 248));
    // separator.style.left = `${left}px`;
    // separator.style.width = `${right - left}px`;
  }

  function refreshThemeLayout() {
    layoutPlayerIdentity();
    fitPlatinumCardText();
    layoutRatingSeparator();
  }

  // CSS 实时调试器保存或临时应用样式后调用，重新计算依赖实际文字宽度的布局。
  window.__FIT_RATING_THEME__ = refreshThemeLayout;

  async function waitForImages() {
    const images = [...document.images];
    await Promise.all(images.map((img) => new Promise((resolve, reject) => {
      const ok = () => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) resolve();
        else reject(new Error(`${img.dataset.loadLabel || "图片资源"}内容无效：${img.src}`));
      };
      const fail = () => reject(new Error(`${img.dataset.loadLabel || "图片资源"}加载失败：${img.src}`));
      if (img.complete) ok();
      else {
        img.addEventListener("load", ok, { once: true });
        img.addEventListener("error", fail, { once: true });
      }
    })));
  }

  async function render() {
    const data = window.__THEME_DATA__;
    if (!data) throw new Error("没有找到渲染数据 preview-data.js");

    $("avatar").src = data.profile.avatarUrl;
    const levelText = `Lv.${data.profile.level}`;
    $("level").textContent = levelText;
    $("level").dataset.text = levelText;
    $("player-name").textContent = data.profile.playerName;
    $("player-name").dataset.text = data.profile.playerName;

    $("b50-average").innerHTML = `<span class="average-label">b50</span><span class="average-number">${fmt3(data.summary.bestRating)}</span>`;
    $("n10-average").innerHTML = `<span class="average-label">n10</span><span class="average-number">${fmt3(data.summary.bestNewRating * 5)}→${fmt3(data.summary.bestNewRating)}</span>`;
    $("p50-average").innerHTML = `<span class="average-label">p50</span><span class="average-number">${fmt3(data.summary.pScoreRating)}</span>`;
    const rating = fmt3(data.summary.rating);
    $("rating").textContent = rating;
    $("rating").dataset.text = rating;

    const generated = new Date(data.generatedAt);
    $("generation-time").innerHTML = `Generation time:<span>${generated.getFullYear()}.${generated.getMonth() + 1}.${generated.getDate()} ${two(generated.getHours())}:${two(generated.getMinutes())}</span>`;
    
    const generatorName = $("generator-name");

generatorName.textContent = "Generated by:";

const botName = document.createElement("span");
botName.textContent = "Takase bot";

generatorName.append(botName);

$("play-count").textContent =
  `Total plays count: ${comma(data.profile.playCount)}`;


/* 总游玩次数 */
$("play-count").textContent =
  `Total plays count: ${comma(data.profile.playCount)}`;


/* 最后游玩时间 */
const lastPlay = $("last-play");

lastPlay.textContent = "Last play time:";

const value = document.createElement("div");
value.className = "last-play-value";

/* 假设原始格式：
   2026-01-01 12:00:00
*/
const parts = String(data.profile.lastPlayTime || "")
  .trim()
  .split(/\s+/);

const date = document.createElement("span");
date.textContent = parts[0] || "";

const time = document.createElement("span");
time.textContent = parts[1] || "";

value.append(date, time);
lastPlay.append(value);

    renderGrid("best-grid", data.best, normalCard, 50);
    renderGrid("new-grid", data.new, normalCard, 10);
    renderGrid("platinum-grid", data.platinum, platinumCard, 50);

    await document.fonts.ready;
    refreshThemeLayout();
    await waitForImages();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__THEME_READY__ = true;
  }

  render().catch((error) => {
    window.__THEME_ERROR__ = error?.message || String(error);
    const el = $("render-error");
    el.textContent = window.__THEME_ERROR__;
    el.style.display = "block";
  });
})();
