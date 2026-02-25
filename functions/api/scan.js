// functions/api/scan.js
// 中文備註：Cloudflare Pages Function：/api/scan
// V1 Top500（或你的股票池）掃描：Yahoo（日線/量） + ISIN（繁中名稱）
// A 精準版規則：
// 1) 三線糾結（你原本的）
// 2) 均線多頭排列（短 > 中 > 長）
// 3) 收盤站上三線「站穩確認」：連續 confirm_days 天都站上三線
// 4) 量能：量比 >= max(volume_multiplier, min_vol_ratio)
// 5) 均線轉強：MA中、MA長最近 slope_days 天上升
// 6) 乖離控制：收盤相對 MA長乖離 <= max_extension_pct
//
// 重要：維持用相對路徑 /api/scan 呼叫即可

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

// ============================
// ① 名稱來源：ISIN（繁中）
// ============================
const ISIN_URLS = [
  // 中文備註：上市
  "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2",
  // 中文備註：上櫃
  "https://isin.twse.com.tw/isin/C_public.jsp?strMode=4",
];

// 中文備註：解析 ISIN HTML → [{code,name}]
function parseIsinHtmlToList(html) {
  const list = [];
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    const tds = tr.match(/<td[\s\S]*?<\/td>/gi) || [];
    if (tds.length < 1) continue;

    const txt = tds[0]
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const m = txt.match(/^(\d{4})\s+(.+)$/);
    if (!m) continue;

    const code = m[1];
    const name = (m[2] || "").trim();
    if (!code || !name) continue;

    list.push({ code, name });
  }
  return list;
}

// 中文備註：抓 ISIN，並做快取（避免每次掃描都重新抓）
// 快取 24 小時
async function getIsinNameMap() {
  const cache = caches.default;
  const day = new Date().toISOString().slice(0, 10);
  const cacheKey = `https://cache.local/isin-name-map?day=${day}`;

  const hit = await cache.match(cacheKey);
  if (hit) {
    try {
      const text = await hit.text();
      const obj = JSON.parse(text);
      const map = new Map(Object.entries(obj));
      return map;
    } catch {
      // 中文備註：解析失敗就當沒快取
    }
  }

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

  // 中文備註：寫入快取（24H）
  try {
    const obj = Object.fromEntries(map.entries());
    const payload = JSON.stringify(obj);
    const resp = new Response(payload, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      },
    });
    // 中文備註：非同步寫快取
    cache.put(cacheKey, resp.clone());
  } catch {}

  return map;
}

// ============================
// ② 股票池（Top500 / 你的清單）
// ============================
// 中文備註：你已經有 Top500 版本就用你自己的 Top500 清單覆蓋這裡
// 這裡先放示範（你原本的 20 檔），避免你測試時太慢
const UNIVERSE_CODES = [
  "2330", "2317", "2454", "2308", "2412",
  "2881", "2882", "2884", "2886", "2891",
  "1301", "1303", "2002", "2603", "2609",
  "2615", "3034", "2303", "3711", "2382",
];

// 中文備註：把 2330 轉成 Yahoo symbol（先試 .TW，失敗再試 .TWO）
function buildSymbols(code) {
  return [`${code}.TW`, `${code}.TWO`];
}

// ============================
// ③ Yahoo 抓日線（行情來源）
// ============================
// range 先用 1y，夠算 20MA + lookback
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
  if (!result || err) throw new Error(`chart error`);

  const ts = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  // 中文備註：過濾 null
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    const v = volumes[i];
    if (c == null || v == null) continue;
    rows.push({ t: ts[i], close: Number(c), volume: Number(v) });
  }

  if (rows.length < 80) throw new Error("not enough data");
  return rows;
}

// ============================
// ④ Rolling SMA / AVG（O(n)）
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

// 中文備註：判斷「三線糾結」：最近 lookback 天內，三條均線最大擴散 <= 閾值
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

// 中文備註：判斷均線是否上升（slopeDays=3：今天 > 3天前）
function isRising(series, slopeDays) {
  const n = series.length;
  const i0 = n - 1;
  const i1 = n - 1 - Math.max(1, slopeDays);
  if (i1 < 0) return false;

  const a = series[i0];
  const b = series[i1];
  if (a == null || b == null) return false;
  return a > b;
}

// 中文備註：連續 confirmDays 天「收盤站上三線」
function isAboveAllMAsForDays(closes, maS, maM, maL, confirmDays) {
  const n = closes.length;
  if (confirmDays <= 1) confirmDays = 1;
  if (n < confirmDays) return false;

  for (let k = 0; k < confirmDays; k++) {
    const i = n - 1 - k;
    const c = closes[i];
    const s = maS[i], m = maM[i], l = maL[i];
    if (c == null || s == null || m == null || l == null) return false;
    if (!(c >= s && c >= m && c >= l)) return false;
  }
  return true;
}

