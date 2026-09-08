"use strict";

(() => {
  const ASSET = "../assets/";
  const DIFFICULTIES = {
    0: { key: "basic", label: "BASIC" },
    1: { key: "advanced", label: "ADVANCED" },
    2: { key: "expert", label: "EXPERT" },
    3: { key: "master", label: "MASTER" },
    10: { key: "lunatic", label: "LUNATIC" },
  };

  const $ = (id) => document.getElementById(id);
  const comma = (value) => Number(value || 0).toLocaleString("en-US");

  function div(className, text) {
    const element = document.createElement("div");
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function image(src, className, alt) {
    const element = document.createElement("img");
    element.src = src;
    element.className = className || "";
    element.alt = alt || "";
    element.decoding = "sync";
    return element;
  }

  function rankName(score) {
    const value = Number(score || 0);
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

  function rankAssetName(score) {
    return rankName(score).toLowerCase().replace("+", "plus");
  }

  function chartCard(chart, index) {
    const difficulty = DIFFICULTIES[Number(chart.difficultyId)] || DIFFICULTIES[3];
    const card = div(`chart-card difficulty-${difficulty.key}${chart.played ? "" : " unplayed"}`);
    card.title = `${chart.title} / ${difficulty.label} ${chart.level}`;
    card.append(div("position", chart.played ? `#${String(chart.listPosition || index + 1).padStart(3, "0")}` : "—"));
    card.append(image(chart.jacketUrl, "jacket", `${chart.title} 曲绘`));
    card.append(image(`${ASSET}diff_${difficulty.key}_59x15.png`, "difficulty", difficulty.label));
    if (chart.played) {
      card.append(image(`${ASSET}score_tr_${rankAssetName(chart.techScore)}.png`, "technical-rank", rankName(chart.techScore)));
    }
    if (Number(chart.platinumScoreStar) > 0) {
      const star = Math.floor(Number(chart.platinumScoreStar));
      const starBadge = div("platinum-star");
      starBadge.append(
        image(`${ASSET}platinum_score_icon.png`, "platinum-star-icon", "白金星"),
        div("platinum-star-value", star === 6 ? "5+" : String(star)),
      );
      card.append(starBadge);
    }

    const score = div("score", chart.played ? comma(chart.techScore) : "NOT PLAYED");
    if (chart.played && Number(chart.techScore) >= 1007500) score.classList.add("theory-score");
    const scoreRow = div("score-row");
    scoreRow.append(
      div("constant", Number.isFinite(Number(chart.constant)) ? Number(chart.constant).toFixed(1) : "-"),
      score,
    );
    card.append(scoreRow);
    card.append(div("title", chart.title));

    if (chart.isAllBreak) card.append(image(`${ASSET}score_detail_ab.png`, "achievement achievement-primary", "AB"));
    else if (chart.isFullCombo) card.append(image(`${ASSET}score_detail_fc.png`, "achievement achievement-primary", "FC"));
    if (chart.isFullBell) card.append(image(`${ASSET}score_detail_fb.png`, "achievement achievement-full-bell", "FB"));
    return card;
  }

  function summaryCard(label, value, extraClass, starLevel) {
    const card = div(`summary-card ${extraClass || ""}`.trim());
    card.append(div("summary-value", String(value)));
    const labelElement = div("summary-label");
    if (starLevel) {
      labelElement.append(
        image(`${ASSET}platinum_score_icon.png`, "summary-star-icon", "白金星"),
        document.createTextNode(String(starLevel)),
      );
    } else {
      labelElement.textContent = label;
    }
    card.append(labelElement);
    return card;
  }

  async function waitForImages() {
    await Promise.all([...document.images].map((element) => {
      if (element.complete) return Promise.resolve();
      return new Promise((resolve) => {
        element.addEventListener("load", resolve, { once: true });
        element.addEventListener("error", resolve, { once: true });
      });
    }));
  }

  function fitSingleLine(element, minimumSize) {
    let size = Number.parseFloat(getComputedStyle(element).fontSize);
    while (element.scrollWidth > element.clientWidth && size > minimumSize) {
      size -= 0.5;
      element.style.fontSize = `${size}px`;
    }
  }

  function showError(error) {
    const message = error?.message || String(error);
    $("render-error").textContent = `渲染失败：${message}`;
    $("render-error").classList.add("visible");
    window.__THEME_ERROR__ = message;
  }

  async function render() {
    const data = window.__THEME_DATA__;
    if (!data || !Array.isArray(data.charts)) throw new Error("缺少等级谱面数据");
    const canvasHeight = Math.max(1080, Number(data?.canvas?.height) || 1080);
    document.documentElement.style.height = `${canvasHeight}px`;
    document.body.style.height = `${canvasHeight}px`;
    $("level-sheet").style.height = `${canvasHeight}px`;

    const targetLevel = $("target-level");
    targetLevel.textContent = data.targetLevel;
    targetLevel.classList.toggle("constant-query", data.queryMode === "constant");
    targetLevel.classList.toggle("abfb-query", data.queryMode === "abfb");
    $("page-title").textContent = data.pageTitle || `Lv.${data.targetLevel} 全谱面成绩`;
    $("page-number").textContent = `PAGE ${data?.pagination?.page || 1} / ${data?.pagination?.totalPages || 1}`;
    $("avatar").src = data?.profile?.avatarUrl || "";
    $("player-name").textContent = data?.profile?.playerName || "PLAYER";
    $("player-level").textContent = `Lv.${Math.max(0, Math.floor(Number(data?.profile?.level) || 0))}`;

    const summary = data.summary || {};
    $("summary").append(
      summaryCard("ALL", summary.total ?? data.charts.length, "total"),
      summaryCard("SSS+", summary.sssPlus || 0, "sss-plus"),
      summaryCard("SSS", summary.sss || 0, "sss"),
      summaryCard("AB", summary.allBreak || 0, "all-break"),
      summaryCard("FB", summary.fullBell || 0, "full-bell"),
      summaryCard("ABFB", summary.allBreakFullBell || 0, "all-break-full-bell"),
      summaryCard("", summary.star5 || 0, "star star-5", 5),
      summaryCard("", summary.star4 || 0, "star star-4", 4),
      summaryCard("", summary.star3 || 0, "star star-3", 3),
      summaryCard("", summary.star2 || 0, "star star-2", 2),
      summaryCard("", summary.star1 || 0, "star star-1", 1),
    );

    const grid = $("chart-grid");
    data.charts.forEach((chart, index) => grid.append(chartCard(chart, index)));
    await document.fonts.ready;
    await waitForImages();
    fitSingleLine(targetLevel, 28);
    fitSingleLine($("player-name"), 28);
    document.querySelectorAll(".chart-card .title").forEach((element) => fitSingleLine(element, 10));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__THEME_READY__ = true;
  }

  render().catch(showError);
})();
