// functions/api/scan.js
// 中文備註：Cloudflare Pages Function：/api/scan
// 功能：抓 Yahoo 日線 → 計算均線/量能 → 三線合一（進階）篩選 → 回傳前端
// 重點：使用 Rolling SMA（O(n)）避免 Top500 卡死

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

// 中文備註：回 JSON 工具
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

// 中文備註：股票池（V1：Top500 由你前端選，這邊先放預設示範，實務你會改成讀 Top500 清單）
// 先放少量避免你測試時爆量；你已經有 Top500 版本就把這邊替換成你的 Top500 清單即可
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

// 中文備註：抓 Yahoo chart（日線）
async function fetchYahooChart(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1y&interval=1d&includePrePost=false`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
      // 中文備註：這個很重要，很多台股名稱會因語系回傳英文，強制偏向 zh-TW
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
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

// 中文備註：批次抓名稱（Yahoo quote）
// 注意：加 Accept-Language，盡量拿到繁中名稱
async function fetchYahooNames(symbols) {
  const url =
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
  });

  if (!res.ok) return new Map();
  const data = await res.json();
  const list = data?.quoteResponse?.result || [];

  const map = new Map();
  for (const it of list) {
    if (!it?.symbol) continue;
    // 中文備註：優先取 Yahoo 給的中文名；沒有就退回 code
    const name = it.longName || it.shortName || "";
    map.set(it.symbol, name);
  }
  return map;
}

// 中文備註：Rolling SMA（O(n)）
// 回傳陣列：同長度，算不出來的位置為 null
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

// 中文備註：Rolling AVG（均量）同 SMA
function rollingAVG(values, window) {
  return rollingSMA(values, window);
}

// 中文備註：判斷糾結：最近 lookback 天，三線擴散 <= maxSpreadPct
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
    const spread = (mx - mn) / c; // 以收盤當分母
    if (spread > maxSpreadPct) return false;
  }
  return true;
}

// 中文備註：判斷均線轉強（避免只是剛好站上）
// slopeDays=3：MA長(今天) > MA長(3天前)
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

    // 中文備註：讀規則（維持你前端欄位）
    const ma_short = Math.floor(toNumber(rules.ma_short, 5));
    const ma_mid = Math.floor(toNumber(rules.ma_mid, 10));
    const ma_long = Math.floor(toNumber(rules.ma_long, 20));

    const tangle_lookback_days = Math.floor(toNumber(rules.tangle_lookback_days, 5));
    const tangle_max_spread_pct = toNumber(rules.tangle_max_spread_pct, 0.05); // 5% = 0.05

    const volume_multiplier = toNumber(rules.volume_multiplier, 0.8);
    const volume_ma_days = Math.floor(toNumber(rules.volume_ma_days, 60));

    const cache_ttl_seconds = Math.max(0, Math.floor(toNumber(rules.cache_ttl_seconds, 600)));

    // ✅ 新增（進階）：均線轉強、避免追高（先給預設，不破壞你前端）
    const slope_days = Math.floor(toNumber(rules.slope_days, 3));               // MA長轉強確認
    const max_extension_pct = toNumber(rules.max_extension_pct, 0.12);          // 與MA長乖離上限（12%）

    // 中文備註：快取 key（同規則 + 當日）
    const cacheKeyObj = {
      ma_short, ma_mid, ma_long,
      tangle_lookback_days,
      tangle_max_spread_pct,
      volume_multiplier,
      volume_ma_days,
      slope_days,
      max_extension_pct,
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
        } catch {
          // 中文備註：這個 symbol 失敗就試下一個
        }
      }

      if (!rows || !usedSymbol) continue;

      const closes = rows.map(r => r.close);
      const vols = rows.map(r => r.volume);

      const close = closes[closes.length - 1];
      const volume = vols[vols.length - 1];

      // 中文備註：先建 SMA series（O(n)）
      const maS_series = rollingSMA(closes, ma_short);
      const maM_series = rollingSMA(closes, ma_mid);
      const maL_series = rollingSMA(closes, ma_long);
      const vma_series = rollingAVG(vols, volume_ma_days);

      const maS = maS_series[maS_series.length - 1];
      const maM = maM_series[maM_series.length - 1];
      const maL = maL_series[maL_series.length - 1];
      const vma = vma_series[vma_series.length - 1];

      if (maS == null || maM == null || maL == null) continue;
      if (vma == null || vma <= 0) continue;

      const vol_ratio = volume / vma;

      // 1) 糾結
      const tangled = isTangledBySeries(
        closes, maS_series, maM_series, maL_series,
        tangle_lookback_days,
        tangle_max_spread_pct
      );
      if (!tangled) continue;

      // 2) 多頭排列
      if (!(maS > maM && maM > maL)) continue;

      // 3) 收盤站上三線
      if (!(close >= maS && close >= maM && close >= maL)) continue;

      // 4) 量能條件
      if (!(vol_ratio >= volume_multiplier)) continue;

      // ✅ 5) 新增：MA長轉強（避免只是剛好站上）
      if (!isTurningUp(maL_series, slope_days)) continue;

      // ✅ 6) 新增：避免追高乖離太大（close 不要離 MA長太遠）
      // (close - maL) / maL <= max_extension_pct
      const extension = (close - maL) / maL;
      if (extension > max_extension_pct) continue;

      items.push({
        code,
        symbol: usedSymbol,
        name: "",
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

    // 中文備註：批次補名稱（盡量拿繁中）
    const nameMap = resolvedSymbols.length ? await fetchYahooNames(resolvedSymbols) : new Map();
    for (const it of items) {
      const nm = nameMap.get(it.symbol) || "";
      // 中文備註：如果 Yahoo 還是吐英文，就先用代碼（避免 UI 很醜）
      it.name = nm ? nm : it.code;
      delete it.symbol;
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
