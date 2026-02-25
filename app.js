// ===============================
// app.js（整包）
// 功能：
// 1) 呼叫 Cloudflare Pages Function：/api/stock?code=xxxx
// 2) 自動三線合一判斷（5/10/20 均線：糾結→向上排列、股價站上三線、量>10均量）
// 3) localStorage 記住爸爸常看股票（快速清單）
// 4) 手機版互動友善（搭配你 styles.css）
// ===============================

// -------------------------------
// 0_工具：DOM 取得
// -------------------------------
const $ = (sel) => document.querySelector(sel);

// -------------------------------
// 1_設定：localStorage key
// -------------------------------
const LS_KEY = "dad_stock_watchlist_v1";

// -------------------------------
// 2_初始化：頁面載入後綁定事件 + render 快速清單
// -------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const input = $("#stockInput");
  const btn = $("#searchBtn");

  // Enter 直接查
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchStock();
  });

  // 點按鈕查
  btn?.addEventListener("click", () => searchStock());

  renderQuickList();
});

// -------------------------------
// 3_主要：查股票（給 index.html 的 onclick / 綁定用）
// -------------------------------
async function searchStock(codeFromQuick) {
  const input = $("#stockInput");
  const result = $("#result");

  const code = (codeFromQuick ?? input?.value ?? "").toString().trim();
  if (!code) {
    toast("請輸入股票代號，例如 2330");
    return;
  }

  // UI：loading
  setResultLoading(true);

  try {
    // 呼叫 Pages Functions：/api/stock?code=2330
    const url = `/api/stock?code=${encodeURIComponent(code)}`;
    const resp = await fetch(url, { method: "GET" });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`API 回應失敗：${resp.status} ${text}`);
    }

    const data = await resp.json();

    // data 預期格式：由 functions/api/stock.js 回來
    // {
    //   ok: true,
    //   code, name,
    //   price, change, changePercent,
    //   candles: [{date, open, high, low, close, volume}...]
    // }

    if (!data?.ok) throw new Error(data?.error || "API 回傳 ok=false");

    // 1) 寫入 watchlist（localStorage）
    upsertWatchlist(code, data.name);

    // 2) 算三線合一判斷
    const verdict = calcThreeLineSignal(data.candles);

    // 3) 顯示結果
    renderResult({
      code: data.code,
      name: data.name,
      price: data.price,
      change: data.change,
      changePercent: data.changePercent,
      verdict,
      raw: data,
    });

    // 4) 更新快速清單
    renderQuickList();
  } catch (err) {
    setResultLoading(false);
    result.innerHTML = `
      <div class="card error">
        <div class="card_title">查詢失敗</div>
        <div class="card_body">${escapeHtml(String(err?.message ?? err))}</div>
        <div class="muted">提示：確認 /api/stock 正常、或稍後再試。</div>
      </div>
    `;
  }
}

// 讓 index.html 的 onclick 能叫到
window.searchStock = searchStock;

