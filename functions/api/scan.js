// functions/api/scan.js
// 中文備註：Cloudflare Pages Function：/api/scan
// 目標：
// 1) 名稱：一律用「證交所 ISIN 清單」→ 永遠繁中、永遠有名稱
// 2) 行情：FinMind 優先，失敗就自動改用 Yahoo（備援）
// 3) Top500：用 ISIN 全市場取前 500（你也可之後改成自選清單）
// 注意：FinMind 有流量上限，Top500 很容易撞限，所以一定要做 Yahoo 備援
// 參考：FinMind API 常用 dataset = TaiwanStockPrice，API 走 /api/v4/data（社群範例）
// https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=2330&start_date=2024-01-01&end_date=2024-12-31&token=xxx

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// 中文備註：回 JSON
function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, ...extraHeaders },
  });
}

// 中文備註：安全取數字
function toNumber(v, defVal) {
  const n = Number(v);
  return Number.isFinite(n) ? n : defVal;
}

// ============================
// ① 名稱來源：ISIN（繁中）
// ============================
const ISIN_URLS = [
  // 中文備註：上市
  "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2",
  // 中文備註：上櫃
  "https://isin.twse.com.tw/isin/C_public.jsp?strMode=4",
];

// 中文備註：解析 ISIN HTML，抓出「代碼 + 名稱」
function parseIsinHtmlToList(html) {
  const list = [];
  const trMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trMatches) {
    const tds = tr.match(/<td[\s\S]*?<\/td>/gi) || [];
    if (tds.length < 1) continue;

    const td0 = tds[0]
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // 格式：2330 台灣積體電路製造股份有限公司
    const m = td0.match(/^(\d{4})\s+(.+)$/);
    if (!m) continue;

    const code = m[1];
    const name = (m[2] || "").trim();
    if (!code || !name) continue;

    list.push({ code, name });
  }
  return list;
}

// 中文備註：抓 ISIN 全市場 → 去重 → 回傳陣列
async function fetchIsinUniverse() {
  const merged = [];

  for (const url of ISIN_URLS) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      const html = await res.text();
      merged.push(...parseIsinHtmlToList(html));
    } catch {}
  }

  const map = new Map();
  for (const it of merged) {
    if (!map.has(it.code)) map.set(it.code, it.name);
  }

  // 中文備註：維持順序（通常 ISIN 順序就夠用了）
  return Array.from(map.entries()).map(([code, name]) => ({ code, name }));
}

// ============================
// ② 行情來源 A：FinMind（優先）
// ============================

// 中文備註：FinMind v4 data endpoint
function buildFinMindUrl(code, startDate, endDate, token) {
  const base = "https://api.finmindtrade.com/api/v4/data";
  const params = new URLSearchParams();
  params.set("dataset", "TaiwanStockPrice");
  params.set("data_id", code);
  params.set("start_date", startDate);
  params.set("end_date", endDate);
  if (token) params.set("token", token);
  return `${base}?${params.toString()}`;
}

// 中文備註：抓 FinMind 日線（回傳 rows：[{close, volume}]）
async function fetchFinMindDaily(code, startDate, endDate, token) {
  const url = buildFinMindUrl(code, startDate, endDate, token);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  if (!res.ok) throw new Error(`FinMind HTTP ${res.status}`);
  const data = await res.json();

  // 中文備註：FinMind 回傳格式通常是 { status, msg, data:[...] }
  const rows = Array.isArray(data?.data) ? data.data : [];
  if (rows.length < 80) throw new Error("FinMind not enough data");

  // 中文備註：統一輸出 close/volume
  const out = [];
  for (const r of rows) {
    const c = Number(r.close);
    const v = Number(r.Trading_Volume ?? r.Trading_volume ?? r.volume ?? r.trade_volume ?? r.TradingVolume);
    if (!Number.isFinite(c)) continue;
    // volume 有些資料集欄位命名不同，抓不到就當 0（後面會被 vma 排掉）
    out.push({ close: c, volume: Number.isFinite(v) ? v : 0 });
  }

  if (out.length < 80) throw new Error("FinMind parsed not enough data");
  return out;
}

// ============================
// ③ 行情來源 B：Yahoo（備援）
// ============================

