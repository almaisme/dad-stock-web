// functions/api/scan.js
// 中文備註：Cloudflare Pages Function：/api/scan
// 功能：抓 Yahoo Finance 日線資料 → 計算均線/量比 → 依規則篩選 → 回傳給前端表格

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// 中文備註：回 JSON 的小工具
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

// 中文備註：股票池（先用常見大型股示範，避免一次掃太多超時）
const UNIVERSE_CODES = [
  "2330", "2317", "2454", "2308", "2412",
  "2881", "2882", "2884", "2886", "2891",
  "1301", "1303", "2002", "2603", "2609",
  "2615", "3034", "2303", "3711", "2382",
];

// ✅ 中文備註：繁中名稱兜底對照（Yahoo 偶爾回英文，這裡用代碼補）
const ZH_NAME_FALLBACK = {
  "2330": "台積電",
  "2317": "鴻海",
  "2454": "聯發科",
  "2308": "台達電",
  "2412": "中華電",
  "2881": "富邦金",
  "2882": "國泰金",
  "2884": "玉山金",
  "2886": "兆豐金",
  "2891": "中信金",
  "1301": "台塑",
  "1303": "南亞",
  "2002": "中鋼",
  "2603": "長榮",
  "2609": "陽明",
  "2615": "萬海",
  "3034": "聯詠",
  "2303": "聯電",
  "3711": "日月光投控",
  "2382": "廣達",
};

// 中文備註：把 2330 轉成 Yahoo symbol（先試 .TW，失敗再試 .TWO）
function buildSymbols(code) {
  return [`${code}.TW`, `${code}.TWO`];
}

// 中文備註：抓 Yahoo 日線（chart API）
async function fetchYahooChart(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1y&interval=1d&includePrePost=false`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  if (!res.ok) throw new Error(`chart HTTP ${res.status}`);
  const data = await res.json();

  const result = data?.chart?.result?.[0];
  const err = data?.chart?.error;
  if (!result || err) throw new Error(`chart error: ${err?.description || "no result"}`);

  const ts = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    const v = volumes[i];
    if (c == null || v == null) continue;
    rows.push({ t: ts[i], close: Number(c), volume: Number(v) });
  }

  if (rows.length < 60) throw new Error("not enough data");
  return rows;
}

// ✅ 中文備註：批次抓名稱（quote API），加上 zh-TW / TW 參數，優先拿繁中
async function fetchYahooNames(symbols) {
  const url =
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}` +
    `&lang=zh-TW&region=TW`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  if (!res.ok) return new Map();
  const data = await res.json();
  const list = data?.quoteResponse?.result || [];

  const map = new Map();
  for (const it of list) {
    if (!it?.symbol) continue;

    // 中文備註：有些會回 longName/shortName，這裡都吃，優先 longName
    const name = it.longName || it.shortName || "";
    map.set(it.symbol, name);
  }
  return map;
}

// 中文備註：計算簡單移動平均（SMA）
function sma(values, window) {
  if (values.length < window) return null;
  let sum = 0;
  for (let i = values.length - window; i < values.length; i++) sum += values[i];
  return sum / window;
}

// 中文備註：計算近 N 天均量
function avg(values, window) {
  if (values.length < window) return null;
  let sum = 0;
  for (let i = values.length - window; i < values.length; i++) sum += values[i];
  return sum / window;
}

// 中文備註：判斷「三線糾結」
function isTangled(closes, maS, maM, maL, lookbackDays, maxSpreadPct) {
  const n = closes.length;
  const start = Math.max(0, n - lookbackDays);

  for (let i = start; i < n; i++) {
    const slice = closes.slice(0, i + 1);
    const s = sma(slice, maS);
    const m = sma(slice, maM);
    const l = sma(slice, maL);
    if (s == null || m == null || l == null) return false;

    const mx = Math.max(s, m, l);
    const mn = Math.min(s, m, l);
    const c = closes[i] || 0;
    if (c <= 0) return false;

    const spread = (mx - mn) / c;
    if (spread > maxSpreadPct) return false;
  }

  return true;
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (request.method === "GET") {
    return json({ ok: true, message: "✅ /api/scan 正常（請用 POST）" });
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  const t0 = Date.now();

  try {
    const body = await request.json();
    const rules = body?.rules || {};

    const ma_short = toNumber(rules.ma_short, 5);
    const ma_mid = toNumber(rules.ma_mid, 10);
    const ma_long = toNumber(rules.ma_long, 20);

    const tangle_lookback_days = toNumber(rules.tangle_lookback_days, 5);
    const tangle_max_spread_pct = toNumber(rules.tangle_max_spread_pct, 0.05); // 5% 預設較寬鬆

    const volume_multiplier = toNumber(rules.volume_multiplier, 0.6);
    const volume_ma_days = toNumber(rules.volume_ma_days, 10);

    const cache_ttl_seconds = Math.max(0, toNumber(rules.cache_ttl_seconds, 600));

    const cacheKeyObj = {
      ma_short, ma_mid, ma_long,
      tangle_lookback_days,
      tangle_max_spread_pct,
      volume_multiplier,
      volume_ma_days,
      day: new Date().toISOString().slice(0, 10),
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

    const items = [];
    const resolvedSymbols = [];

    for (const code of UNIVERSE_CODES) {
      const candidates = buildSymbols(code);

      let rows = null;
      let usedSymbol = null;

      for (const sym of candidates) {
        try {
          rows = await fetchYahooChart(sym);
          usedSymbol = sym;
          break;
        } catch (e) {}
      }

      if (!rows || !usedSymbol) continue;

      const closes = rows.map(r => r.close);
      const vols = rows.map(r => r.volume);

      const close = closes[closes.length - 1];
      const volume = vols[vols.length - 1];

      const maS = sma(closes, ma_short);
      const maM = sma(closes, ma_mid);
      const maL = sma(closes, ma_long);
      if (maS == null || maM == null || maL == null) continue;

      const vma = avg(vols, volume_ma_days);
      if (vma == null || vma <= 0) continue;
      const vol_ratio = volume / vma;

      // 篩選條件
      const tangled = isTangled(closes, ma_short, ma_mid, ma_long, tangle_lookback_days, tangle_max_spread_pct);
      if (!tangled) continue;

      if (!(maS > maM && maM > maL)) continue;
      if (!(close >= maS && close >= maM && close >= maL)) continue;
      if (!(vol_ratio >= volume_multiplier)) continue;

      items.push({
        code,
        symbol: usedSymbol,
        name: "", // 先空，後面補
        close,
        ma_short: maS,
        ma_mid: maM,
        ma_long: maL,
        volume,
        vma,
        vol_ratio,
      });

      resolvedSymbols.push(usedSymbol);
    }

    // ✅ 中文備註：批次補名稱 + 繁中兜底
    const nameMap = resolvedSymbols.length ? await fetchYahooNames(resolvedSymbols) : new Map();
    for (const it of items) {
      const fromYahoo = nameMap.get(it.symbol) || "";
      const fallback = ZH_NAME_FALLBACK[it.code] || "";
      it.name = (fromYahoo && fromYahoo.trim()) ? fromYahoo.trim() : (fallback || it.code);
      delete it.symbol;
    }

    items.sort((a, b) => (b.vol_ratio || 0) - (a.vol_ratio || 0));

    const elapsed_sec = ((Date.now() - t0) / 1000).toFixed(2);

    const payload = {
      count: items.length,
      cached: false,
      elapsed_sec,
      items,
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
