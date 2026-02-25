// app.js
// 中文備註：前端邏輯，呼叫 Cloudflare Pages Function /api/scan

async function scan() {

  const btn = document.getElementById("scanBtn");
  const status = document.getElementById("status");
  const resultArea = document.getElementById("resultArea");

  btn.disabled = true;
  status.textContent = "搜尋中…";
  resultArea.innerHTML = "掃描中，請稍等…";

  try {

    const res = await fetch("/api/scan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        rules: {
          ma_short: 5,
          ma_mid: 10,
          ma_long: 20
        }
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "API 錯誤");
    }

    status.textContent = "完成 ✅";
    resultArea.innerHTML = `
      <pre>${JSON.stringify(data, null, 2)}</pre>
    `;

  } catch (err) {

    status.textContent = "失敗 ❌";
    resultArea.innerHTML = `
      <div style="color:red;">
        呼叫失敗：${err.message}
      </div>
    `;

  } finally {
    btn.disabled = false;
  }

}

window.scan = scan;
