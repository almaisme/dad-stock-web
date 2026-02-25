export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    // 假資料（先測試用）
    const fakeData = [
      {
        code: "2330",
        name: "台積電",
        close: 950,
        ma_short: 940,
        ma_mid: 930,
        ma_long: 900,
        volume: 20000,
        vma: 15000,
        vol_ratio: 1.33
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
        vol_ratio: 1.25
      }
    ];

    return new Response(JSON.stringify({
      count: fakeData.length,
      cached: false,
      elapsed_sec: 0.2,
      items: fakeData
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: err.message
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
