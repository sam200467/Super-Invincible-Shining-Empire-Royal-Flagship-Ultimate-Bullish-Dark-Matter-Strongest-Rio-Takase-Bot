(function () {
  "use strict";

  const DB_URL = "https://reiwa.f5.si/ongeki_record.json";
  const DIFF_MAP = {
    0: "BAS",
    1: "ADV",
    2: "EXP",
    3: "MAS",
    10: "LUN",
  };

  function assertReiwaPage() {
    const required = [
      "initializeArea",
      "renderProfileArea",
      "renderSongsArea",
      "renderImage",
    ];
    const missing = required.filter((name) => typeof window[name] !== "function");
    if (missing.length) {
      throw new Error(`请在 https://reiwa.f5.si/newbestimg/ongeki/ 页面运行。缺少函数: ${missing.join(", ")}`);
    }
  }

  function normalizeResponse(input) {
    const raw = input && input.data && input.data.best_rating_list ? input.data : input;
    if (!raw || !Array.isArray(raw.best_rating_list)) {
      throw new Error("JSON 不是 u.otogame.net/api/game/ongeki/rating 的响应。");
    }
    return raw;
  }

  function normalizeText(text) {
    return String(text || "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  async function loadDb() {
    const response = await fetch(DB_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`谱面 DB 获取失败: HTTP ${response.status}`);
    const text = await response.text();
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  }

  function findRecord(item, db) {
    const title = normalizeText(item.music?.name);
    const artist = normalizeText(item.music?.artist);
    const diff = DIFF_MAP[item.difficulty_id] || "MAS";
    const sameTitleDiff = db.filter((record) => {
      return normalizeText(record.title) === title && String(record.diff).toUpperCase() === diff;
    });
    if (!sameTitleDiff.length) return null;
    if (artist) {
      const exact = sameTitleDiff.find((record) => normalizeText(record.artist) === artist);
      if (exact) return exact;
      const loose = sameTitleDiff.find((record) => {
        const dbArtist = normalizeText(record.artist);
        return dbArtist.includes(artist) || artist.includes(dbArtist);
      });
      if (loose) return loose;
    }
    return sameTitleDiff[0];
  }

  function rankFromScore(value) {
    const score = Number(value || 0);
    if (score < 500000) return "D";
    if (score < 700000) return "C";
    if (score < 750000) return "B";
    if (score < 800000) return "BB";
    if (score < 850000) return "BBB";
    if (score < 900000) return "A";
    if (score < 940000) return "AA";
    if (score < 970000) return "AAA";
    if (score < 990000) return "S";
    if (score < 1000000) return "SS";
    if (score < 1007500) return "SSS";
    if (score <= 1010000) return "SSS+";
    return "SSS+";
  }

  function toRating(value) {
    return Number(value || 0) / 1000;
  }

  function convertSong(item, db, isPscore) {
    const record = findRecord(item, db);
    if (!record) {
      const diff = DIFF_MAP[item.difficulty_id] || "MAS";
      console.warn(`谱面 DB 未匹配: ${item.music?.name || "(unknown)"} / ${item.music?.artist || ""} / ${diff}`);
    }

    const title = record?.title || item.music?.name || "";
    const artist = record?.artist || item.music?.artist || "";
    const diff = record?.diff || DIFF_MAP[item.difficulty_id] || "MAS";
    const score = Number(item.score || 0);
    const song = {
      title,
      artist,
      diff,
      level: record?.level ?? item.music?.level_info?.level ?? 0,
      const: Number(record?.const ?? item.music?.level_info?.level ?? 0),
      is_unknown: Boolean(record?.is_unknown),
      score,
      rank: rankFromScore(score),
      update: "1970-01-01",
      lamps: {
        is_fullcombo: Boolean(item.is_full_combo || item.is_all_break),
        is_allbreak: Boolean(item.is_all_break),
        is_fullbell: Boolean(item.is_full_bell),
      },
      rating: toRating(item.rating),
      p_score: Number(item.platinum_score_max || item.platinum_score_theory || 0),
      p_star: Number(item.platinum_score_star || 0),
      p_rating: toRating(item.rating),
    };

    if (!isPscore) {
      song.p_rating = 0;
    }
    return song;
  }

  function buildPlayerData(raw, db, playerName) {
    const best = (raw.best_rating_list || []).map((item) => convertSong(item, db, false));
    const newest = (raw.best_new_rating_list || []).map((item) => convertSong(item, db, false));
    const pscore = (raw.p_score_rating_list || []).map((item) => convertSong(item, db, true));
    return {
      profile: {
        name: playerName || "PLAYER",
        rating: toRating(raw.rating),
        best_avg: toRating(raw.best_rating),
        new_avg: toRating(raw.best_new_rating),
        pscore_avg: toRating(raw.p_score_rating),
      },
      rating: {
        best,
        new: newest,
        pscore,
      },
      record: [...best, ...newest, ...pscore],
    };
  }

  function setValue(selector, value) {
    const node = document.querySelector(selector);
    if (node) node.value = value;
  }

  function setChecked(selector, value) {
    const node = document.querySelector(selector);
    if (node) node.checked = value;
  }

  function toISOStringWithTimezone(date) {
    const pad = (value) => String(value).padStart(2, "0");
    const tz = -date.getTimezoneOffset();
    const sign = tz >= 0 ? "+" : "-";
    const abs = Math.abs(tz);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }

  function renderWithReiwa(playerData, mode) {
    initializeArea();
    if (typeof removeButtons === "function") removeButtons();

    setValue("#display-content", mode);
    setChecked("#showprev", false);
    setChecked("#nofb", false);
    setChecked("#shownewemb", false);
    setChecked("#copyrightmode", false);

    const isPscore = mode === "pscore";
    const title = document.querySelector("#img-title");
    if (title) title.textContent = isPscore ? "プラチナスコア枠対象楽曲" : "ベスト枠・新曲枠対象楽曲";

    const logo = document.querySelector("#img-logoimg");
    const headerText = document.querySelector("#img-header-text");
    if (logo) logo.style.display = "block";
    if (headerText) headerText.style.marginLeft = "20px";

    const nowText = toISOStringWithTimezone(new Date()).replaceAll("-", "/").replaceAll("T", " ").substring(0, 19);
    const dt = document.querySelector("#v-generate-dt");
    if (dt) dt.textContent = nowText;

    renderProfileArea(playerData.profile);

    const newestDate = new Date("1970-01-01");
    if (isPscore) {
      renderSongsArea(document.querySelector("#img-pscore-songs"), playerData.rating.pscore, newestDate, true, true);
    } else {
      renderSongsArea(document.querySelector("#img-best-songs"), playerData.rating.best, newestDate, true, false);
      renderSongsArea(document.querySelector("#img-new-songs"), playerData.rating.new, newestDate, true, false);
    }

    const pre = document.querySelector("#pre-render-area");
    pre.style.display = "block";
    pre.classList.toggle("mode-pscore", isPscore);

    // 组合图模式：Best/New 保留页头但去掉底部声明；P-score 只保留
    // “Top P-SCORE 50 Songs”歌曲区和最终声明。通过 DOM 自然收缩实现，
    // 不依赖固定像素，因此歌曲数量变化时仍能正确拼接。
    const header = document.querySelector("#img-header");
    const playerDataArea = document.querySelector("#img-player-data");
    const pscoreArea = document.querySelector("#img-pscore");
    const footer = document.querySelector("#img-footer");
    pre.style.removeProperty("padding-top");
    if (pscoreArea) pscoreArea.style.removeProperty("margin-top");
    for (const node of [header, playerDataArea, footer]) {
      if (node) node.style.removeProperty("display");
    }
    if (window.__otogameCombinedRender === true) {
      if (isPscore) {
        if (header) header.style.display = "none";
        if (playerDataArea) playerDataArea.style.display = "none";
        // 隐藏页头后去掉 pre-render-area 的顶部 padding 和 section margin，
        // 让拼接片段从“Top P-SCORE 50 Songs”标题直接开始。
        pre.style.paddingTop = "0";
        if (pscoreArea) pscoreArea.style.marginTop = "0";
      } else if (footer) {
        footer.style.display = "none";
      }
    }

    renderImage();
  }

  function openDialog() {
    assertReiwaPage();
    document.querySelector("#otogame-rating-json-dialog")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "otogame-rating-json-dialog";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "background:rgba(0,0,0,.45)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:20px",
      "font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif",
    ].join(";");

    const panel = document.createElement("div");
    panel.style.cssText = [
      "width:min(920px,100%)",
      "max-height:calc(100vh - 40px)",
      "background:#fff",
      "border-radius:12px",
      "box-shadow:0 24px 80px rgba(0,0,0,.35)",
      "padding:18px",
      "display:flex",
      "flex-direction:column",
      "gap:12px",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "Otogame rating JSON -> reiwa ongeki image";
    title.style.cssText = "font-size:18px;font-weight:700;color:#111;";

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:#111;";

    const nameInput = document.createElement("input");
    nameInput.placeholder = "PLAYER NAME";
    nameInput.value = "Ｎｆｙｚｌ";
    nameInput.style.cssText = "flex:0 0 180px;border:1px solid #ccd;border-radius:8px;padding:8px 10px;color:#111;background:#fff;";

    const modeSelect = document.createElement("select");
    modeSelect.style.cssText = "border:1px solid #ccd;border-radius:8px;padding:8px 10px;color:#111;background:#fff;";
    modeSelect.innerHTML = '<option value="bestnew">Best/New</option><option value="pscore">P-score</option>';

    const textarea = document.createElement("textarea");
    textarea.placeholder = "把 /api/game/ongeki/rating 的完整 JSON 响应粘贴在这里，要有code,message,data,timestamp";
    textarea.style.cssText = [
      "width:100%",
      "height:420px",
      "resize:vertical",
      "border:1px solid #ccd",
      "border-radius:8px",
      "padding:10px",
      "font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "color:#111",
      "background:#fff",
      "white-space:pre",
    ].join(";");

    const status = document.createElement("div");
    status.style.cssText = "min-height:20px;font-size:13px;color:#555;";

    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:10px;justify-content:flex-end;";

    const close = document.createElement("button");
    close.textContent = "Close";
    close.style.cssText = "border:1px solid #ccd;border-radius:8px;padding:8px 12px;background:#fff;color:#111;cursor:pointer;";
    close.onclick = () => overlay.remove();

    const generate = document.createElement("button");
    generate.textContent = "Generate";
    generate.style.cssText = "border:1px solid #396;border-radius:8px;padding:8px 14px;background:#396;color:#fff;cursor:pointer;font-weight:700;";
    generate.onclick = async () => {
      try {
        generate.disabled = true;
        status.textContent = "Parsing JSON and loading reiwa song DB...";
        const raw = normalizeResponse(JSON.parse(textarea.value));
        const db = await loadDb();
        const playerData = buildPlayerData(raw, db, nameInput.value.trim());
        status.textContent = `OK: B${playerData.rating.best.length} / N${playerData.rating.new.length} / P${playerData.rating.pscore.length}`;
        overlay.remove();
        renderWithReiwa(playerData, modeSelect.value);
      } catch (error) {
        console.error(error);
        status.textContent = error.message;
        status.style.color = "#c00";
      } finally {
        generate.disabled = false;
      }
    };

    row.append(nameInput, modeSelect);
    buttons.append(close, generate);
    panel.append(title, row, textarea, status, buttons);
    overlay.append(panel);
    document.body.append(overlay);
    textarea.focus();
  }

  window.openOtogameRatingJsonToReiwaOngeki = openDialog;
  openDialog();
})();
