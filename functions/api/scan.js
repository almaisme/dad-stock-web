// functions/api/scan.js
// 中文備註：Cloudflare Pages Function：/api/scan
// 功能：
// 1) 先抓「證交所/櫃買 ISIN 清單」→ 取得【股票代碼 + 繁體中文名稱】
// 2) 再用 Yahoo chart API 抓日線 → 算均線/糾結/量比 → 篩選
// 3) 股票池先做 Top N（預設 500）避免超時；V2 再做全市場分批/排程

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// 中文備註：回 JSON 小工具
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

// ==============================
// 中文備註：1) 取得股票代碼＋繁中名稱（ISIN 清單）
// ==============================

// 中文備註：ISIN 清單（上市/上櫃）
// 上市：strMode=2，上櫃：strMode=4
const ISIN_URLS = [
  "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2",
  "https://isin.twse.com.tw/isin/C_public.jsp?strMode=4",
];

// 中文備註：從「有價證券代號及名稱」欄位抓出：例如 "2330 台積電"
function parseIsinHtmlToList(html) {
  const list = [];

  // 取出所有 <tr> ... </tr>
  const trMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trMatches) {
    // 抓所有 <td> ... </td>
    const tds = tr.match(/<td[\s\S]*?<\/td>/gi) || [];
    if (tds.length < 1) continue;

    // 第 1 欄通常是「有價證券代號及名稱」
    const td0 = tds[0]
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // 只收「4 碼股票代號」：例如 "2330 台積電"
    const m = td0.match(/^(\d{4})\s+(.+)$/);
    if (!m) continue;

    const code = m[1];
    const name = (m[2] || "").trim();

    // 中文備註：排除權證/奇怪代碼（通常不是 4 碼就已經被擋掉）
    if (!code || !name) continue;

    list.push({ code, name });
  }

  return list;
}

// 中文備註：抓 ISIN 清單並做快取（避免每次掃都打 ISIN）
async function getUniverseFromIsin(context, ttlSec = 6 * 60 * 60) {
  const cache = caches.default;
  const day = new Date().toISOString().slice(0, 10);
  const cacheKey = `https://cache.local/universe?d=${day}`;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const txt = await hit.text();
    return JSON.parse(txt);
  }

  const merged = [];
  for (const url of ISIN_URLS) {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) continue;
    const html = await res.text();
    merged.push(...parseIsinHtmlToList(html));
  }

  // 中文備註：去重（同代碼只留第一個）
  const map = new Map();
  for (const it of merged) {
    if (!map.has(it.code)) map.set(it.code, it.name);
  }

  const universe = Array.from(map.entries()).map(([code, name]) => ({ code, name }));

  // 中文備註：寫入快取
  const payload = JSON.stringify({ universe });
  const resp = new Response(payload, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttlSec}` },
  });
  context.waitUntil(cache.put(cacheKey, resp.clone()));

  return { universe };
}

// ==============================
// 中文備註：2) Yahoo 日線資料（用來算 MA）
// ==============================

// 中文備註：把 2330 轉成 Yahoo symbol（先試 .TW，失敗再試 .TWO）
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

// 中文備註：判斷「三線糾結」：最近 lookback 天內，三條均線最大擴散 <= 閾值
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

// ==============================
// 中文備註：3) API Handler
// ==============================

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

    // 中文備註：規則（跟 app.js 一致）
    const ma_short = toNumber(rules.ma_short, 5);
    const ma_mid = toNumber(rules.ma_mid, 10);
    const ma_long = toNumber(rules.ma_long, 20);

    const tangle_lookback_days = toNumber(rules.tangle_lookback_days, 5);
    const tangle_max_spread_pct = toNumber(rules.tangle_max_spread_pct, 0.03);

    const volume_multiplier = toNumber(rules.volume_multiplier, 0.8);
    const volume_ma_days = toNumber(rules.volume_ma_days, 10);

    const cache_ttl_seconds = Math.max(0, toNumber(rules.cache_ttl_seconds, 1200));
    const pool_size = Math.max(50, Math.min(1200, toNumber(rules.pool_size, 500)));

    // 中文備註：結果快取（同一組規則 + 同一天）
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

    // 中文備註：先拿「繁中名稱」的股票清單（上市+上櫃）
    const uni = await getUniverseFromIsin(context);
    const universe = (uni?.universe || []).slice(0, pool_size); // 中文備註：Top N（V1 先做穩）

    const items = [];

    // 中文備註：逐檔掃描（V1：Top500）
    for (const { code, name } of universe) {
      const candidates = buildSymbols(code);

      let rows = null;
      for (const sym of candidates) {
        try {
          rows = await fetchYahooChart(sym);
          break;
        } catch (e) {
          // 中文備註：試下一個市場別
        }
      }
      if (!rows) continue;

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

      // 條件 1：三線糾結
      const tangled = isTangled(closes, ma_short, ma_mid, ma_long, tangle_lookback_days, tangle_max_spread_pct);
      if (!tangled) continue;

      // 條件 2：均線多頭排列
      if (!(maS > maM && maM > maL)) continue;

      // 條件 3：收盤站上三線
      if (!(close >= maS && close >= maM && close >= maL)) continue;

      // 條件 4：量能
      if (!(vol_ratio >= volume_multiplier)) continue;

      items.push({
        code,
        name, // ✅ 中文備註：這裡就是繁體中文名稱
        close,
        ma_short: maS,
        ma_mid: maM,
        ma_long: maL,
        volume,
        vma,
        vol_ratio,
      });
    }

    // 中文備註：量比由大到小
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
