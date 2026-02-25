// functions/api/scan.js
// 中文備註：Cloudflare Pages Function（/api/scan）
// 目前先回傳假資料（確保前後端格式、表格顯示、流程都正常）
// 下一步再把假資料改成「真的掃描台股」即可

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export async function onRequest(context) {
  const { request } = context;

  // 中文備註：處理 CORS 預檢
  if (request.method === "OPTIONS") return json({ ok: true }, 200);

  // 中文備註：健康檢查（用瀏覽器直接開 /api/scan 會走 GET）
  if (request.method === "GET") {
    return json({ ok: true, message: "✅ /api/scan 正常（請用 POST 才會掃描）" }, 200);
  }

  // 中文備註：只允許 POST
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  const t0 = Date.now();

  try {
    const body = await request.json().catch(() => ({}));
    const rules = body?.rules || {};

    // 中文備註：假資料（先確保前端表格顯示正確）
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

    const elapsed_sec = Number(((Date.now() - t0) / 1000).toFixed(2));

    // 中文備註：統一回傳格式（前端依這格式渲染）
    return json({
      ok: true,
      receivedRules: rules, // 你要除錯可先留著，之後上線可移除
      count: items.length,
      cached: false,
      elapsed_sec,
      items,
    }, 200);

  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
