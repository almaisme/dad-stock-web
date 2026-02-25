// functions/api/scan.js
// 中文備註：Cloudflare Pages Function：/api/scan
// 功能：抓 Yahoo Finance 日線資料 → 計算均線/量比 → 依規則篩選 → 回傳給前端表格
// 進階：股票池 Top 500（自動抓名單），名稱強制繁中（TWSE 即時 API）
// 注意：外部來源可能偶爾擋請求，所以全程都有 fallback，避免整個流程掛掉

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

// ======================
// 0) Top 500 股票池（自動抓名單）
// ======================

// 中文備註：抓名單失敗時的保底股票池（至少可跑）
const FALLBACK_CODES = [
  "2330","2317","2454","2308","2412","2881","2882","2884","2886","2891",
  "1301","1303","2002","2603","2609","2615","3034","2303","3711","2382",
];

// 中文備註：嘗試抓上市公司名單（openapi.twse.com.tw）
// 來源可能會變動或偶爾擋，所以要 try/catch + fallback
async function fetchTWSEList() {
  const url = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
  if (!res.ok) throw new Error("TWSE list HTTP " + res.status);
  const data = await res.json();

  const out = [];
  for (const r of (Array.isArray(data) ? data : [])) {
    const code = (r["公司代號"] || r["公司代號\n"] || r["CompanyCode"] || r["SecuritiesCompanyCode"] || "").toString().trim();
    const name = (r["公司名稱"] || r["公司名稱\n"] || r["CompanyName"] || r["SecuritiesCompanyName"] || "").toString().trim();
    if (!/^\d{4}$/.test(code)) continue;
    out.push({ code, market: "TWSE", name: name || "" });
  }
  return out;
}

// 中文備註：嘗試抓上櫃公司名單（tpex.org.tw openapi）
// 同樣做容錯，抓不到就回空
async function fetchTPEXList() {
  const url = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
  if (!res.ok) throw new Error("TPEX list HTTP " + res.status);
  const data = await res.json();

  const out = [];
  for (const r of (Array.isArray(data) ? data : [])) {
    const code = (r["公司代號"] || r["CompanyCode"] || "").toString().trim();
    const name = (r["公司名稱"] || r["CompanyName"] || "").toString().trim();
    if (!/^\d{4}$/.test(code)) continue;
    out.push({ code, market: "TPEX", name: name || "" });
  }
  return out;
}

// 中文備註：Top 500 名單快取（每天更新一次）
async function getTop500Universe() {
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = "https://cache.local/universe?day=" + today;
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const txt = await hit.text();
    const obj = JSON.parse(txt);
    if (Array.isArray(obj?.list) && obj.list.length > 0) return obj.list;
  }

  let list = [];
  try {
    const [twse, tpex] = await Promise.allSettled([fetchTWSEList(), fetchTPEXList()]);
    const a = (twse.status === "fulfilled") ? twse.value : [];
    const b = (tpex.status === "fulfilled") ? tpex.value : [];
    list = [...a, ...b];

    const seen = new Set();
    list = list.filter(x => {
      if (seen.has(x.code)) return false;
      seen.add(x.code);
      return true;
    });

    list = list.slice(0, 500);

    const payload = { day: today, list };
    const res = new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    await cache.put(cacheKey, res);
    return list.length ? list : FALLBACK_CODES.map(code => ({ code, market: "TWSE", name: "" }));
  } catch {
    return FALLBACK_CODES.map(code => ({ code, market: "TWSE", name: "" }));
  }
}

// 中文備註：依市場轉 Yahoo symbol（上市 .TW，上櫃 .TWO）
function toYahooSymbol(code, market) {
  return market === "TPEX" ? `${code}.TWO` : `${code}.TW`;
}

// ======================
// 1) Yahoo 日線資料
// ======================

