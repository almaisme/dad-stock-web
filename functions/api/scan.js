// functions/api/scan.js
// 中文備註：Cloudflare Pages Function（/api/scan）
// 目標：回傳格式對齊前端 app.js：count/items/cached/elapsed_sec

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: corsHeaders });
}

export async function onRequest(context) {
  const { request } = context;

  // 中文備註：處理 CORS 預檢
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // 中文備註：健康檢查
  if (request.method === "GET") {
    return json({ ok: true, message: "✅ GET 正常（請用 POST 才會掃描）" });
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method Not Allowed" }, 405);
  }

  const t0 = Date.now();

  try {
    // 中文備註：前端送的是 { rules: {...} }
    const body = await request.json();
    const rules = body?.rules ?? body;

    // 中文備註：先回傳 stub（之後再把真正 Yahoo 掃描邏輯塞進來）
    const items = []; // TODO: 之後放掃出來的股票清單

    const elapsed_sec = ((Date.now() - t0) / 1000).toFixed(2);

    return json({
      ok: true,
      rules,           // 回給前端檢查用
      count: items.length,
      items,
      cached: false,
      elapsed_sec,
    });

  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, 500);
  }
}
