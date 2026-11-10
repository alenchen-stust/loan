/**
 * ==============================================================================
 * 檔案名稱：Code.js
 * 專案名稱：學生就學貸款 PDF 自動化處理系統 - Google Apps Script (GAS) 核心控制腳本
 * 說明：
 *    本腳本建構於 Google 試算表之擴充功能 Apps Script 中，主要功能包括：
 *    1. Google 表單提交觸發 (onFormSubmitHandler)：接收學生填寫資訊與 PDF 檔案連結。
 *       - 具備智慧 Email 偵測機制 (extractStudentEmail)，不受表單題目順序或預設收集設定影響。
 *    2. 串接 NAS Tailscale Funnel API (sendToNasApi)：發送 Base64 檔案進行後端文字解析與硬碟歸檔。
 *    3. 執行「七大核心審查規則」(validateLoanSubmission)：
 *       - 學生身分認定：學號或身分證號相同即視為同一學生。
 *       - 班級名稱規範：統一以「登錄確認單」之班級名稱為主，臺銀對保單與可貸金額明細表之班級名稱無須比對。
 *       - 規則 1：表單基本資料與可貸金額明細表核對（僅比對學號、姓名，身分證號交叉檢驗）。
 *       - 規則 2：各單據學年度及學期是否皆符合當前有效期間（如 115-1：115/8/1~116/1/14）。
 *       - 規則 3：登錄確認單與可貸金額明細表核對（僅比對學號、姓名）。
 *       - 規則 4：臺銀對保單與登錄確認單核對（僅比對姓名、身分證號）。
 *       - 規則 5：臺銀對保單各項申貸金額不可大於可貸金額明細表上限（生活費除外）。
 *       - 規則 6：臺銀對保單各項政府減免/補貼金額必須與可貸金額明細表完全一致。
 *       - 規則 7：登錄確認單各項金額及撥款金額必須與臺銀對保單完全一致。
 *    4. 自動寫入試算表 4 個分頁：
 *       - 「臺銀對保單」、「登錄確認單」、「可貸金額明細表」、「審查結果」。
 *       - 班級名稱統一採用登錄確認單之解析結果。
 *       - 「審查結果」記錄審查結論與「通知信發送狀態」，便於追蹤排查。
 *    5. 清理 Google 雲端硬碟暫存 PDF 檔案 (deleteDriveFiles)：防止個資洩漏並節省雲端空間。
 *    6. 自動發送 E-Mail 審查結果通知 (sendReviewResultEmail)：
 *       - 包含純文字與 HTML 雙重格式（解決 MailApp 缺少 body 參數問題）。
 *       - 實作 MailApp + GmailApp 雙重發送備援架構。
 *       - 審查合格通知文字：「各項文件金額與身分資料核對無誤，後續如有問題會發E-Mail通知，請勿重複繳交紙本。」
 *    7. 提供學生線上查詢之 Web App API (doGet)：支援前端以學號查詢最新審查狀態。
 *    8. 試算表自訂功能表 (onOpen)：提供管理員一鍵測試發信與授權。
 * ==============================================================================
 */

// ==============================================================================
// 全域系統常數設定 (依實際環境配置修改)
// ==============================================================================

/** @constant {string} NAS_TAILSCALE_URL - QNAP NAS 透過 Tailscale Funnel 對外開放之 HTTPS API 端點網址 */
const NAS_TAILSCALE_URL = "https://your-machine-name.tailnet-name.ts.net/api/parse_pdf";

/** @constant {string} SHEET_NAME_BANK - 臺銀對保單寫入分頁名稱 */
const SHEET_NAME_BANK = "臺銀對保單";

/** @constant {string} SHEET_NAME_CONFIRM - 登錄確認單寫入分頁名稱 */
const SHEET_NAME_CONFIRM = "登錄確認單";

/** @constant {string} SHEET_NAME_MAX_LOAN - 可貸金額明細表寫入分頁名稱 */
const SHEET_NAME_MAX_LOAN = "可貸金額明細表";

/** @constant {string} SHEET_NAME_RESULT - 綜合審查結果分頁名稱 */
const SHEET_NAME_RESULT = "審查結果";


/**
 * 函式名稱：onOpen
 * 用途說明：
 *    當使用者開啟 Google 試算表時自動執行之事件處理函式。
 *    於試算表頂端選單列建立「🎓 就學貸款自動化系統」自訂選單，
 *    提供管理員進行手動發信測試、權限授權與執行模擬測試。
 * 參數 (Parameters)：
 *    無
 * 回傳值 (Returns)：
 *    無
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu("🎓 就學貸款自動化系統")
    .addItem("🔍 檢測 NAS 容器版本與連線狀態", "checkNasServerVersion")
    .addItem("✉️ 測試發送審查結果郵件 (兼觸發發信授權)", "testSendReviewEmailManual")
    .addItem("📋 執行手動模擬送件測試", "testMockSubmit")
    .addToUi();
}


/**
 * 函式名稱：checkNasServerVersion
 * 用途說明：
 *    在 Google 試算表選單中提供一鍵檢驗 NAS 後端 Docker 容器之運行版本與健康狀態。
 *    自動發送 GET 請求至 /api/version，檢查是否為最新版 (v2.1.0)，
 *    若為舊版，提示管理員進行 Docker 映像檔重新建置或重啟容器。
 * 參數 (Parameters)：
 *    無
 * 回傳值 (Returns)：
 *    無
 */
