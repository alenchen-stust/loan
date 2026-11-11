/**
 * ==============================================================================
 * 檔案名稱：app.js
 * 專案名稱：就學貸款審查結果線上查詢系統 - 前端互動邏輯腳本
 * 說明：
 *    本腳本負責接收使用者於 index.html 輸入之學生學號，透過瀏覽器 Fetch API
 *    發送非同步 HTTP GET 請求至 Google Apps Script Web App API 端點，
 *    並將回傳之 JSON 審查結果動態渲染於頁面的資料卡片中（採用純 textContent
 *    設值以防範 XSS 跨站腳本攻擊）。
 * ==============================================================================
 */

/**
 * 【重要設定】Google Apps Script 部署之 Web App 應用程式網址
 * 說明：
 *    串接後端 Code.js 之 doGet(e) 查詢介面。
 *    每次於 GAS 重新建立「新部署作業」時若產生新 URL，須同步更新此常數。
 *    部署權限須設定為「執行身分：我」、「誰可以存取：所有人」，瀏覽器 CORS 才能成功讀取回應。
 */
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbxca-L0Nwdb5IrfiJrU1PQ1MSZvoAHcJvxXNWNf1SQ350U_KJ8ZaEsgQKwmxCXcuTWPRg/exec";


/**
 * 函式名稱：handleSearch
 * 用途說明：
 *    處理使用者提交學號查詢表單之事件處理器。
 *    依序執行：攔截換頁、輸入清理與驗證、切換 Loading 防呆鎖定、呼叫 GAS API、
 *    依據回傳 status 分派渲染或錯誤提示，最後於 finally 確保按鈕復原。
 * 參數 (Parameters)：
 *    @param {Event} event - HTML Form onsubmit 觸發之表單送出事件物件。
 * 回傳值 (Returns)：
 *    @returns {Promise<void>} 非同步執行查詢任務，無直接回傳值。
 */
async function handleSearch(event) {
  // 1. 阻止瀏覽器預設的表單傳統 POST/GET 重新整理換頁行為
  event.preventDefault();

  // 2. 取得頁面 DOM 元件參照
  const studentIdInput = document.getElementById("studentIdInput");
  const searchBtn = document.getElementById("searchBtn");
  const btnText = searchBtn.querySelector(".btn-text");
  const btnLoader = searchBtn.querySelector(".btn-loader");
  const resultSection = document.getElementById("resultSection");
  const errorSection = document.getElementById("errorSection");

  // 3. 取得使用者輸入並執行標準化清理（移除前後空白字元，並統一轉大寫英文字母）
  const studentId = String(studentIdInput.value || "").trim().toUpperCase();

  // 防呆檢查：若清理後為空字串則阻擋發送網路請求
  if (!studentId) {
    showError("請輸入有效的學生學號！");
    return;
  }

  // 4. 清除並隱藏上一次查詢殘留的結果卡片與錯誤警告框
  resultSection.style.display = "none";
  errorSection.style.display = "none";

  // 5. 切換查詢按鈕為「載入中」狀態並鎖定按鈕 disabled，防止使用者連點造成多筆重複 API 請求
  searchBtn.disabled = true;
  btnText.style.display = "none";
  btnLoader.style.display = "inline";

  try {
    // 6. 組合請求 API 網址，使用 encodeURIComponent() 對查詢參數編碼避免特殊字元破壞 URL 結構
    const apiUrl = `${GAS_WEB_APP_URL}?action=query&student_id=${encodeURIComponent(studentId)}`;

    // 7. 發送非同步 HTTP GET 請求至 GAS Web App
    //    GAS Web App 回傳 ContentService JSON 時會自動帶入 Redirect (302) 與 Access-Control-Allow-Origin: *
    const response = await fetch(apiUrl, {
      method: "GET",
      mode: "cors" // 明確指定啟用跨來源資源共享 (CORS) 模式，供瀏覽器正確讀取跨網域 JSON 回應
    });

    // 檢查 HTTP 回應狀態碼是否落在 200~299 成功區間
    if (!response.ok) {
      throw new Error(`伺服器連線異常 (HTTP ${response.status})`);
    }

    // 將伺服器回傳的 JSON 純文字內容反序列化為 JavaScript 物件
    const resJson = await response.json();

    // 8. 依據後端回傳之 status 欄位進行分流處理
    //    預期正常格式：{ status: "success", data: { ... } }
    if (resJson.status === "success" && resJson.data) {
      renderResult(resJson.data);
    } else if (resJson.status === "not_found") {
      // 試算表中查無該學號之任何送審紀錄
      showError(resJson.message || "查無此學號之就貸送審資料，請確認學號是否正確或尚未完成表單填報。");
    } else {
      // 其他後端回報之商業邏輯錯誤（例如試算表尚未產生、缺少 student_id 參數等）
      showError(resJson.message || "查詢過程發生異常，請稍後再試。");
    }

  } catch (error) {
    // 捕捉網路斷線、CORS 被拒（例如 GAS 權限未開所有人）、或 JSON 解析失敗等例外狀況
    console.error("查詢請求失敗：", error);
    showError("無法連線至審查伺服器，請檢查網路連線或稍後再試。");
  } finally {
    // 9. 無論查詢成功或失敗，皆於 finally 區塊保證解除按鈕禁用狀態並恢復原始文字
    searchBtn.disabled = false;
    btnText.style.display = "inline";
    btnLoader.style.display = "none";
  }
}


