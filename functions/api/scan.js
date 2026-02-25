// functions/api/scan.js
// 中文備註：Cloudflare Pages Function - 掃描 API（先做最小可用版本，確認前端 POST 不再 Failed to fetch）
// 路徑：/api/scan
// 方法：POST（前端用 fetch('/api/scan', {method:'POST', body: JSON.stringify({rules})})）

function json(data, status = 200, extraHeaders = {}) {
  // 中文備註：統一回傳 JSON + CORS
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extraHeaders,
  };
  return new Response(JSON.stringify(data), { status, headers });
}

export async function onRequestOptions() {
  // 中文備註：處理 CORS preflight，避免瀏覽器擋請求
  return json({ ok: true }, 200);
}

export async function onRequestPost(context) {
  // 中文備註：前端會用 POST 丟 JSON，所以這裡要讀 body
  try {
    const req = context.request;

    // 中文備註：讀取 JSON body（沒有就給空物件）
    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // 中文備註：先回傳「確認 API 通了」＋把你送來的 rules echo 回去
    // 這一步先讓前端不再 Failed to fetch，並能看到成功回應。
    const rules = body.rules || {};

    return json({
      ok: true,
      message: "✅ /api/scan POST 正常（已接到 rules）",
      rules_received: rules,
      // 中文備註：先回空結果，下一步再把真正掃描邏輯接上
      cached: false,
      elapsed_sec: 0,
      count: 0,
      items: [],
    });
  } catch (e) {
    // 中文備註：任何錯誤都回 JSON，讓前端能顯示原因
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}

export async function onRequestGet() {
  // 中文備註：給你用瀏覽器直接打 /api/scan 測試用
  return json({
    ok: true,
    message: "✅ /api/scan GET 正常（請用 POST 才會帶 rules）",
  });
}