export async function onRequest(context) {
  const { request } = context;

  // 中文備註：CORS 預檢
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // 中文備註：健康檢查
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

    // 中文備註：讀規則（沿用你前端欄位）
    const ma_short = Math.floor(toNumber(rules.ma_short, 5));
    const ma_mid = Math.floor(toNumber(rules.ma_mid, 10));
    const ma_long = Math.floor(toNumber(rules.ma_long, 20));

    const tangle_lookback_days = Math.floor(toNumber(rules.tangle_lookback_days, 10));
    const tangle_max_spread_pct = toNumber(rules.tangle_max_spread_pct, 0.05); // 5%（比你之前 1.5% 寬鬆）

    const volume_multiplier = toNumber(rules.volume_multiplier, 1.0);
    const volume_ma_days = Math.floor(toNumber(rules.volume_ma_days, 10));

    const cache_ttl_seconds = Math.max(0, Math.floor(toNumber(rules.cache_ttl_seconds, 600)));

    // ✅ A 精準版新增/預設（不需要你改 UI 也會生效）
    const confirm_days = Math.floor(toNumber(rules.confirm_days, 2));        // 站穩確認：2天
    const slope_days = Math.floor(toNumber(rules.slope_days, 3));            // 均線轉強：3天
    const min_vol_ratio = toNumber(rules.min_vol_ratio, 1.2);                // 量比至少 1.2
    const max_extension_pct = toNumber(rules.max_extension_pct, 0.10);        // 乖離上限：10%

    // 中文備註：快取 key（同一組規則在 TTL 內就直接回）
    const cacheKeyObj = {
      ma_short, ma_mid, ma_long,
      tangle_lookback_days, tangle_max_spread_pct,
      volume_multiplier, volume_ma_days,
      confirm_days, slope_days, min_vol_ratio, max_extension_pct,
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

    // 中文備註：ISIN 名稱對照（繁中）
    const isinNameMap = await getIsinNameMap();

    const items = [];

    for (const code of UNIVERSE_CODES) {
      const candidates = buildSymbols(code);

      let rows = null;

      for (const sym of candidates) {
        try {
          rows = await fetchYahooChart(sym);
          break;
        } catch {
          // 中文備註：失敗就試下一個 symbol
        }
      }

      if (!rows) continue;

      const closes = rows.map(r => r.close);
      const vols = rows.map(r => r.volume);

      // 中文備註：rolling series
      const maS_series = rollingSMA(closes, ma_short);
      const maM_series = rollingSMA(closes, ma_mid);
      const maL_series = rollingSMA(closes, ma_long);
      const vma_series = rollingSMA(vols, volume_ma_days);

      const close = closes[closes.length - 1];
      const volume = vols[vols.length - 1];

      const maS = maS_series[maS_series.length - 1];
      const maM = maM_series[maM_series.length - 1];
      const maL = maL_series[maL_series.length - 1];
      const vma = vma_series[vma_series.length - 1];

      if (maS == null || maM == null || maL == null) continue;
      if (vma == null || vma <= 0) continue;

      const vol_ratio = volume / vma;

      // 1) 糾結
      const tangled = isTangledBySeries(
        closes,
        maS_series, maM_series, maL_series,
        tangle_lookback_days,
        tangle_max_spread_pct
      );
      if (!tangled) continue;

      // 2) 多頭排列（短 > 中 > 長）
      if (!(maS > maM && maM > maL)) continue;

      // 3) 站穩：連續 confirm_days 天站上三線
      if (!isAboveAllMAsForDays(closes, maS_series, maM_series, maL_series, confirm_days)) continue;

      // 4) 量能：量比 >= max(volume_multiplier, min_vol_ratio)
      const needVol = Math.max(volume_multiplier, min_vol_ratio);
      if (!(vol_ratio >= needVol)) continue;

      // 5) 均線轉強：MA中、MA長都要上升
      if (!isRising(maM_series, slope_days)) continue;
      if (!isRising(maL_series, slope_days)) continue;

      // 6) 乖離控制：close 相對 MA長不要太遠
      const extension = (close - maL) / maL;
      if (extension > max_extension_pct) continue;

      // 中文備註：名稱用 ISIN（永遠繁中），拿不到就退回代碼
      const name = isinNameMap.get(code) || code;

      items.push({
        code,
        name,
        close,
        ma_short: maS,
        ma_mid: maM,
        ma_long: maL,
        volume,
        vma,
        vol_ratio,
      });
    }

    // 中文備註：排序（量比由大到小）
    items.sort((a, b) => (b.vol_ratio || 0) - (a.vol_ratio || 0));

    const elapsed_sec = ((Date.now() - t0) / 1000).toFixed(2);

    const payload = {
      count: items.length,
      cached: false,
      elapsed_sec,
      items,
    };

    // 中文備註：寫入快取
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