// -------------------------------
// 4_渲染：結果區塊
// -------------------------------
function renderResult({ code, name, price, change, changePercent, verdict }) {
  const result = $("#result");
  setResultLoading(false);

  const ch = toNum(change);
  const chp = toNum(changePercent);

  const badgeClass =
    ch > 0 ? "badge up" : ch < 0 ? "badge down" : "badge flat";

  result.innerHTML = `
    <section class="card">
      <div class="card_header">
        <div class="card_title">${escapeHtml(code)} ${escapeHtml(name || "")}</div>
        <div class="card_sub">
          <span class="${badgeClass}">
            ${fmtSigned(ch)} (${fmtSigned(chp)}%)
          </span>
        </div>
      </div>

      <div class="grid2">
        <div class="kpi">
          <div class="kpi_label">現價</div>
          <div class="kpi_value">${isFinite(price) ? round(price, 2) : "-"}</div>
        </div>
        <div class="kpi">
          <div class="kpi_label">三線合一</div>
          <div class="kpi_value">${escapeHtml(verdict.verdict)}</div>
        </div>
      </div>

      <div class="divider"></div>

      <div class="checklist">
        <div class="check_item">
          <span class="dot ${verdict.details.tangled.pass ? "ok" : "ng"}"></span>
          <span>5/10/20 日線「糾結」</span>
          <span class="muted">${escapeHtml(verdict.details.tangled.note)}</span>
        </div>
        <div class="check_item">
          <span class="dot ${verdict.details.arranged.pass ? "ok" : "ng"}"></span>
          <span>均線向上排列（5&gt;10&gt;20）</span>
          <span class="muted">${escapeHtml(verdict.details.arranged.note)}</span>
        </div>
        <div class="check_item">
          <span class="dot ${verdict.details.trendingUp.pass ? "ok" : "ng"}"></span>
          <span>三線同時上彎（斜率向上）</span>
          <span class="muted">${escapeHtml(verdict.details.trendingUp.note)}</span>
        </div>
        <div class="check_item">
          <span class="dot ${verdict.details.priceAbove.pass ? "ok" : "ng"}"></span>
          <span>股價站上三線</span>
          <span class="muted">${escapeHtml(verdict.details.priceAbove.note)}</span>
        </div>
        <div class="check_item">
          <span class="dot ${verdict.details.volume.pass ? "ok" : "ng"}"></span>
          <span>量能 &gt; 近10日均量</span>
          <span class="muted">${escapeHtml(verdict.details.volume.note)}</span>
        </div>
      </div>

      <div class="divider"></div>

      <div class="muted">
        分數：${verdict.score} / 5（≥4 視為接近三線合一）
      </div>
    </section>
  `;
}

// -------------------------------
// 5_渲染：快速清單（爸爸常看）
// -------------------------------
function renderQuickList() {
  const box = $("#quickList");
  if (!box) return;

  const list = loadWatchlist();

  if (!list.length) {
    box.innerHTML = `
      <div class="quick_empty">
        <span class="pill">小提醒</span>
        先用「代號」搜尋一次，會自動把常看股票記住。
      </div>
    `;
    return;
  }

  box.innerHTML = `
    <div class="quick_wrap">
      ${list
        .slice(0, 12)
        .map(
          (it) => `
        <button class="quick_btn" type="button"
          onclick="searchStock('${escapeAttr(it.code)}')">
          ${escapeHtml(it.code)}
          <span class="muted">${escapeHtml(it.name || "")}</span>
        </button>
      `
        )
        .join("")}
      <button class="quick_btn danger" type="button" onclick="clearWatchlist()">
        清空
      </button>
    </div>
  `;
}

window.clearWatchlist = () => {
  localStorage.removeItem(LS_KEY);
  toast("已清空常看清單");
  renderQuickList();
};

// -------------------------------
// 6_localStorage：增修/載入
// -------------------------------
function loadWatchlist() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    // 依最近時間排序
    return arr
      .filter((x) => x && x.code)
      .sort((a, b) => (b.t || 0) - (a.t || 0));
  } catch {
    return [];
  }
}

function upsertWatchlist(code, name) {
  const list = loadWatchlist();
  const now = Date.now();

  const idx = list.findIndex((x) => x.code === code);
  if (idx >= 0) {
    list[idx] = { ...list[idx], name: name || list[idx].name || "", t: now };
  } else {
    list.unshift({ code, name: name || "", t: now });
  }

  // 最多保留 30 檔
  const trimmed = list.slice(0, 30);
  localStorage.setItem(LS_KEY, JSON.stringify(trimmed));
}

