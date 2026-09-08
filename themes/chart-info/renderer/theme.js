"use strict";

(() => {
  const $ = (id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`新版模板缺少元素：#${id}`);
    return element;
  };
  const MATERIAL = "../../rating-chart/assets/";
  const comma = (value) => Number(value).toLocaleString("en-US");
  const fixed = (value, digits = 2) => value == null ? "-" : Number(value).toFixed(digits);

  function td(text) {
    const node = document.createElement("td");
    node.textContent = text;
    return node;
  }

  function buildScoreRow(item) {
    const row = document.createElement("tr");
    const rankCell = document.createElement("td");
    const rank = document.createElement("img");
    const rankAsset = item.rank.toLowerCase().replace("+", "plus");
    rank.className = "rank-image";
    rank.src = `${MATERIAL}score_tr_${rankAsset}.png`;
    rank.alt = item.rank;
    rankCell.append(rank);
    row.append(
      rankCell,
      td(comma(item.target)),
      td(item.rating),
      td(comma(item.lossBudget)),
      td(`${fixed(item.maxBreak)} 个`),
      td(`${fixed(item.maxHit)} 个`),
      td(`${fixed(item.maxMiss)} 个`),
    );
    return row;
  }

  function buildPlatinumRow(item) {
    const row = document.createElement("tr");
    const starsCell = document.createElement("td");
    const stars = document.createElement("span");
    stars.className = "stars";
    const rainbowTones = ["cyan", "purple", "pink", "orange", "green"];
    for (let index = 0; index < 5; index += 1) {
      const star = document.createElement("img");
      star.src = `${MATERIAL}platinum_score_icon.png`;
      star.alt = index < item.stars ? "白金星" : "未获得白金星";
      star.className = "platinum-star-image";
      if (item.rainbow) star.classList.add(`tone-${rainbowTones[index]}`);
      else if (index >= item.stars) star.classList.add("empty");
      stars.append(star);
    }
    starsCell.append(stars);
    row.append(
      starsCell,
      td(item.range),
      td(comma(item.minimum)),
      td(`${comma(item.lossBudget)} 点`),
      td(`${comma(item.maxMinusOne)} 个`),
      td(`${comma(item.maxMinusTwo)} 个`),
      td(item.rating),
    );
    return row;
  }

  function miniRow(label, value) {
    const row = document.createElement("div");
    row.className = "mini-row";
    const name = document.createElement("span");
    const number = document.createElement("strong");
    name.textContent = label;
    number.textContent = value;
    row.append(name, number);
    return row;
  }

  async function waitForImages() {
    await Promise.all([...document.images].map((image) => new Promise((resolve, reject) => {
      const validate = () => image.naturalWidth > 0 ? resolve() : reject(new Error(`图片内容无效：${image.src}`));
      if (image.complete) validate();
      else {
        image.addEventListener("load", validate, { once: true });
        image.addEventListener("error", () => reject(new Error(`曲绘加载失败：${image.src}`)), { once: true });
      }
    })));
  }

  async function render() {
    const data = window.__THEME_DATA__;
    if (!data) throw new Error("没有找到曲绘侧栏版预览数据");
    const chart = data.chart || {};
    const difficultyColor = chart.color || "#9b63ea";

    $("jacket").src = chart.jacketUrl;
    $("song-title").textContent = chart.title || "-";
    $("artist").textContent = chart.artist || "-";
    const difficultyName = document.getElementById("difficulty-name");
    if (difficultyName) difficultyName.textContent = chart.difficulty || "-";
    $("difficulty-ribbon").textContent = chart.difficulty || "-";
    $("difficulty-ribbon").style.setProperty("--difficulty", difficultyColor);
    const difficultyCard = document.getElementById("difficulty-card");
    if (difficultyCard) difficultyCard.style.setProperty("--difficulty", difficultyColor);
    const chartLevel = document.getElementById("chart-level");
    if (chartLevel) chartLevel.textContent = chart.level ?? "-";
    $("chart-constant").textContent = chart.constant == null ? "-" : Number(chart.constant).toFixed(1);
    $("song-id").textContent = chart.songId ?? "-";
    $("note-count").textContent = comma(chart.noteCount);
    $("bell-count").textContent = comma(chart.bellCount);

    for (const item of data.scoreRows || []) $("score-rows").append(buildScoreRow(item));
    for (const item of data.platinumRows || []) $("platinum-rows").append(buildPlatinumRow(item));
    $("platinum-theory").textContent = comma(data.platinumTheory);

    const units = data.units || {};
    $("unit-rows").append(
      miniRow("单个 BREAK 扣分（-10%）", fixed(units.breakLoss)),
      miniRow("单个 HIT 扣分（-40%）", fixed(units.hitLoss)),
      miniRow("单个 MISS 扣分（-100%）", fixed(units.missLoss)),
      miniRow("单个 BELL 分值", fixed(units.bellValue)),
      miniRow("1 BELL ≈ BREAK", fixed(units.bellToBreak)),
      miniRow("1 BELL ≈ HIT", fixed(units.bellToHit)),
      miniRow("1 BELL ≈ MISS", fixed(units.bellToMiss)),
    );

    await Promise.all([document.fonts.ready, waitForImages()]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__THEME_READY__ = true;
  }

  render().catch((error) => {
    window.__THEME_ERROR__ = error?.message || String(error);
    $("render-error").textContent = window.__THEME_ERROR__;
    $("render-error").style.display = "block";
  });
})();