function checkNasServerVersion() {
  var ui = SpreadsheetApp.getUi();
  var versionUrl = NAS_TAILSCALE_URL.replace(/\/api\/parse_pdf\/?$/, "/api/version");
  if (versionUrl.indexOf("/api/version") === -1) {
    versionUrl = versionUrl.replace(/\/+$/, "") + "/api/version";
  }

  try {
    var response = UrlFetchApp.fetch(versionUrl, {
      method: "get",
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    var text = response.getContentText();

    if (code === 200) {
      var data = JSON.parse(text);
      if (data.version === "2.1.0") {
        ui.alert(
          "NAS 連線與版本檢查正常",
          "【檢查成功】\n" +
          "• NAS API 連線：正常 (HTTP 200)\n" +
          "• 容器程式版本：" + data.version + "\n" +
          "• 運作架構：" + data.mode + "\n" +
          "• 當前有效學期：" + data.current_valid_semester + "\n\n" +
          "✓ 系統已完全支援「純記憶體解析」與「初審通過後二階段存檔」，初審未通過保證 100% 絕不留存錯誤檔案！",
          ui.ButtonSet.OK
        );
      } else {
        ui.alert(
          "警告：NAS 容器為舊版本",
          "【偵測到舊版容器】\n" +
          "• 連線狀態：正常\n" +
          "• 當前回傳版本：" + (data.version || "舊版未標註版本") + "\n\n" +
          "原因：NAS 上的 Docker 容器尚未重新載入最新的 app.py 程式碼，初審未通過時仍可能於解析階段誤存檔案！\n\n" +
          "【解決方法】：\n" +
          "請將專案的 app.py 與 docker-compose.yml 複製至 NAS 專案目錄，並在 NAS 終端機執行：\n" +
          "docker-compose restart 或 docker-compose up -d --build",
          ui.ButtonSet.OK
        );
      }
    } else {
      ui.alert(
        "警告：NAS 回傳非 200 狀態碼",
        "【HTTP " + code + "】\n" +
        "端點回傳訊息：\n" + text.slice(0, 300) + "\n\n" +
        "若為 404 Not Found，表示 NAS Docker 容器目前運行的依然是舊版 app.py（無 /api/version 端點）。\n" +
        "請在 NAS 重新建置並重啟容器！",
        ui.ButtonSet.OK
      );
    }
  } catch (err) {
    ui.alert(
      "無法連線至 NAS API",
      "連線測試失敗，原因：\n" + err.toString() + "\n\n" +
      "請確認：\n" +
      "1. NAS 上的 Tailscale Funnel 是否正常運作。\n" +
      "2. Docker 容器 pdf_parser_api 是否正常運行於 Port 55000。",
      ui.ButtonSet.OK
    );
  }
}


/**
 * 函式名稱：testSendReviewEmailManual
 * 用途說明：
 *    手動發信與權限授權觸發函式。
 *    可在 Apps Script 編輯器上方選擇此函式並點擊「執行」，或在試算表選單中點選。
 *    主要用途：
 *    1. 主動觸發 Google 帳號授權對話框（確保已授權 script.send_mail 與 gmail.send 權限）。
 *    2. 寄發一封測試 Email 至管理員信箱，驗證 MailApp 與 GmailApp 是否可正常運作。
 * 參數 (Parameters)：
 *    無
 * 回傳值 (Returns)：
 *    無
 */
function testSendReviewEmailManual() {
  var targetEmail = "student_test@example.com";
  // 安全讀取當前執行者之 Email，若未授權 userinfo.email 權限則退回使用預設測試信箱，防止中斷
  try {
    var activeUser = Session.getActiveUser();
    if (activeUser) {
      var emailVal = activeUser.getEmail();
      if (emailVal) targetEmail = emailVal;
    }
  } catch (userErr) {
    Logger.log("提示：讀取 Session 作用中使用者信箱失敗 (" + userErr.message + ")，退回使用預設測試信箱。");
  }

  Logger.log("=================== 開始執行手動發信測試 ===================");
  Logger.log("目標信箱：" + targetEmail);

  var sendResult = sendReviewResultEmail(
    targetEmail,
    "4B180109",
    "測試同學",
    "115",
    "第1學期",
    true,
    []
  );

  Logger.log("手動發信結果：" + JSON.stringify(sendResult));
  Logger.log("=================== 手動發信測試執行完畢 ===================");

  try {
    var ui = SpreadsheetApp.getUi();
    if (sendResult.success) {
      ui.alert(
        "發信測試成功",
        "系統已成功透過 [" + sendResult.method + "] 發送測試審查通知信至：\n" + targetEmail + "\n\n請前往收件匣（或垃圾郵件匣）確認收件！",
        ui.ButtonSet.OK
      );
    } else {
      ui.alert(
        "發信測試失敗",
        "發信過程遭遇錯誤：\n" + sendResult.reason + "\n\n請檢查 Apps Script 執行權限或配額。",
        ui.ButtonSet.OK
      );
    }
  } catch (uiErr) {
    // 若在非 UI 環境執行 (如獨立觸發)，忽略 UI 提示
  }
}


/**
 * 函式名稱：testMockSubmit
 * 用途說明：
 *    本機模擬測試專用函式。
 *    開發與維護人員可在 Apps Script 編輯器上方選擇此函式並點擊「執行」，
 *    無須透過實際表單即可測試完整流程（NAS 發送、7大規則勾稽、分頁寫入、發信與查詢）。
 * 參數 (Parameters)：
 *    無
 * 回傳值 (Returns)：
 *    無
 */
function testMockSubmit() {
  var activeUserEmail = "student_test@example.com";
  // 安全讀取當前執行者之 Email，若無權限則退回預設信箱，確保測試流程 100% 順暢走完
  try {
    var activeUser = Session.getActiveUser();
    if (activeUser) {
      var emailVal = activeUser.getEmail();
      if (emailVal) activeUserEmail = emailVal;
    }
  } catch (userErr) {
    Logger.log("提示：讀取 Session 作用中使用者信箱失敗 (" + userErr.message + ")，使用預設測試信箱。");
  }

  var mockEvent = {
    values: [
      "2026/09/29 12:00:00", // [0] 時間戳記
      activeUserEmail,       // [1] 電子郵件地址 (帶入當前執行者信箱以利實測收件)
      "日間部",               // [2] 學制
      "四技行流三乙",         // [3] 班級
      "4B3B0099",            // [4] 學號
      "周○真",               // [5] 姓名
      "Q234567890",          // [6] 身分證號 (對保單密碼)
      "0986999333",          // [7] 行動電話
      "",                    // [8] 備註
      "https://drive.google.com/file/d/1HhvkH8RE1JmXfrePHq4ebYgM7Q9i7Rp2/view", // [9] 臺銀對保單網址
      "https://drive.google.com/file/d/1E2oQViY7R-U_k6oox5Cf4o0Rf9bt4HIG/view", // [10] 已登錄確認單網址
      "https://drive.google.com/file/d/1WxyuxQOB2upfE2xv2S7jcroezzd8hrg4/view"  // [11] 可貸金額明細表網址
    ],
    namedValues: {
      "時間戳記": ["2026/09/29 12:00:00"],
      "電子郵件地址": [activeUserEmail],
      "學制": ["日間部"],
      "班級": ["四技行流三乙"],
      "學號": ["4B3B0099"],
      "姓名": ["周○真"],
      "身分證號": ["Q234567890"],
      "行動電話": ["0986999333"],
      "臺銀就學貸款撥款通知書 (對保單)": ["https://drive.google.com/file/d/1HhvkH8RE1JmXfrePHq4ebYgM7Q9i7Rp2/view"],
      "學校就貸登錄確認單": ["https://drive.google.com/file/d/1E2oQViY7R-U_k6oox5Cf4o0Rf9bt4HIG/view"],
      "可貸金額明細表": ["https://drive.google.com/file/d/1WxyuxQOB2upfE2xv2S7jcroezzd8hrg4/view"]
    }
  };

  Logger.log("=================== 開始執行手動模擬送件測試 ===================");
  onFormSubmitHandler(mockEvent);
  Logger.log("=================== 手動模擬送件測試執行完畢 ===================");
}


/**
 * 函式名稱：escapeHtml
 * 用途說明：
 *    將字串中的 HTML 特殊保留字元進行跳脫（Entity Encode），
 *    防止郵件客戶端（如 Gmail、Outlook）因解析到特殊標籤（如 <、>、& 等）
 *    而導致郵件 HTML DOM 損壞或被安全機制過濾判定為空白。
 * 參數 (Parameters)：
 *    @param {string} str - 待跳脫處理之原始字串。
 * 回傳值 (Returns)：
 *    @return {string} 安全編碼後之 HTML 字串。
 */
function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


/**
 * 函式名稱：extractStudentEmail
 * 用途說明：
 *    智慧偵測並提取表單提交資料中的學生電子郵件地址。
 *    相容處理以下情境：
 *    1. Google 表單開啟「收集電子郵件地址」（通常位於 namedValues 或試算表第二欄）。
 *    2. Google 表單設計者自訂問題「電子郵件地址/Email/信箱」（無論題目次序為何）。
 *    3. 欄位順序發生偏移時，自動全局正則掃描 values 陣列找出合法 Email。
 * 參數 (Parameters)：
 *    @param {Object} e - 表單提交事件物件，包含 e.values 與 e.namedValues。
 * 回傳值 (Returns)：
 *    @return {string} 偵測到之學生電子郵件字串，若皆未找到則回傳空字串 ""。
 */
function extractStudentEmail(e) {
  if (!e) return "";

  // 途徑 1：由 namedValues 依據表頭標題關鍵字匹配 (最精確)
  if (e.namedValues) {
    for (var header in e.namedValues) {
      var hLower = String(header).toLowerCase();
      if (hLower.indexOf("email") !== -1 ||
        hLower.indexOf("電子郵件") !== -1 ||
        hLower.indexOf("信箱") !== -1 ||
        hLower.indexOf("郵件") !== -1) {
        var arr = e.namedValues[header];
        if (arr && arr.length > 0) {
          var val = String(arr[0] || "").trim();
          if (val.indexOf("@") !== -1) {
            Logger.log("【Email偵測】從 namedValues['" + header + "'] 成功識別信箱：" + val);
            return val;
          }
        }
      }
    }
  }

  var values = e.values || [];

  // 途徑 2：檢查預設索引 values[1] (標準 Google 表單自動收集 Email 之位置)
  if (values.length > 1) {
    var defaultVal = String(values[1] || "").trim();
    if (defaultVal.indexOf("@") !== -1 && defaultVal.indexOf(".") !== -1) {
      Logger.log("【Email偵測】從 values[1] 成功識別信箱：" + defaultVal);
      return defaultVal;
    }
  }

  // 途徑 3：全局正規表達式掃描 values 陣列中的每一個儲存格 (防呆後備)
  var emailPattern = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$/;
  for (var i = 0; i < values.length; i++) {
    var item = String(values[i] || "").trim();
    if (emailPattern.test(item)) {
      Logger.log("【Email偵測】全局正則掃描於 values[" + i + "] 識別信箱：" + item);
      return item;
    }
  }

  Logger.log("【Email偵測警告】未能於表單提交資料中找到任何有效的 Email 地址！");
  return "";
}


/**
 * 函式名稱：extractFormData
 * 用途說明：
 *    全方位智慧探測並擷取 Google 表單送出之各項欄位值。
 *    彻底解決實際表單無「備註」題、題目次序不同、或欄位索引偏移時抓錯欄位之重大問題：
 *    1. 身分證號：優先尋找含「身分證/證號/密碼」題目，若無則正則匹配台灣身分證號。
 *    2. 學號：優先尋找含「學號」題目，若無則正則匹配大專學號。
 *    3. 姓名：優先尋找含「姓名」題目。
 *    4. 三份 PDF 網址：依題目标題關鍵字（對保單、確認單、明細表）智慧匹配 Drive 連結，相容多檔逗點分隔格式。
 * 參數 (Parameters)：
 *    @param {Object} e - 表單提交觸發事件物件。
 * 回傳值 (Returns)：
 *    @return {Object} 完整表單資料物件，包含學號、姓名、身分證號、各項 Drive 網址等。
 */
function extractFormData(e) {
  var values = (e && e.values) ? e.values : [];
  var namedValues = (e && e.namedValues) ? e.namedValues : {};

  var data = {
    timestamp: values[0] || Utilities.formatDate(new Date(), "GMT+8", "yyyy/MM/dd HH:mm:ss"),
    email: extractStudentEmail(e),
    system: "",
    class: "",
    studentId: "",
    name: "",
    idCard: "",
    phone: "",
    bankPdfUrl: "",
    confirmPdfUrl: "",
    maxLoanPdfUrl: ""
  };

  // 1. 從 namedValues 表頭關鍵字萃取文字欄位
  for (var header in namedValues) {
    var h = String(header).toLowerCase();
    var valArr = namedValues[header];
    var val = (valArr && valArr.length > 0) ? String(valArr[0] || "").trim() : "";

    if (!data.idCard && (h.indexOf("身分證") !== -1 || h.indexOf("證號") !== -1 || h.indexOf("密碼") !== -1)) {
      data.idCard = val.toUpperCase();
    } else if (!data.studentId && h.indexOf("學號") !== -1) {
      data.studentId = val.toUpperCase();
    } else if (!data.name && (h.indexOf("姓名") !== -1 || h.indexOf("學生") !== -1)) {
      data.name = val;
    } else if (!data.class && h.indexOf("班級") !== -1) {
      data.class = val;
    } else if (!data.system && (h.indexOf("學制") !== -1 || h.indexOf("部別") !== -1)) {
      data.system = val;
    } else if (!data.phone && (h.indexOf("電話") !== -1 || h.indexOf("手機") !== -1)) {
      data.phone = val;
    }
  }

  // 2. 身分證號防呆正則掃描 (^[A-Z][1289]\d{8}$)
  if (!data.idCard) {
    var idCardPattern = /^[A-Z][1289]\d{8}$/;
    for (var i = 0; i < values.length; i++) {
      var itemVal = String(values[i] || "").trim().toUpperCase();
      if (idCardPattern.test(itemVal)) {
        data.idCard = itemVal;
        break;
      }
    }
  }

  // 3. 學號防呆正則掃描 (7-10 碼英數組合，排除身分證與手機)
  if (!data.studentId) {
    var stIdPattern = /^[0-9A-Z]{7,10}$/;
    for (var j = 0; j < values.length; j++) {
      var sVal = String(values[j] || "").trim().toUpperCase();
      if (stIdPattern.test(sVal) && !/^[A-Z][1289]\d{8}$/.test(sVal) && !/^09\d{8}$/.test(sVal)) {
        data.studentId = sVal;
        break;
      }
    }
  }

  // 4. 三份 PDF 檔案 Drive 連結智慧比對 (由 namedValues 識別)
  for (var headerKey in namedValues) {
    var hk = String(headerKey).toLowerCase();
    var linkVal = (namedValues[headerKey] && namedValues[headerKey][0]) ? String(namedValues[headerKey][0]).trim() : "";
    if (linkVal.indexOf("drive.google.com") !== -1 || linkVal.indexOf("id=") !== -1) {
      var cleanLink = linkVal.split(",")[0].trim(); // 若允許多檔上傳取首個
      if (hk.indexOf("對保單") !== -1 || hk.indexOf("臺銀") !== -1 || hk.indexOf("台銀") !== -1) {
        data.bankPdfUrl = cleanLink;
      } else if (hk.indexOf("確認單") !== -1 || hk.indexOf("登錄") !== -1) {
        data.confirmPdfUrl = cleanLink;
      } else if (hk.indexOf("明細表") !== -1 || hk.indexOf("可貸金額") !== -1) {
        data.maxLoanPdfUrl = cleanLink;
      }
    }
  }

  // 5. 若 namedValues 未完整匹配 Drive 連結，從 values 陣列中全局搜集 Drive 網址配對
  if (!data.bankPdfUrl || !data.confirmPdfUrl || !data.maxLoanPdfUrl) {
    var detectedDriveUrls = [];
    for (var k = 0; k < values.length; k++) {
      var vItem = String(values[k] || "").trim();
      if (vItem.indexOf("drive.google.com") !== -1 || vItem.indexOf("id=") !== -1) {
        detectedDriveUrls.push(vItem.split(",")[0].trim());
      }
    }
    if (detectedDriveUrls.length >= 3) {
      if (!data.bankPdfUrl) data.bankPdfUrl = detectedDriveUrls[0];
      if (!data.confirmPdfUrl) data.confirmPdfUrl = detectedDriveUrls[1];
      if (!data.maxLoanPdfUrl) data.maxLoanPdfUrl = detectedDriveUrls[2];
    } else {
      // 容錯索引後備
      if (!data.bankPdfUrl) data.bankPdfUrl = values[9] || values[8] || "";
      if (!data.confirmPdfUrl) data.confirmPdfUrl = values[10] || values[9] || "";
      if (!data.maxLoanPdfUrl) data.maxLoanPdfUrl = values[11] || values[10] || "";
    }
  }

  // 6. 基礎欄位預設索引後備
  if (!data.system) data.system = (values[2] || "").trim();
  if (!data.class) data.class = (values[3] || "").trim();
  if (!data.studentId) data.studentId = (values[4] || "").trim().toUpperCase();
  if (!data.name) data.name = (values[5] || "").trim();
  if (!data.idCard) data.idCard = (values[6] || "").trim().toUpperCase();
  if (!data.phone) data.phone = (values[7] || "").trim();

  return data;
}


/**
 * 函式名稱：onFormSubmitHandler
 * 用途說明：
 *    Google 表單送出事件的核心進入點函式。
 *    當學生於表單完成作答並提交時，自動觸發此函式，執行三份 PDF 傳輸、解析、7項邏輯審查、
 *    四個試算表分頁寫入、暫存雲端硬碟檔案刪除與審查結果 Email 發送。
 * 參數 (Parameters)：
 *    @param {Object} e - 表單提交觸發事件物件，包含 e.values 學生填寫欄位陣列。
 * 回傳值 (Returns)：
 *    無
 */
function onFormSubmitHandler(e) {
  try {
    if (!e || !e.values) {
      Logger.log("錯誤：未接收到有效的表單提交資料。");
      return;
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var responses = e.values;

    // 擷取學生於 Google 表單填寫的各項資料 (全面採用智慧探測 extractFormData，防題目順序調換、缺題或缺少備註題導致索引錯位)
    var formData = extractFormData(e);
    var timestamp = formData.timestamp;
    var studentEmail = formData.email;
    var educationSystem = formData.system;
    var studentClass = formData.class;
    var studentId = formData.studentId;
    var studentName = formData.name;
    var studentIdCard = formData.idCard;
    var studentPhone = formData.phone;

    var bankPdfUrl = formData.bankPdfUrl;
    var confirmPdfUrl = formData.confirmPdfUrl;
    var maxLoanPdfUrl = formData.maxLoanPdfUrl;

    // 產生本次審查全系統唯一之審核序號 (格式：yyyyMMdd-HHmmss)，串聯 4 個試算表分頁與通知信以利追蹤
    var serialNo = Utilities.formatDate(new Date(), "GMT+8", "yyyyMMdd-HHmmss");

    Logger.log("=================== 開始處理就貸送件 (序號：" + serialNo + ") ===================");
    Logger.log("學生資訊：" + studentId + " " + studentName + " | 通知信箱：" + studentEmail);
    Logger.log("【檔案連結識別】對保單：" + bankPdfUrl + " | 確認單：" + confirmPdfUrl + " | 明細表：" + maxLoanPdfUrl);

    // 暫定前綴 (若確認單解析失敗時的後備檔案名稱前綴)
    var tempPrefix = studentId + studentName + "-";

    // ==========================================================================
    // 步驟 1：優先處理「已登錄確認單」PDF (純文字解析驗證，不存入 NAS 硬碟)
    // 原因：確認單內含標準民國學年度、學期、學號、姓名，作為三份 PDF 統一歸檔前綴，
    //       且依規定學生「班級」名稱亦統一以登錄確認單解析出的班級為主。
    // ==========================================================================
    var resConfirm = { success: false, error: "未執行", extracted_data: {} };
    var blobConfirm = null;
    try {
      blobConfirm = getFileBlobFromUrl(confirmPdfUrl);
      // save_to_disk 傳入 false：僅進行解密與欄位文字萃取，初審通過前絕不儲存檔案至硬碟
      resConfirm = sendToNasApi(blobConfirm, "", tempPrefix + "已登錄確認單.pdf", false);
    } catch (errConfirm) {
      resConfirm = { success: false, error: "檔案讀取或通訊失敗：" + errConfirm.message, extracted_data: {} };
    }

    // 根據登錄確認單解析出的學年度與學期建立標準檔名前綴 (例如：115-1-4B3B0099周○真-)
    var filePrefix = tempPrefix;
    if (resConfirm.success && resConfirm.extracted_data) {
      var year = resConfirm.extracted_data["學年度"] || "";
      var semester = resConfirm.extracted_data["學期"] || "";
      var parsedId = resConfirm.extracted_data["學號"] || studentId;
      var parsedName = resConfirm.extracted_data["姓名"] || studentName;

      var semNum = "";
      if (semester.indexOf("1") !== -1 || semester.indexOf("上") !== -1) semNum = "1";
      else if (semester.indexOf("2") !== -1 || semester.indexOf("下") !== -1) semNum = "2";

      if (year && semNum) {
        filePrefix = year + "-" + semNum + "-" + parsedId + parsedName + "-";
      }
    }

    // ==========================================================================
    // 步驟 2：處理「臺銀對保單」PDF (純文字解密與欄位萃取，不存入 NAS 硬碟)
    // ==========================================================================
    var resBank = { success: false, error: "未執行", extracted_data: {} };
    var blobBank = null;
    try {
      blobBank = getFileBlobFromUrl(bankPdfUrl);
      resBank = sendToNasApi(blobBank, studentIdCard, filePrefix + "臺銀對保單.pdf", false);
    } catch (errBank) {
      resBank = { success: false, error: "檔案讀取或通訊失敗：" + errBank.message, extracted_data: {} };
    }

    // ==========================================================================
    // 步驟 3：處理「可貸金額明細表」PDF (純文字解析驗證，不存入 NAS 硬碟)
    // ==========================================================================
    var resMaxLoan = { success: false, error: "未執行", extracted_data: {} };
    var blobMaxLoan = null;
    try {
      blobMaxLoan = getFileBlobFromUrl(maxLoanPdfUrl);
      resMaxLoan = sendToNasApi(blobMaxLoan, "", filePrefix + "可貸金額明細表.pdf", false);
    } catch (errMaxLoan) {
      resMaxLoan = { success: false, error: "檔案讀取或通訊失敗：" + errMaxLoan.message, extracted_data: {} };
    }

    // ==========================================================================
    // 步驟 4：執行「七大核心審查規則」比對勾稽
    // (規則 1、3、4 無需比對班級；身分以學號或身分證號相符判定為同一學生)
    // ==========================================================================
    var reviewResult = validateLoanSubmission(formData, resBank, resConfirm, resMaxLoan);

    // ==========================================================================
    // 步驟 5：落實「初審通過後再儲存 PDF 至 NAS 硬碟；初審不通過不要儲存錯誤檔案」
    // 若審查合格 (isPassed === true)：呼叫 NAS API 將 3 份合格 PDF 歸檔存入學期專屬子目錄
    // 若審查不通過 (isPassed === false)：完全不存檔，避免錯誤文件污染 NAS 歸檔目錄
    // ==========================================================================
    var effectiveYear = (resConfirm.extracted_data && resConfirm.extracted_data["學年度"]) ||
      (resBank.extracted_data && resBank.extracted_data["學年度"]) || "";
    var effectiveSemester = (resConfirm.extracted_data && resConfirm.extracted_data["學期"]) ||
      (resBank.extracted_data && resBank.extracted_data["學期"]) || "";

    // 若解析未取得學期文字，採用系統當前有效學期作為備援
    if (!effectiveYear || !effectiveSemester) {
      var sysSem = getSystemValidSemester();
      effectiveYear = effectiveYear || String(sysSem.year);
      effectiveSemester = effectiveSemester || ("第" + sysSem.semester + "學期");
    }

    var nasArchiveResult = { success: false, message: "初審未通過，依規定略過 NAS 存檔", folder: "" };
    if (reviewResult.isPassed) {
      if (blobBank && blobConfirm && blobMaxLoan) {
        Logger.log("【初審合格】七大規則核對無誤，開始將 3 份 PDF 正式歸檔存入 NAS 硬碟專屬目錄...");
        nasArchiveResult = archiveApprovedPdfsToNas(
          effectiveYear,
          effectiveSemester,
          studentId,
          studentName,
          blobBank,
          blobConfirm,
          blobMaxLoan
        );
      } else {
        nasArchiveResult = { success: false, message: "檔案 Blob 遺失，無法儲存至 NAS", folder: "" };
        Logger.log("【NAS 歸檔警告】" + nasArchiveResult.message);
      }
    } else {
      Logger.log("【初審不通過】依規範不儲存錯誤之 PDF 檔案至 NAS 硬碟，保持歸檔目錄整潔。");
      // 雙重防呆保險：主動請求 NAS 清理該學期目錄下可能殘留的該學號錯誤檔案（防範舊版容器誤存或舊檔殘留）
      var cleanRes = cleanupRejectedPdfsFromNas(effectiveYear, effectiveSemester, studentId);
      if (cleanRes && cleanRes.deleted_count > 0) {
        nasArchiveResult.message = "初審未通過，依規定略過 NAS 存檔 (已清除 " + cleanRes.deleted_count + " 個錯誤殘留檔)";
      }
    }

    // ==========================================================================
    // 步驟 6：將萃取明細寫入試算表 3 個原始單據分頁 (包含審核序號，利於跨表關聯)
    // 班級名稱統一以「登錄確認單」為主
    // ==========================================================================
    writeToRawDataSheets(ss, serialNo, formData, resBank, resConfirm, resMaxLoan);

    // ==========================================================================
    // 步驟 7：自動寄送審查結果 E-Mail 通知學生 (包含審核序號，防 Gmail 郵件折疊)
    // ==========================================================================
    var mailSendResult = sendReviewResultEmail(
      studentEmail,
      studentId,
      studentName,
      effectiveYear,
      effectiveSemester,
      reviewResult.isPassed,
      reviewResult.errorMessages,
      serialNo
    );

    // ==========================================================================
    // 步驟 8：將最終審查結果寫入「審查結果」分頁 (第 1 欄寫入審核序號，並記錄 NAS 歸檔狀態)
    // ==========================================================================
    writeToReviewResultSheet(ss, serialNo, formData, resBank, resConfirm, resMaxLoan, reviewResult, mailSendResult, nasArchiveResult);

    // ==========================================================================
    // 步驟 9：刪除 Google 雲端硬碟暫存之 3 份 PDF 檔案 (移至垃圾桶以防個資洩漏並節省容量)
    // ==========================================================================
    deleteDriveFiles([bankPdfUrl, confirmPdfUrl, maxLoanPdfUrl]);

    Logger.log("學生 " + studentId + " 就貸審查流程全數執行完畢，結果為：" + (reviewResult.isPassed ? "通過" : "不通過") +
      " | 序號：" + serialNo + " | NAS歸檔：" + nasArchiveResult.message + " | 信件狀態：" +
      (mailSendResult.success ? ("成功(" + mailSendResult.method + ")") : ("失敗(" + mailSendResult.reason + ")")));

  } catch (globalError) {
    Logger.log("重大未預期異常 (onFormSubmitHandler)：" + globalError.toString());
  }
}


/**
 * 函式名稱：validateLoanSubmission
 * 用途說明：
 *    執行系統需求的「七大審查規則」完整資料勾稽，對比表單與三張 PDF 解析數據。
 * 規則重點調整 (依最新規格)：
 *    - 身分認定：只要學號或身分證號相同，即可視為同一學生。
 *    - 班級名稱：以登錄確認單為主，臺銀對保單及可貸金額明細表之班級名稱無須比對（錯誤亦無所謂）。
 *    - 規則 1：無需比對班級，只需要比對學號、姓名即可（身分證號與確認單/對保單交叉檢驗）。
 *    - 規則 2：三份單據之學年度與學期是否皆為系統當前有效期間（如 115-1：115/8/1~116/1/14）。
 *    - 規則 3：無需比對班級，只需要比對學號、姓名即可。
 *    - 規則 4：無需比對班級，只需要比對姓名、身分證號即可。
 *    - 規則 5：臺銀對保單各項申貸金額不可大於可貸金額明細表金額上限（生活費除外）。
 *    - 規則 6：臺銀對保單各項政府減免/補貼金額必須與可貸金額明細表金額完全相同。
 *    - 規則 7：登錄確認單各項金額及撥款金額必須與臺銀對保單完全相同。
 *
 * 參數 (Parameters)：
 *    @param {Object} formData - 學生於表單自填之基本資料物件。
 *    @param {Object} resBank - 臺銀對保單後端解析回傳結果物件。
 *    @param {Object} resConfirm - 登錄確認單後端解析回傳結果物件。
 *    @param {Object} resMaxLoan - 可貸金額明細表後端解析回傳結果物件。
 *
 * 回傳值 (Returns)：
 *    @return {Object} 審查結果物件：
 *        - isPassed (boolean): 是否全數合格通過 (true / false)
 *        - errorMessages (Array<string>): 未通過時之條列式具體錯誤原因陣列
 *        - summaryText (string): 寫入試算表或查詢顯示之結果字串 (「審查通過」或條列缺失)
 */
function validateLoanSubmission(formData, resBank, resConfirm, resMaxLoan) {
  var errors = [];

  // 先行防禦：確認三份 PDF 是否皆解析成功
  if (!resBank.success) {
    errors.push("【臺銀對保單】解析失敗：" + (resBank.error || "未通過防偽檢查或密碼錯誤"));
  }
  if (!resConfirm.success) {
    errors.push("【登錄確認單】解析失敗：" + (resConfirm.error || "非有效登錄確認單或格式錯誤"));
  }
  if (!resMaxLoan.success) {
    errors.push("【可貸金額明細表】解析失敗：" + (resMaxLoan.error || "非有效可貸金額明細表或格式錯誤"));
  }

  // 若有檔案解析失敗，直接回傳解析錯誤清單
  if (errors.length > 0) {
    return {
      isPassed: false,
      errorMessages: errors,
      summaryText: "【審查不通過 - 檔案解析異常】" + errors.join("；")
    };
  }

  var dBank = resBank.extracted_data || {};
  var dConfirm = resConfirm.extracted_data || {};
  var dMaxLoan = resMaxLoan.extracted_data || {};

  // ==========================================================================
  // 【規則 1】表單基本資料比對 (無需比對班級，只需比對學號、姓名)
  // 身分證號核對確認單與對保單
  // ==========================================================================
  if (formData.studentId !== (dMaxLoan["學號"] || "").toUpperCase()) {
    errors.push("表單填寫學號(" + formData.studentId + ")與可貸金額明細表學號(" + (dMaxLoan["學號"] || "無") + ")不符");
  }
  if (formData.name !== (dMaxLoan["姓名"] || "")) {
    errors.push("表單填寫姓名(" + formData.name + ")與可貸金額明細表姓名(" + (dMaxLoan["姓名"] || "無") + ")不符");
  }
  // 身分證號交叉檢驗 (表單 vs 登錄確認單 / 臺銀對保單)
  var confirmIdCard = (dConfirm["身分證號"] || "").toUpperCase();
  var bankIdCard = (dBank["身分證號"] || "").toUpperCase();
  if (formData.idCard !== confirmIdCard || formData.idCard !== bankIdCard) {
    errors.push("表單填寫身分證號(" + formData.idCard + ")與確認單(" + confirmIdCard + ")或對保單(" + bankIdCard + ")不一致");
  }

  // ==========================================================================
  // 【規則 2】有效學年度及學期驗證
  // 檢查三張單據是否都屬於系統當前有效學期 (如 115 學年度第 1 學期)
  // ==========================================================================
  var validSem = getSystemValidSemester();
  var docsToCheck = [
    { name: "臺銀對保單", year: dBank["學年度"], sem: dBank["學期"] },
    { name: "登錄確認單", year: dConfirm["學年度"], sem: dConfirm["學期"] },
    { name: "可貸金額明細表", year: dMaxLoan["學年度"], sem: dMaxLoan["學期"] }
  ];

  docsToCheck.forEach(function (doc) {
    var semNum = (doc.sem.indexOf("1") !== -1 || doc.sem.indexOf("上") !== -1) ? "1" :
      (doc.sem.indexOf("2") !== -1 || doc.sem.indexOf("下") !== -1) ? "2" : "";
    if (doc.year !== String(validSem.year) || semNum !== validSem.semester) {
      errors.push(doc.name + "學期無效(單據為" + doc.year + "學年度第" + semNum + "學期，當前應為" + validSem.year + "學年度第" + validSem.semester + "學期)");
    }
  });

  // ==========================================================================
  // 【規則 3】登錄確認單 vs 可貸金額明細表 之身分資料勾稽
  // (無需比對班級，只需要比對學號、姓名即可)
  // ==========================================================================
  if ((dConfirm["學號"] || "").toUpperCase() !== (dMaxLoan["學號"] || "").toUpperCase()) {
    errors.push("登錄確認單學號(" + (dConfirm["學號"] || "無") + ")與可貸金額明細表學號(" + (dMaxLoan["學號"] || "無") + ")不一致");
  }
  if ((dConfirm["姓名"] || "") !== (dMaxLoan["姓名"] || "")) {
    errors.push("登錄確認單姓名(" + (dConfirm["姓名"] || "無") + ")與可貸金額明細表姓名(" + (dMaxLoan["姓名"] || "無") + ")不一致");
  }

  // ==========================================================================
  // 【規則 4】臺銀對保單 vs 登錄確認單 之身分資料勾稽
  // (無需比對班級，只需要比對姓名、身分證號即可)
  // ==========================================================================
  if ((dBank["姓名"] || "") !== (dConfirm["姓名"] || "")) {
    errors.push("臺銀對保單姓名(" + (dBank["姓名"] || "無") + ")與登錄確認單姓名(" + (dConfirm["姓名"] || "無") + ")不一致");
  }
  if (bankIdCard !== confirmIdCard) {
    errors.push("臺銀對保單身分證號(" + bankIdCard + ")與登錄確認單身分證號(" + confirmIdCard + ")不一致");
  }

  // ==========================================================================
  // 【規則 5】上限金額不可超貸檢查
  // 臺銀對保單之學雜費、電腦網路通訊費、團保費、書籍費、實習費、住宿費、海外研修費
  // 不得大於可貸金額明細表之對應金額 (生活費除外)
  // ==========================================================================
  var itemsToCheckLimit = [
    "學雜費",
    "電腦及網路通訊使用費",
    "團體保險費",
    "書籍費",
    "實習費",
    "住宿費",
    "海外研修費"
  ];

  itemsToCheckLimit.forEach(function (item) {
    var bankAmt = parseAmount(dBank[item]);
    var maxAmt = parseAmount(dMaxLoan[item]);
    if (bankAmt > maxAmt) {
      errors.push("【" + item + "】超貸：臺銀申貸金額(" + bankAmt + "元)超過明細表上限(" + maxAmt + "元)");
    }
  });

  // ==========================================================================
  // 【規則 6】政府減免與補貼金額完全一致檢查
  // 臺銀對保單之已享有學雜費減免、行政院減免學雜費、行政院補貼校內住宿費
  // 必須與可貸金額明細表之金額完全相同 (==)
  // ==========================================================================
  var subsidyItems = [
    { key: "已享有學雜費減免", desc: "學雜費減免或教育部助學金" },
    { key: "行政院減免學雜費", desc: "行政院減免學雜費" },
    { key: "行政院補貼校內住宿費", desc: "行政院補貼校內住宿費" }
  ];

  subsidyItems.forEach(function (sub) {
    var bankAmt = parseAmount(dBank[sub.key]);
    var maxAmt = parseAmount(dMaxLoan[sub.key]);
    if (bankAmt !== maxAmt) {
      errors.push("【" + sub.desc + "】金額不符：臺銀對保單記載(" + bankAmt + "元)，可貸金額明細表記載(" + maxAmt + "元)");
    }
  });

  // ==========================================================================
  // 【規則 7】學校登錄確認單 vs 臺銀對保單 之金額完全一致性檢查
  // 登錄確認單各項費用、生活費、減免金額及撥款金額必須與臺銀對保單完全相符
  // ==========================================================================
  var allAmountItems = [
    "學雜費",
    "電腦及網路通訊使用費",
    "團體保險費",
    "書籍費",
    "實習費",
    "住宿費",
    "海外研修費",
    "生活費",
    "已享有學雜費減免",
    "行政院減免學雜費",
    "行政院補貼校內住宿費",
    "本學期撥款金額"
  ];

  allAmountItems.forEach(function (item) {
    var bankAmt = parseAmount(dBank[item]);
    var confirmAmt = parseAmount(dConfirm[item]);
    if (bankAmt !== confirmAmt) {
      errors.push("登錄確認單【" + item + "】金額(" + confirmAmt + "元)與臺銀對保單金額(" + bankAmt + "元)不符");
    }
  });

  // 綜合彙整審查結果
  var isPassed = (errors.length === 0);
  var summaryText = isPassed ? "審查通過" : "【審查不通過】" + errors.join("；");

  return {
    isPassed: isPassed,
    errorMessages: errors,
    summaryText: summaryText
  };
}


/**
 * 函式名稱：writeToRawDataSheets
 * 用途說明：
 *    將三張 PDF 解析出之明細數據，分別依序寫入試算表的「臺銀對保單」、「登錄確認單」與「可貸金額明細表」分頁。
 *    班級名稱統一以「登錄確認單」為主（無須理會臺銀對保單與可貸金額明細表是否錯誤）。
 * 參數 (Parameters)：
 *    @param {Spreadsheet} ss - 作用中的試算表物件。
 *    @param {Object} formData - 表單自填資料物件。
 *    @param {Object} resBank - 臺銀對保單解析結果。
 *    @param {Object} resConfirm - 登錄確認單解析結果。
 *    @param {Object} resMaxLoan - 可貸金額明細表解析結果。
 * 回傳值 (Returns)：
 *    無
 */
/**
 * 函式名稱：formatParseStatus
 * 用途說明：
 *    格式化 PDF 解析狀態字串，供寫入 3 個單據分頁之最後一欄。
 *    明確區分「純解析未存檔」、「已存入NAS」或「舊版NAS容器已存檔警告」，
 *    徹底避免使用者誤以為單據分頁顯示「成功」即代表錯誤檔案已被存入 NAS。
 * 參數 (Parameters)：
 *    @param {Object} res - 後端 NAS 解析回傳之結果物件。
 * 回傳值 (Returns)：
 *    @return {string} 狀態文字描述。
 */
function formatParseStatus(res) {
  if (!res) return "未執行";
  if (!res.success) return res.error || "解析失敗";
  if (res.isLegacyServer) {
    return "成功 (舊版NAS容器-已存檔，請更新重啟容器)";
  }
  if (res.saved_to_disk) {
    return "成功 (已存入NAS)";
  }
  return "成功 (純解析未存檔)";
}


/**
 * 函式名稱：writeToRawDataSheets
 * 用途說明：
 *    將三張 PDF 解析出之明細數據，分別依序寫入試算表的「臺銀對保單」、「登錄確認單」與「可貸金額明細表」分頁。
 *    第一欄一律寫入「審核序號」，以利管理者於 4 個分頁間精準跨表檢索與勾稽追蹤。
 *    班級名稱統一以「登錄確認單」為主（無須理會臺銀對保單與可貸金額明細表是否錯誤）。
 * 參數 (Parameters)：
 *    @param {Spreadsheet} ss - 作用中的試算表物件。
 *    @param {string} serialNo - 本次送審之唯一審核序號 (如 "20261109-180501")。
 *    @param {Object} formData - 表單自填資料物件。
 *    @param {Object} resBank - 臺銀對保單解析結果。
 *    @param {Object} resConfirm - 登錄確認單解析結果。
 *    @param {Object} resMaxLoan - 可貸金額明細表解析結果。
 * 回傳值 (Returns)：
 *    無
 */
function writeToRawDataSheets(ss, serialNo, formData, resBank, resConfirm, resMaxLoan) {
  var sheetBank = getOrCreateSheet(ss, SHEET_NAME_BANK, getRawSheetHeaders(true));
  var sheetConfirm = getOrCreateSheet(ss, SHEET_NAME_CONFIRM, getRawSheetHeaders(true));
  var sheetMaxLoan = getOrCreateSheet(ss, SHEET_NAME_MAX_LOAN, getRawSheetHeaders(false));

  var dBank = resBank.extracted_data || {};
  var dConfirm = resConfirm.extracted_data || {};
  var dMaxLoan = resMaxLoan.extracted_data || {};

  // 班級名稱統一以登錄確認單為主，若無則以表單自填為主
  var unifiedClass = dConfirm["班級"] || formData.class;

  // 寫入臺銀對保單分頁 (第 1 欄寫入審核序號)
  if (sheetBank) {
    sheetBank.appendRow([
      serialNo,
      dBank["學年度"] || "",
      dBank["學期"] || "",
      formData.email,
      formData.system,
      unifiedClass, // 班級統一以登錄確認單為主
      dBank["學號"] || formData.studentId,
      dBank["姓名"] || formData.name,
      dBank["身分證號"] || formData.idCard,
      dBank["學雜費"] || "",
      dBank["電腦及網路通訊使用費"] || "",
      dBank["團體保險費"] || "",
      dBank["書籍費"] || "",
      dBank["實習費"] || "",
      dBank["住宿費"] || "",
      dBank["海外研修費"] || "",
      dBank["生活費"] || "",
      dBank["已享有學雜費減免"] || "",
      dBank["行政院減免學雜費"] || "",
      dBank["行政院補貼校內住宿費"] || "",
      dBank["本學期撥款金額"] || "",
      formatParseStatus(resBank)
    ]);
  }

  // 寫入登錄確認單分頁 (第 1 欄寫入審核序號)
  if (sheetConfirm) {
    sheetConfirm.appendRow([
      serialNo,
      dConfirm["學年度"] || "",
      dConfirm["學期"] || "",
      formData.email,
      formData.system,
      unifiedClass, // 班級統一以登錄確認單為主
      dConfirm["學號"] || formData.studentId,
      dConfirm["姓名"] || formData.name,
      dConfirm["身分證號"] || formData.idCard,
      dConfirm["學雜費"] || "",
      dConfirm["電腦及網路通訊使用費"] || "",
      dConfirm["團體保險費"] || "",
      dConfirm["書籍費"] || "",
      dConfirm["實習費"] || "",
      dConfirm["住宿費"] || "",
      dConfirm["海外研修費"] || "",
      dConfirm["生活費"] || "",
      dConfirm["已享有學雜費減免"] || "",
      dConfirm["行政院減免學雜費"] || "",
      dConfirm["行政院補貼校內住宿費"] || "",
      dConfirm["本學期撥款金額"] || "",
      formatParseStatus(resConfirm)
    ]);
  }

  // 寫入可貸金額明細表分頁 (第 1 欄寫入審核序號，無身分證號欄位)
  if (sheetMaxLoan) {
    sheetMaxLoan.appendRow([
      serialNo,
      dMaxLoan["學年度"] || "",
      dMaxLoan["學期"] || "",
      formData.email,
      formData.system,
      unifiedClass, // 班級統一以登錄確認單為主
      dMaxLoan["學號"] || formData.studentId,
      dMaxLoan["姓名"] || formData.name,
      dMaxLoan["學雜費"] || "",
      dMaxLoan["電腦及網路通訊使用費"] || "",
      dMaxLoan["團體保險費"] || "",
      dMaxLoan["書籍費"] || "",
      dMaxLoan["實習費"] || "",
      dMaxLoan["住宿費"] || "",
      dMaxLoan["海外研修費"] || "",
      dMaxLoan["生活費"] || "",
      dMaxLoan["已享有學雜費減免"] || "",
      dMaxLoan["行政院減免學雜費"] || "",
      dMaxLoan["行政院補貼校內住宿費"] || "",
      dMaxLoan["本學期撥款金額"] || "",
      formatParseStatus(resMaxLoan)
    ]);
  }
}


/**
 * 函式名稱：writeToReviewResultSheet
 * 用途說明：
 *    將審查結果寫入 Google 試算表的「審查結果」專屬分頁中。
 *    定義欄位：審核序號、學年度、學期、電子郵件地址、學制、班級、學號、姓名、身分證號、審查結果、審查時間、通知信寄送狀態、NAS硬碟歸檔狀態。
 *    第一欄一律寫入「審核序號」，班級名稱統一以登錄確認單為主。
 * 參數 (Parameters)：
 *    @param {Spreadsheet} ss - 作用中的試算表物件。
 *    @param {string} serialNo - 本次送審之唯一審核序號。
 *    @param {Object} formData - 表單自填資料物件。
 *    @param {Object} resBank - 臺銀對保單解析結果。
 *    @param {Object} resConfirm - 登錄確認單解析結果。
 *    @param {Object} resMaxLoan - 可貸金額明細表解析結果。
 *    @param {Object} reviewResult - 勾稽審查結果物件。
 *    @param {Object} [mailSendResult] - 郵件發送結果物件 { success: boolean, method: string, reason: string }。
 *    @param {Object} [nasArchiveResult] - NAS 歸檔結果物件 { success: boolean, message: string, folder: string }。
 * 回傳值 (Returns)：
 *    無
 */
function writeToReviewResultSheet(ss, serialNo, formData, resBank, resConfirm, resMaxLoan, reviewResult, mailSendResult, nasArchiveResult) {
  var headers = [
    "審核序號",
    "學年度",
    "學期",
    "電子郵件地址",
    "學制",
    "班級",
    "學號",
    "姓名",
    "身分證號",
    "審查結果",
    "審查時間",
    "通知信寄送狀態",
    "NAS硬碟歸檔狀態"
  ];
  var sheetResult = getOrCreateSheet(ss, SHEET_NAME_RESULT, headers);

  var dConfirm = resConfirm.extracted_data || {};
  var dBank = resBank.extracted_data || {};

  var displayYear = (dConfirm && dConfirm["學年度"]) || (dBank && dBank["學年度"]) || "";
  var displaySem = (dConfirm && dConfirm["學期"]) || (dBank && dBank["學期"]) || "";
  var unifiedClass = (dConfirm && dConfirm["班級"]) || formData.class; // 班級統一以登錄確認單為主
  var displayId = formData.studentId;
  var displayName = formData.name;
  var displayIdCard = formData.idCard;
  var reviewTime = Utilities.formatDate(new Date(), "GMT+8", "yyyy/MM/dd HH:mm:ss");

  var mailStatusText = "未發送";
  if (mailSendResult) {
    if (mailSendResult.success) {
      mailStatusText = "✓ 已發送 (" + (mailSendResult.method || "MailApp") + ")";
    } else {
      mailStatusText = "✕ 失敗 (" + (mailSendResult.reason || "未知原因") + ")";
    }
  }

  var nasStatusText = "未執行";
  if (nasArchiveResult) {
    if (nasArchiveResult.success) {
      nasStatusText = "✓ 已歸檔 (" + (nasArchiveResult.folder || "") + ")";
    } else {
      nasStatusText = nasArchiveResult.message || "✕ 略過未歸檔";
    }
  }

  sheetResult.appendRow([
    serialNo,
    displayYear,
    displaySem,
    formData.email,
    formData.system,
    unifiedClass,
    displayId,
    displayName,
    displayIdCard,
    reviewResult.summaryText,
    reviewTime,
    mailStatusText,
    nasStatusText
  ]);
}


/**
 * 函式名稱：deleteDriveFiles
 * 用途說明：
 *    於資料處理完畢後，將留存於 Google 雲端硬碟的學生上傳暫存 PDF 檔案移入垃圾桶。
 *    防止敏感學生個資長期滯留雲端硬碟並自動釋放儲存空間。
 * 參數 (Parameters)：
 *    @param {Array<string>} fileUrls - 包含三份 PDF 的 Google Drive 檔案連結陣列。
 * 回傳值 (Returns)：
 *    無
 */
function deleteDriveFiles(fileUrls) {
  if (!fileUrls || !Array.isArray(fileUrls)) return;

  fileUrls.forEach(function (url) {
    if (!url) return;
    try {
      var match = url.match(/id=([^&]+)/) || url.match(/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        var file = DriveApp.getFileById(match[1]);
        file.setTrashed(true); // 移至垃圾桶 (安全刪除)
        Logger.log("成功刪除 Drive 暫存檔案：" + match[1]);
      }
    } catch (e) {
      Logger.log("刪除 Drive 暫存檔案失敗 (" + url + ")：" + e.toString());
    }
  });
}


/**
 * 函式名稱：sendReviewResultEmail
 * 用途說明：
 *    發送就學貸款初審結果 Email 通知學生。
 *    全面強化與相容性修復：
 *    1. 主旨加入動態唯一審核序號流水號 (yyyyMMdd-HHmmss)，徹底防止 Gmail 判定為重複郵件而將內文自動「折疊/剪裁 (Trimmed content)」造成空白。
 *    2. 內文所有欄位與錯誤清單一律經過 escapeHtml 轉義，徹底杜絕包含 <、> 符號 (如超貸 > 符號或 Python 伺服器異常) 導致郵件 HTML 結構損毀。
 *    3. HTML 最外層設定強制背景色 (#ffffff) 與文字顏色 (#333333)，完全相容深色模式與各類校園 Webmail。
 *    4. 傳入必填純文字屬性 body（修復 Exception: Invalid argument: body）。
 *    5. 實作 MailApp + GmailApp 雙重發信備援機制，提升寄達率。
 *    6. 審查合格通知內文依需求維護為最新規範（含生活費與多貸退費作業時間注意事項）。
 * 參數 (Parameters)：
 *    @param {string} toEmail - 收件人電子郵件地址。
 *    @param {string} studentId - 學生學號。
 *    @param {string} studentName - 學生姓名。
 *    @param {string} year - 學年度 (如 "115")。
 *    @param {string} semester - 學期 (如 "第1學期")。
 *    @param {boolean} isPassed - 審查是否通過。
 *    @param {Array<string>} errorMessages - 不合格時之條列原因陣列。
 *    @param {string} [serialNo] - 審核序號 (選填，若未傳入則自動生成)。
 * 回傳值 (Returns)：
 *    @return {Object} 發信結果物件：
 *        - success (boolean): 是否成功寄出
 *        - method (string): 寄送方式 ("MailApp" / "GmailApp")
 *        - reason (string): 失敗時之具體原因描述
 */
function sendReviewResultEmail(toEmail, studentId, studentName, year, semester, isPassed, errorMessages, serialNo) {
  if (!toEmail || toEmail.indexOf("@") === -1) {
    var noEmailMsg = "未提供有效收件信箱 (值: '" + toEmail + "')，略過寄信。";
    Logger.log("【發信略過】" + noEmailMsg);
    return { success: false, method: "", reason: noEmailMsg };
  }

  // 安全後備變數處理，杜絕 undefined 或空字串
  var sName = (studentName && String(studentName).trim()) ? String(studentName).trim() : "同學";
  var sId = (studentId && String(studentId).trim()) ? String(studentId).trim() : "";
  var sYear = (year && String(year).trim()) ? String(year).trim() : "115";
  var sSem = (semester && String(semester).trim()) ? String(semester).trim() : "第1學期";

  // 建立唯一流水序號 (優先採用傳入之序號以確保 4 個分頁與信件一致，防 Gmail 郵件對話串摺疊)
  var effectiveSerialNo = (serialNo && String(serialNo).trim()) ?
    String(serialNo).trim() :
    Utilities.formatDate(new Date(), "GMT+8", "yyyyMMdd-HHmmss");

  var subject = isPassed ?
    "【就學貸款初審合格通知】南臺科技大學 " + sYear + "學年度" + sSem + " 就貸資料審核通過 (序號：" + effectiveSerialNo + ")" :
    "【重要通知：就貸初審未通過】南臺科技大學 " + sYear + "學年度" + sSem + " 就貸資料補正通知 (序號：" + effectiveSerialNo + ")";

  // 純文字備援內容 (Plain Text Fallback，MailApp.sendEmail 之必備屬性)
  var plainBody = "";
  if (isPassed) {
    plainBody =
      sName + " 同學" + (sId ? "（學號：" + sId + "）" : "") + "您好：\n\n" +
      "您於 Google 表單送交之 " + sYear + " 學年度 " + sSem + " 就學貸款申請單據，經系統自動比對勾稽，結果為：\n" +
      "【審查結果】：✓ 審查通過\n\n" +
      "各項文件金額與身分資料核對無誤，後續如有問題會發E-Mail通知，請勿重複繳交紙本。\n\n" +
      "【注意事項】\n" +
      "1. 生活費核撥時間約為期中考(第9週)過後(約為每年4月及11月中下旬)。\n" +
      "2. 申貸書籍費、校外住宿費等多貸退費，預計完成作業時間將延後至第18週前後(約為每年6月及1月底)。\n" +
      "※請注意：此為承辦人完成作業時間，不包含會計室及出納組內部作業流程時間，實際撥款時間一定會延後！承辦人員一直都是加快速度作業，儘量讓同學能盡速領到多貸退費撥款。惟限於實際作業狀況，不一定每次都能在第18週讓同學收到撥款。\n" +
      "3. 詳情請參閱【如何辦理就學貸款】(https://sites.google.com/stust.edu.tw/loan/) 及【就學貸款相關問題】(https://sites.google.com/stust.edu.tw/loan/FAQ)。\n\n" +
      "審核序號：" + effectiveSerialNo + "\n" +
      "此郵件為系統自動發送，請勿直接回覆。\n" +
      "南臺科技大學 學務處課外活動組 敬啟";
  } else {
    var rawErrList = (Array.isArray(errorMessages) && errorMessages.length > 0) ?
      errorMessages : ["送審資料比對不合或單據解析異常，請詳閱單據內容並更正。"];

    var errTextList = rawErrList.map(function (msg, i) {
      return (i + 1) + ". " + msg;
    }).join("\n");

    plainBody =
      sName + " 同學" + (sId ? "（學號：" + sId + "）" : "") + "您好：\n\n" +
      "您送交之 " + sYear + " 學年度 " + sSem + " 就學貸款申請資料，經系統比對發現有不符合之項目，初審結果為：\n" +
      "【審查結果】：✕ 審查不通過 (待補正)\n\n" +
      "【不符合項目與原因清單】\n" +
      errTextList + "\n\n" +
      "【補正辦理說明】\n" +
      "1. 如為金額填寫錯誤或超貸，請重新至學校就貸系統更正登錄並重新列印確認單，或向臺灣銀行辦理更正。\n" +
      "2. 如為檔案上傳錯誤（例如上傳過期舊單據、非對保單、密碼錯誤），請確認下載正確 PDF 後重新填表。\n" +
      "3. 修正完成後，請重新填寫 Google 表單並重新上傳 3 份正確 PDF 檔案。\n\n" +
      "審核序號：" + effectiveSerialNo + "\n" +
      "此郵件為系統自動發送，請勿直接回覆。\n" +
      "南臺科技大學 學務處課外活動組 敬啟";
  }

  // HTML 美化排版內容 (全面轉義保護與深色模式背景相容)
  var bodyHtml = "";
  if (isPassed) {
    bodyHtml =
      "<div style='background-color: #ffffff; color: #333333; font-family: Arial, \"Microsoft JhengHei\", sans-serif; max-width: 650px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;'>" +
      "  <div style='background-color: #2e7d32; color: #ffffff; padding: 20px; text-align: center;'>" +
      "    <h2 style='margin: 0; color: #ffffff;'>南臺科技大學 學務處課外活動組</h2>" +
      "    <h3 style='margin: 10px 0 0 0; font-weight: normal; color: #e8f5e9;'>就學貸款申貸資料自動審查結果通知</h3>" +
      "  </div>" +
      "  <div style='padding: 24px; color: #333333; line-height: 1.8;'>" +
      "    <p><strong>" + escapeHtml(sName) + "</strong> 同學" + (sId ? "（學號：<strong>" + escapeHtml(sId) + "</strong>）" : "") + "您好：</p>" +
      "    <p>您於 Google 表單送交之 <strong>" + escapeHtml(sYear) + " 學年度 " + escapeHtml(sSem) + "</strong> 就學貸款申請單據，經系統自動比對勾稽，結果為：</p>" +
      "    <div style='background-color: #e8f5e9; border-left: 6px solid #4caf50; padding: 15px; margin: 15px 0; font-size: 18px; font-weight: bold; color: #2e7d32;'>" +
      "      ✓ 審查通過" +
      "    </div>" +
      "    <p style='font-size: 16px; font-weight: bold; color: #1b5e20; background-color: #f1f8e9; padding: 12px 16px; border-radius: 6px;'>" +
      "      各項文件金額與身分資料核對無誤，後續如有問題會發E-Mail通知，請勿重複繳交紙本。" +
      "    </p>" +
      "    <p><strong>【注意事項】</strong></p>" +
      "    <ol style='padding-left: 20px; margin: 10px 0;'>" +
      "      <li style='margin-bottom: 8px;'>生活費核撥時間約為期中考(第9週)過後(約為每年4月及11月中下旬)。</li>" +
      "      <li style='margin-bottom: 8px;'>" +
      "        申貸書籍費、校外住宿費等多貸退費，預計完成作業時間將延後至第18週前後(約為每年6月及1月底)。<br>" +
      "        <span style='color: #c62828; font-weight: bold;'>※請注意：</span>此為承辦人完成作業時間，不包含會計室及出納組內部作業流程時間，實際撥款時間一定會延後！承辦人員一直都是加快速度作業，儘量讓同學能盡速領到多貸退費撥款。惟限於實際作業狀況，不一定每次都能在第18週讓同學收到撥款。" +
      "      </li>" +
      "      <li style='margin-bottom: 8px;'>" +
      "        詳情請參閱【<a href='https://sites.google.com/stust.edu.tw/loan/' target='_blank' style='color: #1565c0; text-decoration: underline; font-weight: bold;'>如何辦理就學貸款</a>】及【<a href='https://sites.google.com/stust.edu.tw/loan/FAQ' target='_blank' style='color: #1565c0; text-decoration: underline; font-weight: bold;'>就學貸款相關問題</a>】。" +
      "      </li>" +
      "    </ol>" +
      "  </div>" +
      "  <div style='background-color: #f5f5f5; color: #777777; font-size: 13px; padding: 15px; text-align: center; border-top: 1px solid #e0e0e0;'>" +
      "    審核序號：" + effectiveSerialNo + "<br>此郵件為系統自動發送，請勿直接回覆。" +
      "  </div>" +
      "</div>";
  } else {
    var rawErrors = (Array.isArray(errorMessages) && errorMessages.length > 0) ?
      errorMessages : ["送審資料比對不合或單據解析異常，請詳閱單據內容並更正。"];

    var errorListItems = "";
    rawErrors.forEach(function (msg) {
      errorListItems += "<li style='margin-bottom: 8px;'>" + escapeHtml(msg) + "</li>";
    });

    bodyHtml =
      "<div style='background-color: #ffffff; color: #333333; font-family: Arial, \"Microsoft JhengHei\", sans-serif; max-width: 650px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;'>" +
      "  <div style='background-color: #c62828; color: #ffffff; padding: 20px; text-align: center;'>" +
      "    <h2 style='margin: 0; color: #ffffff;'>南臺科技大學 學務處課外活動組</h2>" +
      "    <h3 style='margin: 10px 0 0 0; font-weight: normal; color: #ffebee;'>就學貸款申貸資料【初審未通過】補正通知</h3>" +
      "  </div>" +
      "  <div style='padding: 24px; color: #333333; line-height: 1.8;'>" +
      "    <p><strong>" + escapeHtml(sName) + "</strong> 同學" + (sId ? "（學號：<strong>" + escapeHtml(sId) + "</strong>）" : "") + "您好：</p>" +
      "    <p>您送交之 <strong>" + escapeHtml(sYear) + " 學年度 " + escapeHtml(sSem) + "</strong> 就學貸款申請資料，經系統比對發現有不符合之項目，初審結果為：</p>" +
      "    <div style='background-color: #ffebee; border-left: 6px solid #e53935; padding: 15px; margin: 15px 0; font-size: 18px; font-weight: bold; color: #c62828;'>" +
      "      ✕ 審查不通過 (待補正)" +
      "    </div>" +
      "    <p><strong>【不符合項目與原因清單】</strong></p>" +
      "    <ul style='color: #d32f2f; background-color: #fafafa; padding: 15px 25px; border-radius: 4px;'>" +
      errorListItems +
      "    </ul>" +
      "    <p><strong>【補正辦理說明】</strong></p>" +
      "    <ol style='padding-left: 20px; margin: 10px 0;'>" +
      "      <li style='margin-bottom: 8px;'>如為<strong>金額填寫錯誤</strong>或<strong>超貸</strong>，請重新至學校就貸系統更正登錄並重新列印確認單，或向臺灣銀行辦理更正。</li>" +
      "      <li style='margin-bottom: 8px;'>如為<strong>檔案上傳錯誤</strong>（例如上傳過期舊單據、非對保單、密碼錯誤），請確認下載正確 PDF 後重新填表。</li>" +
      "      <li style='margin-bottom: 8px;'>修正完成後，請重新填寫 Google 表單並重新上傳 3 份正確 PDF 檔案。</li>" +
      "    </ol>" +
      "  </div>" +
      "  <div style='background-color: #f5f5f5; color: #777777; font-size: 13px; padding: 15px; text-align: center; border-top: 1px solid #e0e0e0;'>" +
      "    審核序號：" + effectiveSerialNo + "<br>此郵件為系統自動發送，請勿直接回覆。" +
      "  </div>" +
      "</div>";
  }

  Logger.log("【發送審查結果郵件】目標：" + toEmail + " | 序號：" + effectiveSerialNo + " | 審查通過：" + isPassed +
    " | 純文字長度：" + plainBody.length + " | HTML長度：" + bodyHtml.length);

  // 雙重發信機制：優先使用 MailApp，若遭遇錯誤自動退回使用 GmailApp
  try {
    MailApp.sendEmail({
      to: toEmail,
      subject: subject,
      body: plainBody, // 補齊必備純文字屬性
      htmlBody: bodyHtml
    });
    Logger.log("【MailApp 成功發送】已成功發送審查結果郵件至：" + toEmail);
    return { success: true, method: "MailApp", reason: "" };
  } catch (mailErr) {
    Logger.log("【MailApp 發送失敗，嘗試切換為 GmailApp 備援】原因：" + mailErr.toString());
    try {
      GmailApp.sendEmail(toEmail, subject, plainBody, {
        htmlBody: bodyHtml
      });
      Logger.log("【GmailApp 備援成功】已成功發送審查結果郵件至：" + toEmail);
      return { success: true, method: "GmailApp", reason: "" };
    } catch (gmailErr) {
      var fullErrMsg = "MailApp 失敗 (" + mailErr.message + ") 且 GmailApp 備援亦失敗 (" + gmailErr.message + ")";
      Logger.log("【重大發信異常】" + fullErrMsg);
      return { success: false, method: "", reason: fullErrMsg };
    }
  }
}


/**
 * 函式名稱：doGet
 * 用途說明：
 *    提供給外部學生查詢介面（GitHub Pages 前端 或 Google Sites 嵌入網頁）之 RESTful JSON API。
 *    接收 URL 參數：?action=query&student_id=XXXXXX
 *    搜尋「審查結果」分頁中最新一筆該學號之審查紀錄，回傳 JSON 物件。
 *    已進行姓名部分遮罩 (例如：周○真) 與隱藏身分證號，確保個資隱私安全。
 * 參數 (Parameters)：
 *    @param {Object} e - HTTP GET 請求事件物件，包含 e.parameter 查詢參數。
 * 回傳值 (Returns)：
 *    @return {TextOutput} JSON 格式文字輸出，包含 MIME 類型 application/json。
 */
function doGet(e) {
  var output = {
    status: "error",
    message: "無效請求"
  };

  try {
    var params = e ? e.parameter : {};
    var action = params.action;
    var targetStudentId = (params.student_id || "").trim().toUpperCase();

    if (action === "query" && targetStudentId) {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getSheetByName(SHEET_NAME_RESULT);

      if (!sheet) {
        output = { status: "error", message: "系統尚未建立審查結果資料表" };
      } else {
        var data = sheet.getDataRange().getValues();
        var foundRow = null;

        // 從最後一列往前搜尋，取得該學號最新一次的審查紀錄 (相容索引 0 為審核序號之新格式與舊格式)
        for (var i = data.length - 1; i >= 1; i--) {
          var row = data[i];
          var idColNew = String(row[6] || "").trim().toUpperCase(); // 新欄位：第 6 欄為學號
          var idColOld = String(row[5] || "").trim().toUpperCase(); // 舊欄位：第 5 欄為學號
          if (idColNew === targetStudentId || idColOld === targetStudentId) {
            foundRow = row;
            break;
          }
        }

        if (foundRow) {
          // 判斷是否為帶有序號的新版結構 (若 row[0] 為序號格式)
          var hasSerialCol = String(foundRow[0] || "").indexOf("-") !== -1 && String(foundRow[0] || "").length >= 10;
          var offset = hasSerialCol ? 1 : 0;

          var rawName = String(foundRow[6 + offset] || foundRow[6] || "");
          var maskedName = rawName.length <= 2 ?
            rawName.charAt(0) + "○" :
            rawName.charAt(0) + "○" + rawName.slice(2);

          output = {
            status: "success",
            data: {
              serial_no: hasSerialCol ? String(foundRow[0] || "") : "",
              year: String(foundRow[0 + offset] || ""),
              semester: String(foundRow[1 + offset] || ""),
              education_system: String(foundRow[3 + offset] || ""),
              student_class: String(foundRow[4 + offset] || ""),
              student_id: String(foundRow[5 + offset] || ""),
              student_name: maskedName,
              review_result: String(foundRow[8 + offset] || ""),
              review_time: String(foundRow[9 + offset] || ""),
              nas_archive_status: hasSerialCol ? String(foundRow[12] || "") : ""
            }
          };
        } else {
          output = {
            status: "not_found",
            message: "查無此學號之就貸送審資料，請確認學號是否正確或尚未完成表單填報。"
          };
        }
      }
    } else {
      output = { status: "error", message: "請提供查詢學號 (student_id)" };
    }
  } catch (err) {
    output = { status: "error", message: "查詢伺服器發生異常：" + err.toString() };
  }

  return ContentService.createTextOutput(JSON.stringify(output))
    .setMimeType(ContentService.MimeType.JSON);
}


// ==============================================================================
// 輔助與公用函式群
// ==============================================================================

/**
 * 函式名稱：getFileBlobFromUrl
 * 用途說明：
 *    從 Google Drive 檔案分享連結中解析 File ID，並以 Blob 二進位物件讀取檔案。
 * 參數 (Parameters)：
 *    @param {string} url - Google Drive 檔案連結網址。
 * 回傳值 (Returns)：
 *    @return {Blob} 檔案之 Blob 物件。
 */
function getFileBlobFromUrl(url) {
  if (!url) throw new Error("傳入之 Drive 連結為空值");
  var match = url.match(/id=([^&]+)/) || url.match(/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) {
    return DriveApp.getFileById(match[1]).getBlob();
  }
  throw new Error("無法從連結中解析 Google Drive 檔案 ID：" + url);
}


/**
 * 函式名稱：sendToNasApi
 * 用途說明：
 *    將 PDF 檔案轉為 Base64 字串，發送 HTTP POST 請求至 QNAP NAS 之 Tailscale Funnel API 進行解密與欄位文字解析。
 *    預設 saveToDisk 為 false，落實「初審通過後再儲存，未通過不存錯誤檔案」原則。
 * 參數 (Parameters)：
 *    @param {Blob} fileBlob - PDF 檔案 Blob 物件。
 *    @param {string} password - 解密密碼（對保單傳入身分證字號，其餘單據為空字串）。
 *    @param {string} saveFilename - 預計儲存之檔名標籤。
 *    @param {boolean} [saveToDisk=false] - 是否直接存入 NAS 硬碟（預設 false 純解析驗證）。
 * 回傳值 (Returns)：
 *    @return {Object} 後端 Flask API 回傳之 JSON 物件，附加 success 與 error 欄位。
 */
function sendToNasApi(fileBlob, password, saveFilename, saveToDisk) {
  var base64Data = Utilities.base64Encode(fileBlob.getBytes());
  var payload = {
    "save_filename": saveFilename,
    "file_base64": base64Data,
    "password": password || "",
    "save_to_disk": !!saveToDisk
  };

  var options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  var response = UrlFetchApp.fetch(NAS_TAILSCALE_URL, options);
  var statusCode = response.getResponseCode();
  var responseText = response.getContentText();

  if (statusCode === 200) {
    var res = JSON.parse(responseText);
    res.success = true;

    // 檢測 NAS 是否為最新版本 (v2.1.0)
    // 舊版容器特徵：無 version 屬性，或明明 saveToDisk=false 但 NAS 回傳 saved_to_disk=true 或無此欄位
    if (!res.version || (!saveToDisk && res.saved_to_disk === true) || res.saved_to_disk === undefined) {
      Logger.log("【架構警示】NAS 目前運行舊版 Docker 容器（無純記憶體解析），實體檔案已被舊版容器自動寫入硬碟！請至 NAS 重新建置並重啟 Docker 容器。");
      res.isLegacyServer = true;
    } else {
      res.isLegacyServer = false;
    }
    return res;
  } else {
    var errMsg = responseText;
    try {
      var errObj = JSON.parse(responseText);
      if (errObj.error) errMsg = errObj.error;
    } catch (e) { }
    return {
      success: false,
      error: errMsg,
      extracted_data: {}
    };
  }
}


/**
 * 函式名稱：archiveApprovedPdfsToNas
 * 用途說明：
 *    當就學貸款申請資料經「七大核心審查規則」勾稽判定「初審合格 (isPassed === true)」後，
 *    呼叫 NAS 後端專屬歸檔 API，將 3 份合格 PDF（臺銀對保單、登錄確認單、可貸金額明細表）
 *    正式歸檔儲存至 NAS 硬碟 /share/CACHEDEV2_DATA/課外組公用/【就貸專區】/PDF 底下建立的學期專屬子目錄中（如 115-1/）。
 *    若初審不通過，則完全不呼叫此函式，100% 杜絕錯誤檔案存入 NAS！
 * 參數 (Parameters)：
 *    @param {string} year - 學年度 (如 "115")。
 *    @param {string} semester - 學期代碼 ("1" 或 "2" 或 "第1學期")。
 *    @param {string} studentId - 學生學號 (如 "4B180109")。
 *    @param {string} studentName - 學生姓名 (如 "陳玉瑧")。
 *    @param {Blob} blobBank - 臺銀對保單檔案 Blob 物件。
 *    @param {Blob} blobConfirm - 已登錄確認單檔案 Blob 物件。
 *    @param {Blob} blobMaxLoan - 可貸金額明細表檔案 Blob 物件。
 * 回傳值 (Returns)：
 *    @return {Object} 歸檔儲存結果物件：
 *        - success (boolean): 是否全數成功儲存
 *        - message (string): 結果說明訊息
 *        - folder (string): 學期目錄名稱 (如 "115-1")
 */
function archiveApprovedPdfsToNas(year, semester, studentId, studentName, blobBank, blobConfirm, blobMaxLoan) {
  try {
    // 動態建構 NAS 歸檔 API 端點 (將尾端 /api/parse_pdf 替換為 /api/archive_approved_pdfs)
    var archiveUrl = NAS_TAILSCALE_URL.replace(/\/api\/parse_pdf\/?$/, "/api/archive_approved_pdfs");
    if (archiveUrl.indexOf("/api/archive_approved_pdfs") === -1) {
      archiveUrl = archiveUrl.replace(/\/+$/, "") + "/api/archive_approved_pdfs";
    }

    var semNum = "1";
    if (semester && (semester.indexOf("2") !== -1 || semester.indexOf("下") !== -1)) {
      semNum = "2";
    }

    var filesPayload = [
      {
        doc_type: "臺銀對保單",
        file_base64: Utilities.base64Encode(blobBank.getBytes())
      },
      {
        doc_type: "已登錄確認單",
        file_base64: Utilities.base64Encode(blobConfirm.getBytes())
      },
      {
        doc_type: "可貸金額明細表",
        file_base64: Utilities.base64Encode(blobMaxLoan.getBytes())
      }
    ];

    var payload = {
      year: String(year),
      semester: semNum,
      student_id: String(studentId),
      student_name: String(studentName),
      files: filesPayload
    };

    var options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(archiveUrl, options);
    var statusCode = response.getResponseCode();
    var responseText = response.getContentText();

    if (statusCode === 200) {
      var res = JSON.parse(responseText);
      Logger.log("【NAS 歸檔成功】" + (res.message || "3份合格單據已儲存至學期專屬目錄"));
      return { success: true, message: res.message || "已成功歸檔至NAS", folder: res.semester_folder || (year + "-" + semNum) };
    } else {
      var errReason = responseText;
      try {
        var errObj = JSON.parse(responseText);
        if (errObj.error) errReason = errObj.error;
      } catch (e) { }
      Logger.log("【NAS 歸檔失敗】HTTP " + statusCode + "：" + errReason);
      return { success: false, message: "NAS歸檔失敗：" + errReason, folder: "" };
    }
  } catch (err) {
    Logger.log("【NAS 歸檔例外異常】" + err.toString());
    return { success: false, message: "NAS連線異常：" + err.message, folder: "" };
  }
}


/**
 * 函式名稱：cleanupRejectedPdfsFromNas
 * 用途說明：
 *    當初審未通過時，呼叫 NAS 端專屬清除端點 (/api/cleanup_rejected_pdfs)，
 *    主動清查並刪除該學期目錄下該學號之殘留檔案（作為雙重防呆，防範舊版容器快取誤存），
 *    確保 NAS 硬碟 100% 絕對乾淨、不留存任何錯誤檔案。
 * 參數 (Parameters)：
 *    @param {string} year - 學年度 (如 "115")
 *    @param {string} semester - 學期 ("第1學期" 或 "1")
 *    @param {string} studentId - 學號 (如 "4B180109")
 * 回傳值 (Returns)：
 *    @return {Object} 清理結果物件 { success: boolean, deleted_count: number }
 */
function cleanupRejectedPdfsFromNas(year, semester, studentId) {
  try {
    var cleanUrl = NAS_TAILSCALE_URL.replace(/\/api\/parse_pdf\/?$/, "/api/cleanup_rejected_pdfs");
    if (cleanUrl.indexOf("/api/cleanup_rejected_pdfs") === -1) {
      cleanUrl = cleanUrl.replace(/\/+$/, "") + "/api/cleanup_rejected_pdfs";
    }

    var semNum = "1";
    if (semester && (semester.indexOf("2") !== -1 || semester.indexOf("下") !== -1)) {
      semNum = "2";
    }

    var payload = {
      year: String(year),
      semester: semNum,
      student_id: String(studentId)
    };

    var options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(cleanUrl, options);
    if (response.getResponseCode() === 200) {
      var res = JSON.parse(response.getContentText());
      Logger.log("【NAS 錯誤檔案清理結果】" + res.message);
      return { success: true, deleted_count: res.deleted_count || 0 };
    }
  } catch (err) {
    Logger.log("【NAS 錯誤檔案清理略過】" + err.toString());
  }
  return { success: false, deleted_count: 0 };
}


/**
 * 函式名稱：parseAmount
 * 用途說明：
 *    安全轉換金額字串為整數數值。
 *    自動移除逗號千分號 (,)、正負號、空白與中文字元。空值安全轉換為 0。
 * 參數 (Parameters)：
 *    @param {string|number} raw - 原始金額字串或數值。
 * 回傳值 (Returns)：
 *    @return {number} 正整數絕對值。
 */
function parseAmount(raw) {
  if (raw === undefined || raw === null || raw === "") return 0;
  var cleaned = String(raw).replace(/[,，\s+元整]/g, "").replace(/-/g, "");
  var num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}


/**
 * 函式名稱：getSystemValidSemester
 * 用途說明：
 *    計算當前有效學年度與學期代碼。
 *    8/1 ~ 翌年 1/14 為 第1學期 (上學期)；1/15 ~ 7/31 為 第2學期 (下學期)。
 * 參數 (Parameters)：
 *    無
 * 回傳值 (Returns)：
 *    @return {Object} { year: 115, semester: "1" }
 */
function getSystemValidSemester() {
  var now = new Date();
  var fullYear = now.getFullYear();
  var rocYear = fullYear - 1911;
  var month = now.getMonth() + 1; // 1-12
  var day = now.getDate();

  if (month >= 8) {
    return { year: rocYear, semester: "1" };
  } else if (month === 1 && day <= 14) {
    return { year: rocYear - 1, semester: "1" };
  } else {
    return { year: rocYear - 1, semester: "2" };
  }
}


/**
 * 函式名稱：getOrCreateSheet
 * 用途說明：
 *    取得指定名稱之工作表，若該分頁不存在則自動建立並填入標題列。
 *    具備智慧自動升級欄位機制：
 *    若工作表已存在但第 1 欄尚無「審核序號」，則自動在最左側插入新欄位並標記，確保現存舊資料不發生欄位錯位。
 * 參數 (Parameters)：
 *    @param {Spreadsheet} ss - 作用中的試算表物件。
 *    @param {string} sheetName - 分頁名稱。
 *    @param {Array<string>} headers - 標題列欄位文字陣列。
 * 回傳值 (Returns)：
 *    @return {Sheet} 工作表物件。
 */
function getOrCreateSheet(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (headers && headers.length > 0) {
      sheet.appendRow(headers);
      var headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#f3f3f3");
    }
  } else {
    // 智慧欄位升級防呆：檢查現存分頁第 1 欄是否為「審核序號」
    if (headers && headers.length > 0 && sheet.getLastRow() >= 1) {
      var firstCellVal = String(sheet.getRange(1, 1).getValue() || "").trim();
      if (firstCellVal !== "審核序號" && firstCellVal !== "序號") {
        sheet.insertColumnBefore(1);
        var cellA1 = sheet.getRange(1, 1);
        cellA1.setValue("審核序號");
        cellA1.setFontWeight("bold");
        cellA1.setBackground("#f3f3f3");
        Logger.log("【自動欄位升級】已於分頁 [" + sheetName + "] 最左側成功插入第 1 欄「審核序號」");
      }

      // 若為「審查結果」分頁且尚未具備「NAS硬碟歸檔狀態」標題，自動於末欄補齊
      if (sheetName === SHEET_NAME_RESULT) {
        var lastCol = sheet.getLastColumn();
        var lastHeaderVal = String(sheet.getRange(1, lastCol).getValue() || "").trim();
        if (lastHeaderVal !== "NAS硬碟歸檔狀態") {
          var newCell = sheet.getRange(1, lastCol + 1);
          newCell.setValue("NAS硬碟歸檔狀態");
          newCell.setFontWeight("bold");
          newCell.setBackground("#f3f3f3");
          Logger.log("【自動欄位升級】已於「審查結果」分頁補齊「NAS硬碟歸檔狀態」標題欄位");
        }
      }
    }
  }
  return sheet;
}


/**
 * 函式名稱：getRawSheetHeaders
 * 用途說明：
 *    取得原始單據分頁之標準標題列欄位。
 *    第 1 欄統一規範為「審核序號」，以利管理者橫向貫穿 4 個分頁比對。
 * 參數 (Parameters)：
 *    @param {boolean} hasIdCard - 是否包含身分證號欄位 (對保單與確認單為 true，明細表為 false)。
 * 回傳值 (Returns)：
 *    @return {Array<string>} 標題列陣列。
 */
function getRawSheetHeaders(hasIdCard) {
  var headers = [
    "審核序號",
    "學年度",
    "學期",
    "電子郵件地址",
    "學制",
    "班級",
    "學號",
    "姓名"
  ];
  if (hasIdCard) {
    headers.push("身分證號");
  }
  headers.push(
    "學雜費",
    "電腦及網路通訊使用費",
    "團體保險費",
    "書籍費",
    "實習費",
    "住宿費",
    "海外研修費",
    "生活費",
    "已享有學雜費減免",
    "行政院減免學雜費",
    "行政院補貼校內住宿費",
    "本學期撥款金額",
    "解析狀態"
  );
  return headers;
}