// -------------------------------
// 7_核心：三線合一判斷
// 規則（簡化版，給 MVP）：
// - tangled：5/10/20 SMA 彼此差距在 1% 以內
// - arranged：5 > 10 > 20
// - trendingUp：5/10/20 今日比昨日上升
// - priceAbove：收盤 > 5/10/20
// - volume：今日量 > 近10日均量
// 分數 >= 4 → 接近三線合一
// -------------------------------
function calcThreeLineSignal(candles) {
  // candles：越新越舊都可能，這裡做排序（日期由舊到新）
  const arr = Array.isArray(candles) ? [...candles] : [];
  arr.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  if (arr.length < 30) {
    return {
      score: 0,
      verdict: "資料不足",
      details: {
        tangled: { pass: false, note: "需要至少 30 根日K" },
        arranged: { pass: false, note: "-" },
        trendingUp: { pass: false, note: "-" },
        priceAbove: { pass: false, note: "-" },
        volume: { pass: false, note: "-" },
      },
    };
  }

  const closes = arr.map((x) => toNum(x.close)).filter((n) => isFinite(n));
  const vols = arr.map((x) => toNum(x.volume)).filter((n) => isFinite(n));

  const lastClose = toNum(arr[arr.length - 1].close);
  const lastVol = toNum(arr[arr.length - 1].volume);

  const sma5 = sma(closes, 5);
  const sma10 = sma(closes, 10);
  const sma20 = sma(closes, 20);

  // 昨日 SMA（用到倒數第二天的序列）
  const closesPrev = closes.slice(0, closes.length - 1);
  const sma5p = sma(closesPrev, 5);
  const sma10p = sma(closesPrev, 10);
  const sma20p = sma(closesPrev, 20);

  // tangled：差距都在 1% 以內（以 20 線為基準）
  const base = sma20;
  const d510 = pctDiff(sma5, sma10);
  const d520 = pctDiff(sma5, sma20);
  const d1020 = pctDiff(sma10, sma20);

  const tangledPass =
    isFinite(base) &&
    d510 <= 1 &&
    d520 <= 1 &&
    d1020 <= 1;

  // arranged：5 > 10 > 20
  const arrangedPass = sma5 > sma10 && sma10 > sma20;

  // trendingUp：三線都比昨日高
  const trendingUpPass = sma5 > sma5p && sma10 > sma10p && sma20 > sma20p;

  // priceAbove：收盤站上三線
  const priceAbovePass = lastClose > sma5 && lastClose > sma10 && lastClose > sma20;

  // volume：今日量 > 近10日均量
  const vol10 = sma(vols, 10);
  const volumePass = lastVol > vol10;

  const checks = [tangledPass, arrangedPass, trendingUpPass, priceAbovePass, volumePass];
  const score = checks.filter(Boolean).length;

  return {
    score,
    verdict:
      score >= 4
        ? "✅ 接近三線合一（偏多）"
        : score === 3
        ? "🟡 中性偏多"
        : score === 2
        ? "🟠 觀察"
        : "⚪ 尚未形成",
    details: {
      tangled: { pass: tangledPass, note: `差距(%)：5-10=${round(d510,2)}, 5-20=${round(d520,2)}, 10-20=${round(d1020,2)}` },
      arranged: { pass: arrangedPass, note: `SMA：5=${round(sma5,2)} / 10=${round(sma10,2)} / 20=${round(sma20,2)}` },
      trendingUp: { pass: trendingUpPass, note: `昨日：5=${round(sma5p,2)} / 10=${round(sma10p,2)} / 20=${round(sma20p,2)}` },
      priceAbove: { pass: priceAbovePass, note: `收盤=${round(lastClose,2)}` },
      volume: { pass: volumePass, note: `量=${round(lastVol,0)} vs 10均量=${round(vol10,0)}` },
    },
  };
}

// -------------------------------
// 8_小工具：SMA/數字/格式
// -------------------------------
function sma(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return NaN;
  const s = arr.slice(-n);
  const sum = s.reduce((a, b) => a + b, 0);
  return sum / n;
}

function pctDiff(a, b) {
  // 百分比差距（相對於較大的那個，避免 0）
  const x = Math.abs(toNum(a));
  const y = Math.abs(toNum(b));
  const m = Math.max(x, y, 1e-9);
  return (Math.abs(x - y) / m) * 100;
}

function toNum(x) {
  const s = String(x ?? "").replace(/,/g, "").trim();
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

function round(x, d) {
  const p = 10 ** d;
  return Math.round(toNum(x) * p) / p;
}

function fmtSigned(x) {
  const n = toNum(x);
  if (!isFinite(n)) return "-";
  return (n > 0 ? "+" : n < 0 ? "" : "") + round(n, 2);
}

function setResultLoading(isLoading) {
  const result = $("#result");
  if (!result) return;
  if (isLoading) {
    result.innerHTML = `
      <div class="card loading">
        <div class="card_title">查詢中…</div>
        <div class="muted">正在呼叫 API，請稍等。</div>
      </div>
    `;
  }
}

function toast(msg) {
  // 低成本提示（MVP）
  alert(msg);
}

// HTML escape（避免 XSS）
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(str) {
  return escapeHtml(str).replaceAll('"', "&quot;");
}
