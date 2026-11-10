/**
 * ==============================================================================
 * 檔案名稱：app.js
 * 專案名稱：就學貸款審查結果線上查詢系統 - 前端互動邏輯腳本
 * 說明：
 *    本腳本負責接收使用者輸入之學生學號，透過 Fetch API 發送非同步請求至
 *    Google Apps Script Web App 端點，動態更新查詢結果卡片。
 * ==============================================================================
 */

/**
 * 【重要設定】Google Apps Script 部署之 Web App 應用程式網址
 * 說明：串接後端 Google 試算表就貸審查結果查詢 API
 */
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbxca-L0Nwdb5IrfiJrU1PQ1MSZvoAHcJvxXNWNf1SQ350U_KJ8ZaEsgQKwmxCXcuTWPRg/exec";


/**
 * 函式名稱：handleSearch
 * 用途說明：
 *    處理使用者提交學號查詢表單之事件處理器。
 *    執行防呆驗證、顯示載入中動畫、呼叫 GAS 後端 API、渲染結果卡片或錯誤提示。
 * 參數 (Parameters)：
 *    @param {Event} event - 表單送出事件物件。
 * 回傳值 (Returns)：
 *    無
 */
async function handleSearch(event) {
  // 阻止瀏覽器預設的表單重新整理換頁行為
  event.preventDefault();

  const studentIdInput = document.getElementById("studentIdInput");
  const searchBtn = document.getElementById("searchBtn");
  const btnText = searchBtn.querySelector(".btn-text");
  const btnLoader = searchBtn.querySelector(".btn-loader");
  
  const resultSection = document.getElementById("resultSection");
  const errorSection = document.getElementById("errorSection");
  const errorMessage = document.getElementById("errorMessage");

  // 取得使用者輸入並清理前後空白、統一轉為大寫學號
  const studentId = studentIdInput.value.trim().toUpperCase();

  if (!studentId) {
    showError("請輸入有效的學生學號！");
    return;
  }

  // 隱藏前次查詢結果與錯誤訊息
  resultSection.style.display = "none";
  errorSection.style.display = "none";

  // 切換按鈕為「載入中」狀態
  searchBtn.disabled = true;
  btnText.style.display = "none";
  btnLoader.style.display = "inline";

  try {
    // 組合請求 API 網址，帶入 action=query 與 student_id
    const apiUrl = `${GAS_WEB_APP_URL}?action=query&student_id=${encodeURIComponent(studentId)}`;

    // 發送非同步 HTTP GET 請求
    const response = await fetch(apiUrl, {
      method: "GET",
      mode: "cors" // 支援跨來源資源共享
    });

    if (!response.ok) {
      throw new Error(`伺服器連線異常 (HTTP ${response.status})`);
    }

    const resJson = await response.json();

    // 處理 API 回傳結果
    if (resJson.status === "success" && resJson.data) {
      renderResult(resJson.data);
    } else if (resJson.status === "not_found") {
      showError(resJson.message || "查無此學號之就貸審查資料，請確認學號是否正確或尚未完成表單填報。");
    } else {
      showError(resJson.message || "查詢過程發生異常，請稍後再試。");
    }

  } catch (error) {
    console.error("查詢請求失敗：", error);
    showError("無法連線至審查伺服器，請檢查網路連線或稍後再試。");
  } finally {
    // 復原按鈕狀態
    searchBtn.disabled = false;
    btnText.style.display = "inline";
    btnLoader.style.display = "none";
  }
}


/**
 * 函式名稱：renderResult
 * 用途說明：
 *    將後端回傳之審查資料渲染至畫面的卡片元件中。
 * 參數 (Parameters)：
 *    @param {Object} data - 後端回傳之學生審查資料物件。
 *        - year (string): 學年度
 *        - semester (string): 學期
 *        - student_class (string): 班級
 *        - student_id (string): 學號
 *        - student_name (string): 遮罩後姓名 (如：周○真)
 *        - review_result (string): 審查結果字串
 *        - review_time (string): 審查時間
 * 回傳值 (Returns)：
 *    無
 */
function renderResult(data) {
  const resultSection = document.getElementById("resultSection");
  const resultBadge = document.getElementById("resultBadge");
  const resSerialNo = document.getElementById("resSerialNo");
  const resTerm = document.getElementById("resTerm");
  const resClass = document.getElementById("resClass");
  const resStudentId = document.getElementById("resStudentId");
  const resName = document.getElementById("resName");
  const resDetail = document.getElementById("resDetail");
  const resTime = document.getElementById("resTime");

  // 填入各項文字資訊
  if (resSerialNo) resSerialNo.textContent = data.serial_no || "-";
  resTerm.textContent = `${data.year || ""} 學年度 ${data.semester || ""}`;
  resClass.textContent = data.student_class || "-";
  resStudentId.textContent = data.student_id || "-";
  resName.textContent = data.student_name || "-";
  resTime.textContent = data.review_time || "-";

  const resultText = data.review_result || "";
  const isPass = resultText === "審查通過";

  // 根據審查通過與否切換樣式與標籤
  if (isPass) {
    resultBadge.textContent = "✓ 審查通過";
    resultBadge.className = "status-badge pass";
    resDetail.textContent = "恭喜！您的就學貸款申請資料經系統勾稽全數相符，已完成初審。各項文件金額與身分資料核對無誤，後續如有問題會發E-Mail通知，請勿重複繳交紙本。";
    resDetail.className = "detail-box pass";
  } else {
    resultBadge.textContent = "✕ 審查不通過 (待補正)";
    resultBadge.className = "status-badge fail";
    resDetail.textContent = resultText;
    resDetail.className = "detail-box fail";
  }

  // 顯示結果區塊
  resultSection.style.display = "block";
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
}


/**
 * 函式名稱：showError
 * 用途說明：
 *    顯示錯誤或警告提示訊息框。
 * 參數 (Parameters)：
 *    @param {string} msg - 欲提示之錯誤訊息文字。
 * 回傳值 (Returns)：
 *    無
 */
function showError(msg) {
  const errorSection = document.getElementById("errorSection");
  const errorMessage = document.getElementById("errorMessage");
  errorMessage.textContent = msg;
  errorSection.style.display = "block";
  errorSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

