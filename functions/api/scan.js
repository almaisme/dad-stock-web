// functions/api/scan.js
// 中文備註：Cloudflare Pages Function（路徑：/api/scan）
// 目前先回「假資料」讓前端 UI/表格完整跑通
// 下一步再改成：真的去抓 Yahoo！股市資料，跑規則篩選

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export async function onRequest(context) {
  const { request } = context;

  // 中文備註：處理 CORS 預檢
  if (request.method === "OPTIONS") {
    return json({ ok: true }, 200);
  }

  // 中文備註：只允許 POST
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  const t0 = Date.now();

  try {
    // 中文備註：前端會送 { rules: {...} }
    const body = await request.json().catch(() => ({}));
    const rules = body?.rules || {};

    // 中文備註：假資料（你現在看到的 2330 / 2317 那組）
    const items = [
      {
        code: "2330",
        name: "台積電",
        close: 950,
        ma_short: 940,
        ma_mid: 930,
        ma_long: 900,
        volume: 20000,
        vma: 15000,
        vol_ratio: 1.33,
      },
      {
        code: "2317",
        name: "鴻海",
        close: 105,
        ma_short: 102,
        ma_mid: 100,
        ma_long: 98,
        volume: 50000,
        vma: 40000,
        vol_ratio: 1.25,
      },
    ];

    const elapsed_sec = ((Date.now() - t0) / 1000).toFixed(2);

    // 中文備註：把 rules 原樣回傳，方便你之後在 DevTools 看有沒有送對
    return json({
      ok: true,
      count: items.length,
      cached: false,
      elapsed_sec,
      receivedRules: rules,
      items,
    });

  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
