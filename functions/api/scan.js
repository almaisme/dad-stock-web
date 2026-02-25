// functions/api/scan.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

export async function onRequest(context) {

  // 處理 CORS 預檢
  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (context.request.method === "GET") {
    return new Response(JSON.stringify({
      ok: true,
      message: "✅ GET 正常"
    }), { headers: corsHeaders });
  }

  if (context.request.method === "POST") {
    try {
      const rules = await context.request.json();

      return new Response(JSON.stringify({
        ok: true,
        receivedRules: rules
      }), { headers: corsHeaders });

    } catch (err) {
      return new Response(JSON.stringify({
        ok: false,
        error: err.message
      }), { status: 500, headers: corsHeaders });
    }
  }

  return new Response("Method Not Allowed", { status: 405 });
}