function buildYahooSymbols(code) {
  return [`${code}.TW`, `${code}.TWO`];
}

async function fetchYahooDailyBySymbol(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1y&interval=1d&includePrePost=false`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  if (!res.ok) throw new Error(`Yahoo chart HTTP ${res.status}`);
  const data = await res.json();

  const result = data?.chart?.result?.[0];
  const err = data?.chart?.error;
  if (!result || err) throw new Error(`Yahoo chart error`);

  const ts = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    const v = volumes[i];
    if (c == null || v == null) continue;
    out.push({ close: Number(c), volume: Number(v) });
  }

  if (out.length < 80) throw new Error("Yahoo not enough data");
  return out;
}

async function fetchYahooDaily(code) {
  const syms = buildYahooSymbols(code);
  for (const sym of syms) {
    try {
      const rows = await fetchYahooDailyBySymbol(sym);
      return rows;
    } catch {}
  }
  throw new Error("Yahoo all symbols failed");
}

// ============================
// ④ 計算工具（Rolling SMA）
// ============================

function rollingSMA(values, window) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (window <= 0) return out;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

function isTangledBySeries(closes, maS, maM, maL, lookbackDays, maxSpreadPct) {
  const n = closes.length;
  const start = Math.max(0, n - lookbackDays);

  for (let i = start; i < n; i++) {
    const s = maS[i], m = maM[i], l = maL[i];
    const c = closes[i];
    if (s == null || m == null || l == null) return false;
    if (!c || c <= 0) return false;

    const mx = Math.max(s, m, l);
    const mn = Math.min(s, m, l);
    const spread = (mx - mn) / c;
    if (spread > maxSpreadPct) return false;
  }
  return true;
}

function isTurningUp(maLongSeries, slopeDays) {
  const n = maLongSeries.length;
  const i0 = n - 1;
  const i1 = n - 1 - Math.max(1, slopeDays);
  if (i1 < 0) return false;

  const a = maLongSeries[i0];
  const b = maLongSeries[i1];
  if (a == null || b == null) return false;
  return a > b;
}

// ============================
// ⑤ 主流程：/api/scan
// ============================

export async function onRequest(context) {
  const { request } = context;

  // 中文備註：CORS 預檢
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // 中文備註：健康檢查
  if (request.method === "GET") return json({ ok: true, message: "✅ /api/scan 正常（請用 POST）" });

  if (request.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);

  const t0 = Date.now();

  try {
    const body = await request.json();
    const rules = body?.rules || {};

    // 中文備註：讀取規則（你的前端欄位）
    const ma_short = Math.floor(toNumber(rules.ma_short, 5));
    const ma_mid = Math.floor(toNumber(rules.ma_mid, 10));
    const ma_long = Math.floor(toNumber(rules.ma_long, 20));

    const tangle_lookback_days = Math.floor(toNumber(rules.tangle_lookback_days, 5));
    const tangle_max_spread_pct = toNumber(rules.tangle_max_spread_pct, 0.05);

    const volume_multiplier = toNumber(rules.volume_multiplier, 0.8);
    const volume_ma_days = Math.floor(toNumber(rules.volume_ma_days, 60));

    const cache_ttl_seconds = Math.max(0, Math.floor(toNumber(rules.cache_ttl_seconds, 1200)));

    // 中文備註：進階（後端預設）
    const slope_days = Math.floor(toNumber(rules.slope_days, 3));
    const max_extension_pct = toNumber(rules.max_extension_pct, 0.12);

    // ✅ V1 固定 Top500
    const pool_size = 500;

    // 中文備註：快取 key（同規則 + 當天）
    const day = new Date().toISOString().slice(0, 10);
    const cacheKeyObj = {
      ma_short, ma_mid, ma_long,
      tangle_lookback_days, tangle_max_spread_pct,
      volume_multiplier, volume_ma_days,
      slope_days, max_extension_pct,
      pool_size,
      day,
    };
    const cacheKey = "https://cache.local/scan?" + encodeURIComponent(JSON.stringify(cacheKeyObj));
    const cache = caches.default;

    if (cache_ttl_seconds > 0) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const cachedText = await hit.text();
        return new Response(cachedText, { status: 200, headers: corsHeaders });
      }
    }

    // 中文備註：先抓 ISIN → 建 code->name
    const isinAll = await fetchIsinUniverse();
    const isinTop = isinAll.slice(0, pool_size);

    const nameMap = new Map();
    for (const it of isinTop) nameMap.set(it.code, it.name);

    // 中文備註：FinMind token（從 Cloudflare 環境變數拿）
    const FINMIND_TOKEN = context?.env?.FINMIND_TOKEN || "";

    // 中文備註：抓資料期間（1y 足夠算 20MA + lookback）
    const endDate = day;
    const startDate = new Date(Date.now() - 370 * 24 * 3600 * 1000).toISOString().slice(0, 10);

    // 中文備註：診斷資訊（讓你看是不是被擋/是不是 fallback）
    const diag = {
      universe_used: isinTop.length,
      finmind_token: FINMIND_TOKEN ? "有" : "無",
      finmind_ok: 0,
      finmind_fail: 0,
      yahoo_ok: 0,
      yahoo_fail: 0,
      used_yahoo_fallback: 0,
    };

    const items = [];

    // 中文備註：為了穩定，先用「循序」避免瞬間爆量被擋
    for (const { code } of isinTop) {
      const name = nameMap.get(code) || code;

      let rows = null;
      let used = "";

      // 1) FinMind 優先
      try {
        rows = await fetchFinMindDaily(code, startDate, endDate, FINMIND_TOKEN);
        used = "finmind";
        diag.finmind_ok += 1;
      } catch (e) {
        diag.finmind_fail += 1;
      }

      // 2) 失敗就 Yahoo 備援
      if (!rows) {
        try {
          rows = await fetchYahooDaily(code);
          used = "yahoo";
          diag.yahoo_ok += 1;
          diag.used_yahoo_fallback += 1;
        } catch (e) {
          diag.yahoo_fail += 1;
          continue;
        }
      }

      const closes = rows.map(r => r.close);
      const vols = rows.map(r => r.volume);

      const close = closes[closes.length - 1];
      const volume = vols[vols.length - 1];

      // 中文備註：rolling series
      const maS_series = rollingSMA(closes, ma_short);
      const maM_series = rollingSMA(closes, ma_mid);
      const maL_series = rollingSMA(closes, ma_long);
      const vma_series = rollingSMA(vols, volume_ma_days);

      const maS = maS_series[maS_series.length - 1];
      const maM = maM_series[maM_series.length - 1];
      const maL = maL_series[maL_series.length - 1];
      const vma = vma_series[vma_series.length - 1];

      if (maS == null || maM == null || maL == null) continue;
      if (vma == null || vma <= 0) continue;

      const vol_ratio = volume / vma;

      // ✅ 條件（你要的三線合一 + 進階）
      // 1) 糾結
      const tangled = isTangledBySeries(closes, maS_series, maM_series, maL_series, tangle_lookback_days, tangle_max_spread_pct);
      if (!tangled) continue;

      // 2) 多頭排列
      if (!(maS > maM && maM > maL)) continue;

      // 3) 站上三線
      if (!(close >= maS && close >= maM && close >= maL)) continue;

      // 4) 量能
      if (!(vol_ratio >= volume_multiplier)) continue;

      // 5) MA長轉強
      if (!isTurningUp(maL_series, slope_days)) continue;

      // 6) 避免追高（乖離限制）
      const extension = (close - maL) / maL;
      if (extension > max_extension_pct) continue;

      items.push({
        code,
        name,           // ✅ 永遠繁中（ISIN）
        close,
        ma_short: maS,
        ma_mid: maM,
        ma_long: maL,
        volume,
        vma,
        vol_ratio,
        src: used,      // 中文備註：你若不想顯示來源，前端忽略即可
      });
    }

    // 中文備註：排序（量比大到小）
    items.sort((a, b) => (b.vol_ratio || 0) - (a.vol_ratio || 0));

    const elapsed_sec = ((Date.now() - t0) / 1000).toFixed(2);

    const payload = {
      count: items.length,
      cached: false,
      elapsed_sec,
      items,
      diag,
    };

    if (cache_ttl_seconds > 0) {
      const res = json(payload, 200, { "Cache-Control": `public, max-age=${cache_ttl_seconds}` });
      context.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    return json(payload);

  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
