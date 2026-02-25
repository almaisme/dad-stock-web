document.addEventListener("DOMContentLoaded", function () {
  const analyzeBtn = document.getElementById("analyzeBtn");
  const stockInput = document.getElementById("stockInput");
  const resultBox = document.getElementById("resultBox");

  analyzeBtn.addEventListener("click", function () {
    const code = stockInput.value.trim();

    if (!code) {
      resultBox.innerHTML = "請輸入股票代號";
      return;
    }

    // 模擬分析邏輯（之後會接API）
    let message = `
      <div class="card">
        <div class="cardTitle">分析結果 - ${code}</div>
        <ul class="list">
          <li>目前趨勢：觀察中</li>
          <li>三線狀態：等待糾結</li>
          <li>成交量：尚未放大</li>
          <li>建議：不追高，等待訊號</li>
        </ul>
      </div>
    `;

    resultBox.innerHTML = message;
  });
});
