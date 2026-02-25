// functions/api/stock.js
// 中文備註：Cloudflare Pages Function：股票資料 API（使用 FinMind，避免 TPEx 網頁版無限轉址）
// 路徑：/api/stock?code=2330
// 回傳：近 120 天日線資料 + SMA5/10/20 + 三線合一判斷

export async function onRequestGet(context) {
  // === CORS 設定（讓前端可直接呼叫）===
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  };

  try {
    const url = new URL(context.request.url);
    const code = (url.searchParams.get("code") || "").trim();

    // 中文備註：基本檢查
    if (!code) {
      return json(
        { ok: false, error: "缺少參數 code，例如 /api/stock?code=2330" },
        400,
        corsHeaders
      );
    }

    // 中文備註：只允許常見台股代號格式（4~6 碼數字）
    if (!/^\d{4,6}$/.test(code)) {
      return json(
        { ok: false, error: "code 格式錯誤，請輸入 4~6 碼數字代號（例如 2330）" },
        400,
        corsHeaders
      );
    }

    // === 取得時間範圍（近 120 天，足夠算 SMA20/量均）===
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 140); // 多抓一點，避免遇到假日

    const startDate = formatDate(start); // YYYY-MM-DD
    const endDate = formatDate(end);     // YYYY-MM-DD

    // === 呼叫 FinMind（免 token 也可用，但可能有頻率限制）===
    // 中文備註：用 Cloudflare cache 降低被限流機率（同一代號 30 秒內重複查詢直接用快取）
    const cacheKey = new Request(
      `https://cache.local/api/stock?code=${code}&start=${startDate}&end=${endDate}`,
      { method: "GET" }
    );
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const finmindUrl = new URL("https://api.finmindtrade.com/api/v4/data");
    finmindUrl.searchParams.set("dataset", "TaiwanStockPrice");
    finmindUrl.searchParams.set("stock_id", code);
    finmindUrl.searchParams.set("start_date", startDate);
    finmindUrl.searchParams.set("end_date", endDate);

    const r = await fetch(finmindUrl.toString(), {
      headers: {
        "User-Agent": "dad-stock-web/1.0 (Cloudflare Pages Function)",
        "Accept": "application/json",
      },
    });

    if (!r.ok) {
      const text = await safeText(r);
      return json(
        {
          ok: false,
          error: `FinMind HTTP ${r.status}`,
          detail: text?.slice(0, 300) || "",
        },
        502,
        corsHeaders
      );
    }

    const data = await r.json();

    // 中文備註：FinMind 正常會回傳 { status: 200, data: [...] }
    if (!data || !Array.isArray(data.data) || data.data.length === 0) {
      return json(
        { ok: false, error: "查無資料（可能代號不存在或資料源暫時無回應）" },
        404,
        corsHeaders
      );
    }

    // === 整理 K 線資料（由舊到新排序）===
    const rows = data.data
      .map((x) => ({
        date: x.date,
        open: toNum(x.open),
        high: toNum(x.max),
        low: toNum(x.min),
        close: toNum(x.close),
        volume: toNum(x.Trading_Volume),
      }))
      .filter((x) => Number.isFinite(x.close))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (rows.length < 30) {
      return json(
        { ok: false, error: "資料天數不足（小於 30 日），無法可靠計算三線合一" },
        422,
        corsHeaders
      );
    }

    // === 計算 SMA5/10/20 + 10日均量 ===
    const closes = rows.map((x) => x.close);
    const volumes = rows.map((x) => x.volume);

    const sma5 = calcSMA(closes, 5);
    const sma10 = calcSMA(closes, 10);
    const sma20 = calcSMA(closes, 20);
    const vma10 = calcSMA(volumes, 10);

    const enriched = rows.map((x, i) => ({
      ...x,
      sma5: sma5[i],
      sma10: sma10[i],
      sma20: sma20[i],
      vma10: vma10[i],
    }));

    // === 三線合一判斷（偏保守、可用）===
    // 規則：5/10/20 糾結 → 向上排列 → 股價站上三線 → 量大於10日均量
    const last = enriched[enriched.length - 1];

    const hasMA = [last.sma5, last.sma10, last.sma20].every(Number.isFinite);
    if (!hasMA) {
      return json(
        { ok: false, error: "均線計算不足（可能資料不足或 volume 缺漏）" },
        422,
        corsHeaders
      );
    }

    // 中文備註：糾結定義：最近 5 天內，三條均線最大最小差距 < 1.5%（可調）
    const tangleWindow = enriched.slice(-5);
    const tangleOk = tangleWindow.every((d) => {
      const arr = [d.sma5, d.sma10, d.sma20].filter(Number.isFinite);
      if (arr.length < 3) return false;
      const max = Math.max(...arr);
      const min = Math.min(...arr);
      const base = d.close || max;
      return base > 0 ? (max - min) / base <= 0.015 : false;
    });

    // 中文備註：向上排列
    const arrangedUp = last.sma5 > last.sma10 && last.sma10 > last.sma20;

    // 中文備註：站上三線
    const priceAbove =
      last.close > last.sma5 && last.close > last.sma10 && last.close > last.sma20;

    // 中文備註：量 > 10 日均量（若 volume 缺就不強制）
    const volOk =
      Number.isFinite(last.volume) && Number.isFinite(last.vma10)
        ? last.volume > last.vma10
        : false;

    // 中文備註：計分（方便你前端顯示）
    let score = 0;
    if (tangleOk) score += 1;
    if (arrangedUp) score += 1;
    if (priceAbove) score += 1;
    if (volOk) score += 1;

    const verdict =
      score >= 4
        ? "✅ 接近三線合一（偏多）"
        : score === 3
        ? "🟡 中性偏多"
        : score === 2
        ? "🟠 還在整理"
        : "⚪ 尚未形成";

    const result = {
      ok: true,
      source: "FinMind:TaiwanStockPrice",
      query: { code, startDate, endDate },
      last: {
        date: last.date,
        close: last.close,
        volume: last.volume,
        sma5: round(last.sma5, 3),
        sma10: round(last.sma10, 3),
        sma20: round(last.sma20, 3),
        vma10: round(last.vma10, 0),
      },
      threeLine: {
        tangle: { pass: tangleOk },
        arrangedUp: { pass: arrangedUp },
        priceAbove: { pass: priceAbove },
        volume: { pass: volOk },
        score,
        verdict,
      },
      // 中文備註：給前端畫線/計算用（近 120 天）
      candles: enriched.slice(-120).map((d) => ({
        date: d.date,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
        sma5: safeRound(d.sma5, 3),
        sma10: safeRound(d.sma10, 3),
        sma20: safeRound(d.sma20, 3),
        vma10: safeRound(d.vma10, 0),
      })),
    };

    const response = json(result, 200, corsHeaders);

    // 中文備註：快取 30 秒（避免連點導致被 API 限流）
    response.headers.set("Cache-Control", "public, max-age=30");

    // 中文備註：寫入 Cloudflare Cache
    context.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch (err) {
    return json(
      { ok: false, error: "API 發生例外", detail: String(err?.message || err) },
      500,
      corsHeaders
    );
  }
}

// =====================
// 工具函式（中文備註）
// =====================

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers });
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toNum(x) {
  const s = String(x ?? "").replace(/,/g, "").trim();
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

function calcSMA(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  let q = [];

  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    q.push(v);
    sum += Number.isFinite(v) ? v : 0;

    if (q.length > n) {
      const removed = q.shift();
      sum -= Number.isFinite(removed) ? removed : 0;
    }

    if (q.length === n && q.every(Number.isFinite)) {
      out[i] = sum / n;
    }
  }
  return out;
}

function round(x, d) {
  const p = 10 ** d;
  return Math.round(x * p) / p;
}

function safeRound(x, d) {
  return Number.isFinite(x) ? round(x, d) : null;
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
