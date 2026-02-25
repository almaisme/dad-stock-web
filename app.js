// app.js
// 中文備註：前端邏輯（Cloudflare Pages + Functions）
// 重要：一律使用相對路徑 /api/scan，避免 https 頁面打到 http API 造成 Failed to fetch（混合內容被擋）

function toNumber(v, defVal) {
  const n = Number(v);
  return Number.isFinite(n) ? n : defVal;
}

function fmt(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return Number(n).toFixed(d);
}

function getRulesFromUI() {
  const maStr = (document.getElementById("maStr")?.value || "5,10,20").trim();
  const parts = maStr.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
  const [ma_short, ma_mid, ma_long] = (parts.length >= 3) ? parts : [5, 10, 20];

  const tangle_lookback_days = toNumber(document.getElementById("tangleLookback")?.value, 10);
  const tangle_max_spread_pct = toNumber(document.getElementById("tangleSpreadPct")?.value, 1.5) / 100.0;

  const volume_multiplier = toNumber(document.getElementById("volMultiplier")?.value, 1.0);
  const volume_ma_days = toNumber(document.getElementById("volMaDays")?.value, 10);

  const cacheMin = toNumber(document.getElementById("cacheMin")?.value, 10);
  const cache_ttl_seconds = Math.max(0, Math.floor(cacheMin * 60));

  return {
    ma_short, ma_mid, ma_long,
    tangle_lookback_days,
    tangle_max_spread_pct,
    volume_multiplier,
    volume_ma_days,
    cache_ttl_seconds,
  };
}

function renderTable(items) {
  if (!items || items.length === 0) {
    return `<div class="mutedRow">沒有符合條件的標的（或資料來源暫時擋請求）。</div>`;
  }

  const rows = items.map(x => `
    <tr>
      <td><span class="pill">${x.code}</span></td>
      <td>${x.name}</td>
      <td>${fmt(x.close, 2)}</td>
      <td>${fmt(x.ma_short, 2)}</td>
      <td>${fmt(x.ma_mid, 2)}</td>
      <td>${fmt(x.ma_long, 2)}</td>
      <td>${fmt(x.volume, 0)}</td>
      <td>${fmt(x.vma, 0)}</td>
      <td>${fmt(x.vol_ratio, 2)}</td>
    </tr>
  `).join("");

  return `
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>代碼</th>
            <th>名稱</th>
            <th>收盤</th>
            <th>MA短</th>
            <th>MA中</th>
            <th>MA長</th>
            <th>量</th>
            <th>均量</th>
            <th>量比</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function scan() {
  const btn = document.getElementById("scanBtn");
  const status = document.getElementById("status");
  const resultArea = document.getElementById("resultArea");

  btn.disabled = true;
  status.textContent = "搜尋中…";
  resultArea.innerHTML = `<div class="mutedRow">掃描中，請稍等…</div>`;

  try {
    const rules = getRulesFromUI();

    // ✅ 關鍵：用同網域相對路徑，避免 https -> http 被擋
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    status.textContent = `完成 ✅　符合：${data.count}　${data.cached ? "（快取）" : ""}${data.elapsed_sec ? "　耗時：" + data.elapsed_sec + "s" : ""}`;
    resultArea.innerHTML = renderTable(data.items);

  } catch (e) {
    status.textContent = "失敗 ❌";
    resultArea.innerHTML = `<div class="mutedRow">呼叫失敗：${String(e?.message || e)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// 中文備註：把 scan 掛到全域，讓 index.html 的按鈕 onclick="scan()" 能用
window.scan = scan;