async function fetchYahooChart(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=6mo&interval=1d&includePrePost=false`;

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

// ======================
// 2) 名稱繁中：TWSE 即時 API（批次）
// ======================

async function fetchTWSEChineseNamesBatch(pairs) {
  const exCh = pairs.map(x => {
    const prefix = (x.market === "TPEX") ? "otc" : "tse";
    return `${prefix}_${x.code}.tw`;
  }).join("|");

  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
  });
  if (!res.ok) return new Map();

  const data = await res.json().catch(() => null);
  const list = data?.msgArray || [];
  const map = new Map();

  for (const it of list) {
    const code = (it?.c || "").toString().trim();
    const name = (it?.n || it?.nf || "").toString().trim();
    if (/^\d{4}$/.test(code) && name) map.set(code, name);
  }
  return map;
}

async function fillChineseNames(universe) {
  const nameMap = new Map();
  const chunkSize = 50;

  for (let i = 0; i < universe.length; i += chunkSize) {
    const chunk = universe.slice(i, i + chunkSize);
    try {
      const m = await fetchTWSEChineseNamesBatch(chunk);
      for (const [k, v] of m.entries()) nameMap.set(k, v);
    } catch {}
  }
  return nameMap;
}

// ======================
// 3) 技術指標：SMA / 均量 / 糾結判斷
// ======================

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

// ======================
// 4) 併發限制
// ======================

async function mapLimit(list, limit, mapper) {
  const ret = [];
  let idx = 0;

  const workers = Array.from({ length: limit }).map(async () => {
    while (idx < list.length) {
      const cur = idx++;
      try {
        ret[cur] = await mapper(list[cur], cur);
      } catch {
        ret[cur] = null;
      }
    }
  });

  await Promise.all(workers);
  return ret;
}

// ======================
// 5) 主入口
// ======================

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
    const tangle_max_spread_pct = toNumber(rules.tangle_max_spread_pct, 0.05);

    const volume_multiplier = toNumber(rules.volume_multiplier, 0.5);
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

    // ✅ 修正：快取命中時，把 cached 改成 true 再回（前端才會顯示「（快取）」）
    if (cache_ttl_seconds > 0) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const cachedText = await hit.text();
        try {
          const obj = JSON.parse(cachedText);
          obj.cached = true;
          // 中文備註：保持原結構，直接回 JSON
          return json(obj, 200, { "Cache-Control": `public, max-age=${cache_ttl_seconds}` });
        } catch {
          // 中文備註：若快取內容非 JSON（理論上不會），就原樣回
          return new Response(cachedText, { status: 200, headers: corsHeaders });
        }
      }
    }

    const universe = await getTop500Universe();
    const chineseNameMap = await fillChineseNames(universe);

    const results = await mapLimit(universe, 10, async (u) => {
      const code = u.code;
      const market = u.market;
      const symbol = toYahooSymbol(code, market);

      const rows = await fetchYahooChart(symbol);

      const closes = rows.map(r => r.close);
      const vols = rows.map(r => r.volume);

      const close = closes[closes.length - 1];
      const volume = vols[vols.length - 1];

      const maS = sma(closes, ma_short);
      const maM = sma(closes, ma_mid);
      const maL = sma(closes, ma_long);
      if (maS == null || maM == null || maL == null) return null;

      const vma = avg(vols, volume_ma_days);
      if (vma == null || vma <= 0) return null;
      const vol_ratio = volume / vma;

      const tangled = isTangled(closes, ma_short, ma_mid, ma_long, tangle_lookback_days, tangle_max_spread_pct);
      if (!tangled) return null;

      if (!(maS > maM && maM > maL)) return null;
      if (!(close >= maS && close >= maM && close >= maL)) return null;
      if (!(vol_ratio >= volume_multiplier)) return null;

      const zhName = chineseNameMap.get(code) || u.name || code;

      return {
        code,
        name: zhName,
        close,
        ma_short: maS,
        ma_mid: maM,
        ma_long: maL,
        volume,
        vma,
        vol_ratio,
      };
    });

    const items = results.filter(Boolean);
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
