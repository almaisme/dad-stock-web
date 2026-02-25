// functions/api/scan.js
// 中文備註：Cloudflare Pages Function：/api/scan
// V1：固定 Top500 股票池（從 ISIN 抓全市場後切 Top500；抓不到就 fallback）
// 修正版重點：
// 1) ISIN 抓不到 → fallback（避免 universe=空導致 0.02s 秒回 0）
// 2) 不快取「太少/空的 universe」
// 3) 回傳 diag 診斷

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, ...extraHeaders },
  });
}

function toNumber(v, defVal) {
  const n = Number(v);
  return Number.isFinite(n) ? n : defVal;
}

// 中文備註：ISIN（上市/上櫃）
const ISIN_URLS = [
  "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2",
  "https://isin.twse.com.tw/isin/C_public.jsp?strMode=4",
];

// 中文備註：fallback（ISIN 掛掉時至少能掃）
const FALLBACK_CODES = [
  "2330","2317","2454","2308","2412","2881","2882","2884","2886","2891",
  "1301","1303","2002","2603","2609","2615","3034","2303","3711","2382",
  "5871","5880","1101","1216","3045","3008","2883","2885","2892","2357",
  "2379","3231","3661","6415","6505","5269","2207","2327","4938","2395"
];

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

    const m = td0.match(/^(\d{4})\s+(.+)$/);
    if (!m) continue;

    const code = m[1];
    const name = (m[2] || "").trim();
    if (!code || !name) continue;

    list.push({ code, name });
  }
  return list;
}

async function getUniverseFromIsin(context) {
  const cache = caches.default;
  const day = new Date().toISOString().slice(0, 10);
  const cacheKey = `https://cache.local/universe?d=${day}`;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const txt = await hit.text();
    const obj = JSON.parse(txt);
    return { ...obj, from_cache: true };
  }

  const diag = { isin_fetch: [], parsed_count: 0 };
  const merged = [];

  for (const url of ISIN_URLS) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      diag.isin_fetch.push({ url, ok: res.ok, status: res.status });
      if (!res.ok) continue;

      const html = await res.text();
      merged.push(...parseIsinHtmlToList(html));
    } catch (e) {
      diag.isin_fetch.push({ url, ok: false, status: "fetch_error" });
    }
  }

  const map = new Map();
  for (const it of merged) if (!map.has(it.code)) map.set(it.code, it.name);
  const universe = Array.from(map.entries()).map(([code, name]) => ({ code, name }));
  diag.parsed_count = universe.length;

  // ✅ 太少就不快取，直接 fallback
  if (universe.length < 100) {
    const fallback = FALLBACK_CODES.map(code => ({ code, name: code }));
    return { universe: fallback, from_cache: false, used_fallback: true, diag };
  }

  const payload = JSON.stringify({ universe, used_fallback: false, diag });
  const resp = new Response(payload, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=21600",
    },
  });
  context.waitUntil(cache.put(cacheKey, resp.clone()));

  return { universe, from_cache: false, used_fallback: false, diag };
}

// Yahoo
function buildSymbols(code) {
  return [`${code}.TW`, `${code}.TWO`];
}

async function fetchYahooChart(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1y&interval=1d&includePrePost=false`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
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
    rows.push({ close: Number(c), volume: Number(v) });
  }
  if (rows.length < 60) throw new Error("not enough data");
  return rows;
}

function sma(values, window) {
  if (values.length < window) return null;
  let sum = 0;
  for (let i = values.length - window; i < values.length; i++) sum += values[i];
  return sum / window;
}

function avg(values, window) {
  if (values.length < window) return null;
  let sum = 0;
  for (let i = values.length - window; i < values.length; i++) sum += values[i];
  return sum / window;
}

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

  if (request.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);

  const t0 = Date.now();

  try {
    const body = await request.json();
    const rules = body?.rules || {};

    const ma_short = toNumber(rules.ma_short, 5);
    const ma_mid = toNumber(rules.ma_mid, 10);
    const ma_long = toNumber(rules.ma_long, 20);

    const tangle_lookback_days = toNumber(rules.tangle_lookback_days, 5);
    const tangle_max_spread_pct = toNumber(rules.tangle_max_spread_pct, 0.03);

    const volume_multiplier = toNumber(rules.volume_multiplier, 0.8);
    const volume_ma_days = toNumber(rules.volume_ma_days, 10);

    const cache_ttl_seconds = Math.max(0, toNumber(rules.cache_ttl_seconds, 1200));

    // ✅ V1 固定 Top500
    const pool_size = 500;

    const day = new Date().toISOString().slice(0, 10);
    const cacheKeyObj = {
      ma_short, ma_mid, ma_long,
      tangle_lookback_days,
      tangle_max_spread_pct,
      volume_multiplier,
      volume_ma_days,
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

    const uni = await getUniverseFromIsin(context);
    const rawUniverse = uni?.universe || [];
    const universe = rawUniverse.slice(0, pool_size);

    const diag = {
      universe_total: rawUniverse.length,
      universe_used: universe.length,
      universe_from_cache: !!uni.from_cache,
      universe_used_fallback: !!uni.used_fallback,
      isin_diag: uni.diag || null,
      yahoo_ok: 0,
      yahoo_fail: 0,
    };

    const items = [];

    for (const { code, name } of universe) {
      const candidates = buildSymbols(code);
      let rows = null;

      for (const sym of candidates) {
        try {
          rows = await fetchYahooChart(sym);
          diag.yahoo_ok += 1;
          break;
        } catch (e) {}
      }

      if (!rows) {
        diag.yahoo_fail += 1;
        continue;
      }

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

      const tangled = isTangled(closes, ma_short, ma_mid, ma_long, tangle_lookback_days, tangle_max_spread_pct);
      if (!tangled) continue;

      if (!(maS > maM && maM > maL)) continue;
      if (!(close >= maS && close >= maM && close >= maL)) continue;
      if (!(vol_ratio >= volume_multiplier)) continue;

      items.push({
        code,
        name: name || code,
        close,
        ma_short: maS,
        ma_mid: maM,
        ma_long: maL,
        volume,
        vma,
        vol_ratio,
      });
    }

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
