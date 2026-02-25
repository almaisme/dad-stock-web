// functions/api/scan.js
// 中文備註：Cloudflare Pages Function（路由：/api/scan）
// 先回假資料，確保前端 UI、表格、流程全部正常
// 下一步再改成真的抓 Yahoo！股市資料

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

  // 中文備註：用瀏覽器直接開 /api/scan 會走 GET，用來測試 API 是否存在
  if (request.method === "GET") {
    return json({ ok: true, message: "✅ /api/scan 正常（請用 POST 才會回結果）" }, 200);
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  const t0 = Date.now();

  try {
    const body = await request.json().catch(() => ({}));
    const rules = body?.rules || {};

    // 中文備註：假資料（先確保 UI 100% 跑起來）
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

    return json({
      ok: true,
      count: items.length,
      cached: false,
      elapsed_sec,
      items,
      receivedRules: rules
    }, 200);

  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
