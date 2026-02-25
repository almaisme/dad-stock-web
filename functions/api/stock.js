export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const code = (url.searchParams.get("code") || "").trim();

  if (!/^\d{4,6}$/.test(code)) {
    return json({ ok: false, error: "請輸入正確股號（4~6 碼數字）" }, 400);
  }

  try {
    const rt = await fetchRealtime(code);

    if (!rt || !rt.ok) {
      return json({ ok: false, error: "查不到此股號，請確認是否為上市/上櫃股號" }, 404);
    }

    const daily = await fetchDailyLastMonths(code, rt.market, 3);
    const analysis = calcThreeLines(daily);

    return json({
      ok: true,
      code,
      market: rt.market,
      name: rt.name,
      realtime: {
        price: rt.price,
        change: rt.change,
        changePct: rt.changePct,
        time: rt.time,
      },
      daily: {
        count: daily.length,
        lastDate: daily.length ? daily[daily.length - 1].date : null,
      },
      threeLines: analysis,
    });
  } catch (e) {
    return json({ ok: false, error: `API 發生錯誤：${String(e?.message || e)}` }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function fetchRealtime(code) {
  const candidates = [
    { market: "tse", ex_ch: `tse_${code}.tw` },
    { market: "otc", ex_ch: `otc_${code}.tw` },
  ];

  for (const c of candidates) {
    const api = new URL("https://mis.twse.com.tw/stock/api/getStockInfo.jsp");
    api.searchParams.set("ex_ch", c.ex_ch);
    api.searchParams.set("json", "1");
    api.searchParams.set("delay", "0");

    const res = await fetch(api.toString(), {
      headers: {
        "user-agent": "Mozilla/5.0",
        "accept": "application/json,text/plain,*/*",
        "referer": "https://mis.twse.com.tw/stock/fibest.jsp",
      },
    });

    if (!res.ok) continue;
    const data = await res.json();
    const arr = data?.msgArray;
    if (!Array.isArray(arr) || arr.length === 0) continue;

    const item = arr[0];
    const name = item?.n || "";
    const priceStr = item?.z;
    const prevStr = item?.y;
    const time = `${item?.t || ""}`.trim();

    const price = toNum(priceStr);
    const prev = toNum(prevStr);

    if (!isFinite(price) || price <= 0) continue;

    const change = isFinite(prev) && prev > 0 ? round(price - prev, 2) : null;
    const changePct = isFinite(prev) && prev > 0 ? round(((price - prev) / prev) * 100, 2) : null;

    return {
      ok: true,
      market: c.market,
      name,
      price,
      change,
      changePct,
      time,
    };
  }

  return { ok: false };
}

async function fetchDailyLastMonths(code, market, months) {
  const now = new Date();
  const all = [];

  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const date = `${y}${m}01`;

    const url =
      market === "otc"
        ? `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${y}/${m}&stkno=${code}`
        : `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${date}&stockNo=${code}`;

    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) continue;

    const data = await res.json();

    if (market === "otc") {
      const aaData = data?.aaData;
      if (!Array.isArray(aaData)) continue;

      for (const row of aaData) {
        if (!Array.isArray(row) || row.length < 7) continue;
        const dateStr = row[0];
        const volume = toInt(row[1]);
        const close = toNum(row[6]);

        all.push({ date: dateStr, close, volume });
      }
    } else {
      const rows = data?.data;
      if (!Array.isArray(rows)) continue;

      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 7) continue;
        const dateStr = row[0];
        const volume = toInt(row[1]);
        const close = toNum(row[6]);

        all.push({ date: dateStr, close, volume });
      }
    }
  }

  const cleaned = all
    .filter((x) => isFinite(x.close) && x.close > 0 && isFinite(x.volume))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const dedup = [];
  const seen = new Set();
  for (const x of cleaned) {
    if (!seen.has(x.date)) {
      seen.add(x.date);
      dedup.push(x);
    }
  }

  return dedup.slice(Math.max(0, dedup.length - 80));
}

function calcThreeLines(daily) {
  if (!Array.isArray(daily) || daily.length < 25) {
    return { ok: false, reason: "日線資料不足（至少需要約 25 根 K）" };
  }

  const closes = daily.map((d) => d.close);
  const vols = daily.map((d) => d.volume);
  const last = daily[daily.length - 1];

  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);

  const ma5Prev = sma(closes.slice(0, -1), 5);
  const ma10Prev = sma(closes.slice(0, -1), 10);
  const ma20Prev = sma(closes.slice(0, -1), 20);

  const vol10 = sma(vols, 10);
  const todayVol = last.volume;

  const priceAbove = last.close > ma5 && last.close > ma10 && last.close > ma20;
  const arranged = ma5 > ma10 && ma10 > ma20;
  const trendingUp = ma5 > ma5Prev && ma10 > ma10Prev && ma20 > ma20Prev;
  const volOk = todayVol > vol10;

  const avg = (ma5 + ma10 + ma20) / 3;
  const spread = (Math.max(ma5, ma10, ma20) - Math.min(ma5, ma10, ma20)) / avg;
  const tangled = spread <= 0.01;

  const score =
    (priceAbove ? 1 : 0) +
    (arranged ? 1 : 0) +
    (trendingUp ? 1 : 0) +
    (volOk ? 1 : 0) +
    (tangled ? 1 : 0);

  return {
    ok: true,
    close: last.close,
    ma5: round(ma5, 2),
    ma10: round(ma10, 2),
    ma20: round(ma20, 2),
    tangled: { pass: tangled },
    arranged: { pass: arranged },
    trendingUp: { pass: trendingUp },
    priceAbove: { pass: priceAbove },
    volume: { pass: volOk },
    score,
    verdict:
      score >= 4
        ? "✅ 接近三線合一（偏多）"
        : score === 3
        ? "🟡 中性偏多"
        : "⚪ 尚未形成",
  };
}

function sma(arr, n) {
  const s = arr.slice(-n);
  const sum = s.reduce((a, b) => a + b, 0);
  return sum / n;
}

function toNum(x) {
  const s = String(x ?? "").replace(/,/g, "").trim();
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

function toInt(x) {
  const s = String(x ?? "").replace(/,/g, "").trim();
  const v = parseInt(s, 10);
  return Number.isFinite(v) ? v : NaN;
}

function round(x, d) {
  const p = 10 ** d;
  return Math.round(x * p) / p;
}
