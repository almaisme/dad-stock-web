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
  // 中文備註：均線輸入格式 "5,10,20"
  const maStr = (document.getElementById("maStr")?.value || "5,10,20").trim();
  const parts = maStr.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
  const [ma_short, ma_mid, ma_long] = (parts.length >= 3) ? parts : [5, 10, 20];

  // 中文備註：糾結參數（% 轉成小數）
  const tangle_lookback_days = toNumber(document.getElementById("tangleLookback")?.value, 5);
  const tangle_max_spread_pct = toNumber(document.getElementById("tangleSpreadPct")?.value, 3.0) / 100.0;

  // 中文備註：量能參數
  const volume_multiplier = toNumber(document.getElementById("volMultiplier")?.value, 0.8);
  const volume_ma_days = toNumber(document.getElementById("volMaDays")?.value, 10);

  // 中文備註：快取（分鐘 → 秒）
  const cacheMin = toNumber(document.getElementById("cacheMin")?.value, 20);
  const cache_ttl_seconds = Math.max(0, Math.floor(cacheMin * 60));

  // 中文備註：股票池 Top N
  const poolSize = toNumber(document.getElementById("poolSize")?.value, 500);

  return {
    ma_short, ma_mid, ma_long,
    tangle_lookback_days,
    tangle_max_spread_pct,
    volume_multiplier,
    volume_ma_days,
    cache_ttl_seconds,
    pool_size: poolSize,
  };
}

function renderRuleSummary(rules) {
  const ul = document.getElementById("ruleSummary");
  if (!ul) return;

  ul.innerHTML = `
    <li>股票池：Top ${rules.pool_size}（V1 先做穩、速度快）</li>
    <li>找出 ${rules.ma_short}/${rules.ma_mid}/${rules.ma_long} 日均線「糾結」後，且股價站上三線的股票。</li>
    <li>糾結：回看 ${rules.tangle_lookback_days} 天，三線最大擴散 ≤ ${(rules.tangle_max_spread_pct * 100).toFixed(2)}%。</li>
    <li>量能：今日量 ≥ ${rules.volume_ma_days} 日均量 × ${rules.volume_multiplier.toFixed(2)}。</li>
    <li>快取：${Math.round(rules.cache_ttl_seconds / 60)} 分鐘（避免一直掃被擋/變慢）。</li>
  `;
}

function setPill(type, text) {
  const pill = document.getElementById("statusPill");
  if (!pill) return;
  pill.className = `pillStatus ${type}`;
  pill.textContent = text;
}

function renderTable(items) {
  if (!items || items.length === 0) {
    return `<div class="mutedRow">沒有符合條件的標的（或資料來源暫時擋請求）。</div>`;
  }

  const rows = items.map(x => `
    <tr>
      <td><span class="codePill">${x.code}</span></td>
      <td>${x.name || x.code}</td>
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
    <div class="tableWrap">
      <table>
        <thead>
          <tr>
            <th>代碼</th>
            <th>名稱（繁中）</th>
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
  const statusText = document.getElementById("statusText");
  const resultArea = document.getElementById("resultArea");

  const rules = getRulesFromUI();
  renderRuleSummary(rules);

  btn.disabled = true;
  setPill("neutral", "掃描中…");
  statusText.textContent = "掃描中，請稍等…（Top 500 大概比較穩）";
  statusText.className = "statusText muted";
  resultArea.innerHTML = `<div class="mutedRow">掃描中，請稍等…</div>`;

  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

    const count = Number(data.count ?? 0);
    const cached = data.cached ? "（快取）" : "";
    const elapsed = data.elapsed_sec ? `　耗時：${data.elapsed_sec}s` : "";

    setPill("ok", `完成 ✅（符合 ${count}）`);
    statusText.textContent = `完成 ✅　符合：${count}　${cached}${elapsed}`.trim();
    statusText.className = "statusText";
    resultArea.innerHTML = renderTable(data.items || []);

  } catch (e) {
    setPill("err", "失敗 ❌");
    statusText.textContent = `呼叫失敗：${String(e?.message || e)}`;
    statusText.className = "statusText";
    resultArea.innerHTML = `<div class="mutedRow">呼叫失敗：${String(e?.message || e)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// 中文備註：初始化先渲染摘要
(function init() {
  try { renderRuleSummary(getRulesFromUI()); } catch {}
})();

// 中文備註：讓 onclick="scan()" 能呼叫
window.scan = scan;
