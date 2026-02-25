// functions/api/scan.js

export async function onRequestGet(context) {
  return new Response(JSON.stringify({
    ok: true,
    message: "✅ /api/scan GET 正常 (請用 POST 才會帶 rules)"
  }), {
    headers: { "Content-Type": "application/json" }
  });
}

export async function onRequestPost(context) {
  try {
    const rules = await context.request.json();

    return new Response(JSON.stringify({
      ok: true,
      receivedRules: rules
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error.message
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
