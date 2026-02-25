// app.js
// 中文備註：前端邏輯（Cloudflare Pages + Functions）
// 重要：一律使用相對路徑 /api/scan，避免混合內容

function toNumber(v, defVal) {
  const n = Number(v);
  return Number.isFinite(n) ? n : defVal;
}

function fmt(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return Number(n).toFixed(d);
}

// 中文備註：從 UI 讀取規則
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

// 中文備註：渲染表格（長得像你要的那種清單）
function renderTable(items) {
  if (!items || items.length === 0) {
    return `<div class="muted">沒有符合條件的標的（或資料來源暫時擋請求）。</div>`;
  }

  const rows = items.map(x => `
    <tr>
      <td><span class="pill">${x.code ?? "-"}</span></td>
      <td>${x.name ?? "-"}</td>
      <td class="num">${fmt(x.close, 2)}</td>
      <td class="num">${fmt(x.ma_short, 2)}</td>
      <td class="num">${fmt(x.ma_mid, 2)}</td>
      <td class="num">${fmt(x.ma_long, 2)}</td>
      <td class="num">${fmt(x.volume, 0)}</td>
      <td class="num">${fmt(x.vma, 0)}</td>
      <td class="num">${fmt(x.vol_ratio, 2)}</td>
    </tr>
  `).join("");

  return `
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>代碼</th>
            <th>名稱</th>
            <th class="num">收盤</th>
            <th class="num">MA短</th>
            <th class="num">MA中</th>
            <th class="num">MA長</th>
            <th class="num">量</th>
            <th class="num">均量</th>
            <th class="num">量比</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// 中文備註：更新右上角狀態（尚未/成功/失敗）
function setBadge(type, text) {
  const badge = document.getElementById("statusBadge");
  if (!badge) return;
  badge.className = `badge ${type}`;
  badge.textContent = text;
}

async function scan() {
  const btn = document.getElementById("scanBtn");
  const resultArea = document.getElementById("resultArea");

  btn.disabled = true;
  setBadge("neutral", "搜尋中…");
  resultArea.innerHTML = `<div class="muted">掃描中，請稍等…</div>`;

  try {
    const rules = getRulesFromUI();

    // ✅ 關鍵：永遠用相對路徑
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    const msg = `完成 ✅（符合 ${data.count ?? 0}）${data.cached ? "（快取）" : ""}`;
    setBadge("ok", msg);

    resultArea.innerHTML = renderTable(data.items);

  } catch (e) {
    setBadge("bad", "失敗 ❌");
    resultArea.innerHTML = `<div class="muted">呼叫失敗：${String(e?.message || e)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// 中文備註：掛到全域，讓 onclick="scan()" 可用
window.scan = scan;