/**
 * 函式名稱：renderResult
 * 用途說明：
 *    將 GAS 後端回傳之最新單筆審查資料物件安全地渲染至畫面的結果卡片元件中。
 *    全程採用 .textContent 寫入文字（不使用 .innerHTML），從根本防範 XSS 風險。
 * 參數 (Parameters)：
 *    @param {Object} data - 後端回傳之學生審查資料物件，包含以下屬性：
 *        @param {string} data.serial_no - 系統審核序號（格式：審查日MMDD-流水號）
 *        @param {string} data.year - 學年度（例："114"）
 *        @param {string} data.semester - 學期（例："第2學期"）
 *        @param {string} data.student_class - 就讀班級
 *        @param {string} data.student_id - 學生學號
 *        @param {string} data.student_name - 去識別化遮罩後姓名（例："周○真"）
 *        @param {string} data.review_result - 審查結果摘要（"審查通過" 或含異常原因之明細字串）
 *        @param {string} data.review_time - 系統最後更新審查時間戳記
 * 回傳值 (Returns)：
 *    @returns {void} 無回傳值，直接操作頁面 DOM 並捲動顯示結果區塊。
 */
function renderResult(data) {
  // 1. 取得結果卡片內部各資料顯示節點
  const resultSection = document.getElementById("resultSection");
  const resultBadge = document.getElementById("resultBadge");
  const resSerialNo = document.getElementById("resSerialNo");
  const resTerm = document.getElementById("resTerm");
  const resClass = document.getElementById("resClass");
  const resStudentId = document.getElementById("resStudentId");
  const resName = document.getElementById("resName");
  const resDetail = document.getElementById("resDetail");
  const resTime = document.getElementById("resTime");

  // 2. 將後端物件欄位填入對應節點（使用 || "-" 提供空值防呆顯示）
  if (resSerialNo) resSerialNo.textContent = data.serial_no || "-";
  resTerm.textContent = `${data.year || ""} 學年度 ${data.semester || ""}`.trim() || "-";
  resClass.textContent = data.student_class || "-";
  resStudentId.textContent = data.student_id || "-";
  resName.textContent = data.student_name || "-";
  resTime.textContent = data.review_time || "-";

  // 3. 讀取並清理審查結果字串前後空白（問題 18 防呆修復：避免前後隱藏空白造成通過判定誤判）
  const resultText = String(data.review_result || "").trim();
  const isPass = resultText === "審查通過";

  // 4. 根據審查是否通過，動態切換頂部膠囊徽章與詳細說明框之文字與 CSS 色彩類別 (.pass / .fail)
  if (isPass) {
    resultBadge.textContent = "✓ 審查通過";
    resultBadge.className = "status-badge pass";
    resDetail.textContent = "恭喜！您的就學貸款申請資料經系統勾稽全數相符，已完成初審。各項文件金額與身分資料核對無誤，後續如有問題會發E-Mail通知，請勿重複繳交紙本。";
    resDetail.className = "detail-box pass";
  } else {
    resultBadge.textContent = "✕ 審查不通過 (待補正)";
    resultBadge.className = "status-badge fail";
    resDetail.textContent = resultText || "審查結果待確認，請參閱電子郵件通知或洽詢承辦人員。";
    resDetail.className = "detail-box fail";
  }

  // 5. 展開結果卡片並平滑捲動畫面至卡片頂端，優化手機端使用體驗
  resultSection.style.display = "block";
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
}


/**
 * 函式名稱：showError
 * 用途說明：
 *    顯示系統錯誤、網路異常或查無該學號資料之警示訊息框。
 * 參數 (Parameters)：
 *    @param {string} msg - 欲展示給學生閱讀之錯誤或提示訊息純文字。
 * 回傳值 (Returns)：
 *    @returns {void} 無回傳值，直接更新 DOM 文字並顯示錯誤區塊。
 */
function showError(msg) {
  const errorSection = document.getElementById("errorSection");
  const errorMessage = document.getElementById("errorMessage");
  errorMessage.textContent = msg;
  errorSection.style.display = "block";
  errorSection.scrollIntoView({ behavior: "smooth", block: "start" });
}
