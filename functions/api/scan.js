// functions/api/scan.js
// 中文備註：Cloudflare Pages Function：/api/scan
// 功能：抓 Yahoo Finance 日線資料 → 計算均線/量比 → 依規則篩選 → 回傳給前端表格
// 重點修正：名稱不要再用 quote API（常被擋），改從 chart API 的 meta.shortName/longName 取得

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

// 中文備註：把 2330 轉成 Yahoo symbol（先試 .TW，失敗再試 .TWO）
function buildSymbols(code) {
  return [`${code}.TW`, `${code}.TWO`];
}

// 中文備註：抓 Yahoo 日線（用 chart API）
// range 用 1y，足夠算 20MA + lookback
// ✅ 這裡同時回傳 metaName（用來顯示「名稱」）
async function fetchYahooChart(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1y&interval=1d&includePrePost=false`;

  const res = await fetch(url, {
    headers: {
      // 中文備註：加 UA 有時比較不容易被擋
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  if (!res.ok) throw new Error(`chart HTTP ${res.status}`);
  const data = await res.json();

  const result = data?.chart?.result?.[0];
  const err = data?.chart?.error;
  if (!result || err) throw new Error(`chart error: ${err?.description || "no result"}`);

  // ✅ 中文備註：名稱直接從 chart meta 拿（成功率高）
  const meta = result.meta || {};
  const metaName = meta.shortName || meta.longName || "";

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

  if (rows.length < 60) throw new Error("not enough data");
  return { rows, metaName };
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

// 中文備註：判斷「三線糾結」：最近 lookback 天內，三條均線的最大擴散 <= 閾值
function isTangled(closes, maS, maM, maL, lookbackDays, maxSpreadPct) {
  const n = closes.length;
  const start = Math.max(0, n - lookbackDays);

  for (let i = start; i < n; i++) {
    // 中文備註：每一天都要能算出三條 MA
    const slice = closes.slice(0, i + 1);
    const s = sma(slice, maS);
    const m = sma(slice, maM);
    const l = sma(slice, maL);
    if (s == null || m == null || l == null) return false;

    const mx = Math.max(s, m, l);
    const mn = Math.min(s, m, l);
    const c = closes[i] || 0;
    if (c <= 0) return false;

    const spread = (mx - mn) / c; // 中文備註：以收盤價當分母
    if (spread > maxSpreadPct) return false;
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

    // 中文備註：讀規則（跟你 app.js 的 rules 欄位一致）
    const ma_short = toNumber(rules.ma_short, 5);
    const ma_mid = toNumber(rules.ma_mid, 10);
    const ma_long = toNumber(rules.ma_long, 20);

    const tangle_lookback_days = toNumber(rules.tangle_lookback_days, 10);
    const tangle_max_spread_pct = toNumber(rules.tangle_max_spread_pct, 0.015); // 小數（1.5% = 0.015）

    const volume_multiplier = toNumber(rules.volume_multiplier, 1.0);
    const volume_ma_days = toNumber(rules.volume_ma_days, 10);

    const cache_ttl_seconds = Math.max(0, toNumber(rules.cache_ttl_seconds, 600));

    // 中文備註：快取 key（同一組規則在 TTL 內就直接回）
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

    for (const code of UNIVERSE_CODES) {
      const candidates = buildSymbols(code);

      let rows = null;
      let usedSymbol = null;
      let nameFromMeta = "";

      for (const sym of candidates) {
        try {
          const got = await fetchYahooChart(sym);
          rows = got.rows;
          usedSymbol = sym;
          nameFromMeta = got.metaName || "";
          break;
        } catch (e) {
          // 中文備註：這個 symbol 失敗就試下一個
        }
      }

      if (!rows || !usedSymbol) continue;

      const closes = rows.map(r => r.close);
      const vols = rows.map(r => r.volume);

      // 中文備註：今日數據
      const close = closes[closes.length - 1];
      const volume = vols[vols.length - 1];

      // 中文備註：今日三條 MA
      const maS = sma(closes, ma_short);
      const maM = sma(closes, ma_mid);
      const maL = sma(closes, ma_long);
      if (maS == null || maM == null || maL == null) continue;

      // 中文備註：均量 + 量比
      const vma = avg(vols, volume_ma_days);
      if (vma == null || vma <= 0) continue;
      const vol_ratio = volume / vma;

      // ✅ 篩選條件
      // 1) 三線糾結
      const tangled = isTangled(
        closes,
        ma_short,
        ma_mid,
        ma_long,
        tangle_lookback_days,
        tangle_max_spread_pct
      );
      if (!tangled) continue;

      // 2) 均線多頭排列（短 > 中 > 長）
      if (!(maS > maM && maM > maL)) continue;

      // 3) 收盤站上三線
      if (!(close >= maS && close >= maM && close >= maL)) continue;

      // 4) 量能條件
      if (!(vol_ratio >= volume_multiplier)) continue;

      items.push({
        code,
        // ✅ 中文備註：名稱直接用 chart meta 的 shortName/longName（沒拿到才退回代碼）
        name: (nameFromMeta && String(nameFromMeta).trim()) ? String(nameFromMeta).trim() : code,
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
