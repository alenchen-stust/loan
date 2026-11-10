# 學生就學貸款 PDF 自動化審查與歸檔系統

南臺科技大學學務處課外活動組就學貸款憑證自動化文字解析、邏輯審查、實體 NAS 分學期歸檔、雲端硬碟清理、自動 Email 通知與學生線上即時查詢系統。

---

## 壹、 專案運作機制與優缺點深度分析（文字紀錄）

### 1.1 運作機制分析
本系統串聯「Google 表單 / 雲端硬碟」、「內網 QNAP NAS (Docker Flask 容器)」、「Tailscale Funnel 安全穿透」與「GitHub Pages / Google Sites 線上查詢系統」，具體運作流程如下：
1. **學生送件**：學生填寫 Google 表單並上傳三份核心就貸憑證 PDF（**臺銀對保單**、**已登錄確認單**、**可貸金額明細表**）至 Google Drive。
2. **事件觸發**：表單提交自動觸發 Google Apps Script (GAS) 的 `onFormSubmitHandler` 函式。
3. **安全通訊**：GAS 將三份 PDF 轉換為二進位 Base64 編碼，透過 **Tailscale Funnel** 提供的專屬 HTTPS 加密網域，安全穿透進學校內網 QNAP NAS 的 Port 55000。
4. **解密與特徵辨識 (NAS 端)**：
   - 使用學生身分證號為密碼，利用 `PyPDF2` 解密臺銀對保單，驗證背景浮水印次數（防偽檢查）與是否有蓋印圖片。
   - 使用 `pdfplumber` (layout=True) 保持視覺版面，萃取已登錄確認單與可貸金額明細表之文字表格。
   - **針對可貸金額明細表校外住宿費進行排版容錯處理**，精確擷取上一行之住宿費金額（如 `19,200`）。
5. **動態學期目錄建置與實體歸檔**：
   - 依據當前系統日期，動態判定學年度與學期（例如 115 學年度第 1 學期）。
   - 自動在 NAS 硬碟 `/share/CACHEDEV2_DATA/課外組公用/【就貸專區】/PDF` 底下建立學期專屬子目錄（例如 `115-1/`），並依 `學年度-學期-學號姓名-單據類型.pdf` 規範儲存。
6. **七大核心規則勾稽審查 (GAS 端)**：
   - 對比學生自填資料與三份單據之學號、姓名、班級、身分證號。
   - 驗證單據學期是否屬於當前有效期間（115-1: 115/8/1~116/1/14；115-2: 116/1/15~116/7/31）。
   - 核對申貸金額是否超過可貸上限（生活費除外）。
   - 檢查政府減免與住宿補貼金額是否完全一致。
   - 檢查登錄確認單金額是否與對保單金額完全一致。
7. **試算表持久化與雲端清理**：
   - 解析數據寫入「臺銀對保單」、「登錄確認單」、「可貸金額明細表」三個分頁。
   - 綜合審查結果（審查通過或條列不符原因）連同「通知信發送狀態」寫入「審查結果」分頁。
   - **自動將留存於 Google 雲端硬碟的學生暫存 PDF 移至垃圾桶**，節省空間並杜絕個資外洩。
8. **自動發信與學生自主查詢**：
   - 透過智慧 Email 探測器鎖定學生信箱，利用 MailApp / GmailApp 雙重發信架構自動發送審查結果郵件（含純文字與 HTML 美化排版）。
   - 學生可隨時至 GitHub Pages 網站或嵌入之 Google Sites，輸入學號查詢最新審查狀態。

### 1.2 現行機制優缺點評估

#### 【優點】
1. **極高資訊安全與合規性**：
   - 學生身分證號與家庭年所得等高度敏感個資不落地於未受控之第三方公有雲服務。
   - PDF 解密及儲存完全在學校內部 QNAP NAS 實體隔離環境中完成，符合《個人資料保護法》與教育機關資安合規規範。
2. **無須校園路由器 Port Forwarding**：
   - 藉由 Tailscale Funnel，無需在校園防火牆申請昂貴且具風險的公網 IP 或開啟 Port，建構出端到端加密的零信任通道。
3. **嚴格的防偽與防呆校驗**：
   - 臺銀對保單有浮水印計數與對保章圖片檢查；確認單與明細表有表頭關鍵字檢驗。
   - 具備自動學期期間檢核，避免學生誤持上學期舊文件送審。
4. **雲端資源零負擔**：
   - 處理完畢即時刪除 Google 雲端硬碟的暫存 PDF，徹底解決長期累積造成的 Drive 容量爆滿問題。
5. **高度強韌的郵件通知與狀態透明度**：
   - 具備智慧 Email 偵測、雙重發信機制（MailApp 失敗自動降級 GmailApp）與試算表記錄，徹底解決通知漏失問題。

#### 【缺點與限制】
1. **依賴 Tailscale 背景服務存活**：
   - 若 NAS 重新啟動且 Tailscale 未設為常駐服務，或網路中斷，Funnel 將短暫無法通訊。需設定 Docker 與 Tailscale 開機自啟動。
2. **學生填寫表單個資輸入錯誤**：
   - 學生若在表單將身分證號填錯，將導致臺銀對保單無法以該身分證號作為密碼解密。本系統已建立容錯處理，將其列入「審查不通過-密碼錯誤」並發信通知學生。

---

## 貳、 專案內容檢查發現之問題與處理作為（文字紀錄）

在盤點原始專案設定與單據文字萃取檔時，發現以下問題並已落實相關處理作為：

| 問題編號 | 發現之問題與錯誤描述 | 潛在影響 | 系統採取的具體處理作為 |
| :--- | :--- | :--- | :--- |
| **問題 1** | **「可貸金額明細表」PDF 實際無身分證統一編號** | 需求二第1點要求明細表比對身分證號，若硬性比對將導致 100% 判定不通過。 | 調整比對邏輯：可貸金額明細表核對「班級、學號、姓名」；身分證號改由「登錄確認單」與「臺銀對保單」進行嚴格交叉比對。 |
| **問題 2** | **需求二第 7 點文字筆誤**（原文重複寫確認單與確認單比對） | 邏輯無法閉環。 | 依就貸業務實務校正：落實「登錄確認單」各項申貸金額、減免金額及撥款金額與「臺銀對保單」完全一致性檢查。 |
| **問題 3** | **各單據「班級」名稱格式多樣性與身分認定** | 原比對若硬性要求班級名稱完全一致，容易因簡稱或空格不同導致學生被誤判。 | **依最新核定規格放寬並統一**：<br>1. 身分認定：只要學號或身分證號相同即為同一學生。<br>2. 班級名稱：統一以「登錄確認單」為主，各分頁皆採用此班級。<br>3. 臺銀對保單及可貸金額明細表之班級無須比對（錯誤亦無所謂）。 |
| **問題 4** | **金額千分位逗號與負號字串干擾** | 文字字串比對會因逗號（如 `48,135`）、負號（如 `-17,500`）或空字串出錯。 | 在 GAS 實作 `parseAmount` 數值清洗函式，自動過濾逗號與符號並取絕對值整數，若為空值則預設為 0。 |
| **問題 5** | **檔案儲存未依有效學期分目錄** | PDF 全數堆疊於根目錄，未來數年難以歸檔與調閱。 | 修改 `app.py`：根據 `get_valid_semester()` 自動建立 `/app/saved_pdfs/{學年度}-{學期}/`（如 `115-1/`），自動分層歸檔。 |
| **問題 6** | **Google Drive 暫存檔案佔用空間與個資風險** | 學生上傳的檔案長期佔用管理員硬碟空間。 | 在 GAS 加入 `deleteDriveFiles` 函式，審查登記完成後自動將 PDF 移至垃圾桶。 |
| **問題 7** | **解密失敗或檔案格式錯誤時之流程崩潰** | 若單一檔案出錯拋出未捕捉例外，後續審查與信件全數中斷。 | 在 GAS 實作安全包裝處理，將解析失敗轉化為明確的審查錯誤項目寫入試算表，流程平穩走完並寄送補正信件。 |
| **問題 8** | **可貸金額明細表「校外住宿費」排版高度分行問題** | 學生申請校外住宿費時，金額（如 `19,200`）位於儲存格上半部，Y 軸高度高於「住宿費」標題，導致 `pdfplumber` 萃取文字時排在前一行，原本同一行正則匹配不到，誤判為 0 元超貸。 | **修改 `app.py` 萃取邏輯**：優先匹配同列金額；若未果則啟用前一列金額匹配 `([-\d,]+)\s*\n[^\n]*住宿費`，100% 精準取得校外住宿費 `19,200` 元。 |
| **問題 9** | **Google 表單提交未寄送審查結果通知信** | 1. `MailApp.sendEmail` 缺少必填之 `body` 純文字屬性，擲出 `Invalid argument: body` 被 catch 吞沒。<br>2. 表單欄位順序或題目名稱變動導致 `responses[1]` 取不到有效 Email。<br>3. 舊觸發條件未經授權。 | **修改 `Code.js` 與 `appsscript.json`**：<br>1. 補齊 `body` 純文字備援內容。<br>2. 實作 `extractStudentEmail` 智慧 Email 探測機制。<br>3. 建立 MailApp + GmailApp 雙重發信備援架構。<br>4. 在試算表增加選單手動授權與測試按鈕，並於「審查結果」分頁新增「通知信寄送狀態」欄位。 |
| **問題 10** | **執行手動測試時提示權限不足無法呼叫 `Session.getActiveUser`** | `appsscript.json` 顯式定義 `oauthScopes` 時若缺少 `userinfo.email`，調用 `Session.getActiveUser().getEmail()` 會拋出例外。 | 1. 於 `appsscript.json` 補齊 `"https://www.googleapis.com/auth/userinfo.email"`。<br>2. 在 `Code.js` 中對 `Session.getActiveUser()` 加入 `try...catch` 安全包覆與 fallback 預設值，確保即使未授權也不會崩潰中斷。 |
| **問題 11** | **實際測試表單上傳後收到的就貸初審未通過通知信「僅有主旨，沒有內容」** | 1. **HTML 標籤未轉義**：實際審查產生的缺失文字（如超貸金額 `>` 符號、Python 伺服器報錯 `<urlopen error...>` 或 `<html>` 錯誤頁）未轉義直接拼接進 HTML，導致郵件 HTML 結構損毀被 Gmail 安全過濾器清除為空白。<br>2. **Gmail 對話串自動折疊**：主旨完全相同時，Gmail 判定為同串重複郵件將內文折疊收合為 `...`。<br>3. **表單題目順序或無「備註」題時索引錯位**：硬寫死 `responses[...]` 索引導致檔案網址與基本資料取值錯位。 | **全面升級 `Code.js`**：<br>1. 實作 `escapeHtml` 函式，對所有插入 HTML 的欄位進行實體安全轉義。<br>2. 主旨加入動態唯一審核流水序號 `(序號：yyyyMMdd-HHmmss)`，徹底防範 Gmail 郵件折疊。<br>3. 實作 `extractFormData` 智慧表單探測，依表頭關鍵字、正則與 Drive 網址動態配對，杜絕索引錯位。<br>4. 郵件外層添加明亮背景與文字對比色樣式，確保深色模式與各類校園 Webmail 皆能完整渲染。 |
| **問題 12** | **初審合格與否之 NAS 歸檔分離與跨表追蹤需** | 1. 舊流程在解析階段即將 PDF 寫入 NAS，導致初審不合格之錯誤檔案滯留於 NAS 硬碟造成污染。<br>2. 試算表 4 個分頁缺少唯一關聯主鍵，管理員難以快速跨表比對勾稽相同送審案件。 | **架構升級**：<br>1. **兩階段歸檔**：`app.py` 的 `/api/parse_pdf` 預設僅做解密與數據萃取（不存檔）；新增專屬 `/api/archive_approved_pdfs`，唯有在七大規則初審合格後才由 GAS 呼叫存入 NAS `/share/CACHEDEV2_DATA/課外組公用/【就貸專區】/PDF/{學期}/`，不合格案件絕對不存檔。<br>2. **序號貫穿 4 分頁**：在「審查結果」、「臺銀對保單」、「登錄確認單」、「可貸金額明細表」第 1 欄統一規範為「審核序號」，支援自動欄位升級與跨表 VLOOKUP 檢索。 |
| **問題 13** | **初審未通過，依規定略過存檔，但 NAS 仍留存錯誤 PDF 檔** | 實測回報：「雖然審查結果顯示『初審未通過，依規定略過 NAS 存檔』，但另外三個單據分頁都顯示成功，NAS 還是會留存錯誤的 PDF 檔」。<br>**根本病因**：<br>1. NAS 上的 Docker 容器跑的依然是**舊版映像檔**（因 Dockerfile 採 `COPY app.py .`，若未執行 `--build` 重新編譯映像檔，只重啟容器依然跑舊版無條件存檔程式碼）。<br>2. 試算表單據分頁只標註「成功」，容易誤導管理員以為只要成功就存了檔。 | **雙重根治與架構防禦**：<br>1. **掛載實體檔案**：在 `docker-compose.yml` 加入 `./app.py:/app/app.py` 掛載，日後修改 `app.py` 只要重啟容器即刻生效，徹底擺脫映像檔編譯快取！<br>2. **版本號與防呆狀態**：API 升級為 `v2.1.0`，單據分頁狀態改為明確標註 `成功 (純解析未存檔)` 或 `成功 (舊版NAS容器-已存檔，請更新重啟容器)`。<br>3. **新增雙重防呆端點**：新增 `POST /api/cleanup_rejected_pdfs`，初審未通過時主動掃描並清除該學期目錄下該學號之殘留檔案。<br>4. **試算表一鍵版本健檢**：於試算表選單新增「🔍 檢測 NAS 容器版本與連線狀態」，管理員點選即可檢測 NAS 是否已更新為 `v2.1.0`。 |

---

## 參、 模組架構與程式碼庫解說

本專案分為四大子模組，彼此協同運作：

```
f:\Antigravity\PDF/
├── app.py                      # 【模組一】NAS 後端 Python Flask 核心 (解密/解析/分學期建目錄儲存)
├── Dockerfile                  # 【模組一】Docker 容器映像檔建置檔
├── docker-compose.yml          # 【模組一】Docker 服務編排組態檔
├── requirements.txt            # 【模組一】Python 依賴模組清單
├── google_apps_script/         # 【模組二】Google Apps Script 雲端業務邏輯
│   ├── Code.js                 # 核心控制：表單接收、7大規則勾稽、4分頁寫入、發信、Web API、自訂選單
│   └── appsscript.json         # Apps Script 專案資訊與 OAuth 權限宣告組態
├── frontend/                   # 【模組三】學生自主查詢系統前端 (靜態網頁)
│   ├── index.html              # 現代繁體中文查詢介面 (支援手機/電腦)
│   ├── app.js                  # 前端 Fetch API 串接邏輯 (串接 GAS Web App)
│   └── style.css               # 響應式卡片式 UI 樣式表
├── .github/workflows/
│   └── deploy.yml              # 【模組四】GitHub Actions 自動化部署工作流程
├── test_loan_system.py         # 本機自動化單元測試腳本 (含 4B180109 完整驗證)
└── README.md                   # 系統維護手冊與操作文件
```

### 3.1 模組一：NAS 後端 Python Flask 服務 (`app.py`)

#### 核心函式解說
1. **`get_valid_semester()`**
   - **用途**：依據伺服器當前日期動態計算當前有效的民國學年度與學期代碼。
   - **參數**：無。
   - **回傳值**：`tuple: (int, str)`，例如 `(115, "1")` 代表 115 學年度第 1 學期。
   - **規則**：每年 8/1 ~ 翌年 1/14 為第 1 學期；每年 1/15 ~ 7/31 為第 2 學期。
2. **`parse_pdf()`**
   - **路由**：`POST /api/parse_pdf`
   - **用途**：接收 Base64 編碼的 PDF 二進位資料與密碼，進行驗證、防偽檢查、版面排版解析、文字萃取，落實「純記憶體解析（Memory Only）」不存檔至硬碟，並回傳結構化 JSON 與容器版本資訊。
   - **參數 (JSON Payload)**：
     - `file_base64` (`str`, 必填)：PDF 檔案 Base64 字串。
     - `save_filename` (`str`, 必填)：檔案名稱標籤（內含單據識別關鍵字）。
     - `password` (`str`, 選填)：對保單解密密碼（學生身分證號）。
     - `save_to_disk` (`bool`, 選填，預設 `False`)：是否即刻寫入硬碟（嚴格預設 `False`）。
   - **回傳值 (JSON)**：
     - `status`: `"success"`
     - `version`: `"2.1.0"` (API 版本號)
     - `saved_to_disk`: `False` (明確標記未寫入磁碟)
     - `extracted_data`: 包含學年度、學期、班級、姓名、學號、身分證號及所有申貸/減免金額字典（**住宿費具備校外住宿費排版相容機制**）
     - `raw_text`: 原始文字
3. **`archive_approved_pdfs()`**
   - **路由**：`POST /api/archive_approved_pdfs`
   - **用途**：七大規則初審合格後專屬呼叫。將合格的三大單據寫入 NAS `/share/CACHEDEV2_DATA/課外組公用/【就貸專區】/PDF/{學期}/` 專屬目錄。
   - **參數 (JSON Payload)**：
     - `year` (`str`, 必填)：學年度 (如 `"115"`)。
     - `semester` (`str`, 必填)：學期代碼 (`"1"` 或 `"2"`)。
     - `student_id` (`str`, 必填)：學號 (如 `"4B180109"`)。
     - `student_name` (`str`, 必填)：姓名 (如 `"陳玉瑧"`)。
     - `files` (`list[dict]`, 必填)：3 份 PDF 之 Base64 編碼內容陣列。
   - **回傳值 (JSON)**：`status`: `"success"`, `semester_folder`: `"115-1"`, `saved_files`: `[...]`。
4. **`cleanup_rejected_pdfs()`**
   - **路由**：`POST /api/cleanup_rejected_pdfs`
   - **用途**：初審未通過之雙重防呆端點。主動掃描該學期目錄下符合該學號之殘留檔案並予以清除，保證不留存錯誤檔案。
   - **參數 (JSON Payload)**：
     - `year` (`str`, 必填)：學年度。
     - `semester` (`str`, 必填)：學期。
     - `student_id` (`str`, 必填)：學號。
   - **回傳值 (JSON)**：`status`: `"success"`, `deleted_count`: `int`, `deleted_files`: `list[str]`。
5. **`get_version()`**
   - **路由**：`GET /api/version`
   - **用途**：提供管理者隨時檢驗容器程式版本是否為 `v2.1.0`。
   - **參數**：無。
   - **回傳值 (JSON)**：`version`: `"2.1.0"`, `mode`: `"Memory-First Two-Stage Archive"`。

---

### 3.2 模組二：Google Apps Script 業務核心 (`Code.js`)

#### 核心函式與七大審查規則解說
1. **`onFormSubmitHandler(e)`**
   - **用途**：Google 表單送出之主要觸發事件處理器。產生動態審核序號，透過 `extractFormData(e)` 智慧鎖定各欄位與檔案網址，調用 NAS API 進行純解析、執行七大規則勾稽、初審通過後存入 NAS 硬碟、初審未通過主動清除殘留檔、寫入四個試算表分頁（第 1 欄皆為序號）、寄送結果郵件與清理 Drive 暫存。
   - **參數**：`e` (`Object`) - Google 表單提交事件物件，`e.values` 包含學生填報欄位，`e.namedValues` 包含標題對應字典。
   - **回傳值**：無。
2. **`checkNasServerVersion()`**
   - **用途**：試算表選單專用健康檢查工具。發送 GET 請求至 `/api/version`，檢驗 NAS 目前執行的 Docker 容器版本是否為 `2.1.0`，並以視窗彈出即時診斷與重啟指引。
   - **參數**：無。
   - **回傳值**：無 (顯示 UI 彈出視窗)。
3. **`formatParseStatus(res)`**
   - **用途**：格式化 PDF 解析狀態字串，寫入 3 個單據分頁之最後一欄。明確呈現「純解析未存檔」、「已存入NAS」或「舊版NAS容器已存檔警告」，徹底排除管理員疑慮。
   - **參數**：`res` (`Object`) - NAS API 解析回傳物件。
   - **回傳值**：`string` - 格式化後之狀態字串。
4. **`cleanupRejectedPdfsFromNas(year, semester, studentId)`**
   - **用途**：當初審不合格時，主動發送請求至 NAS 清除該學期目錄下該學號之殘留檔案（雙重防呆）。
   - **參數**：`year` (`string`), `semester` (`string`), `studentId` (`string`)。
   - **回傳值**：`Object: { success: boolean, deleted_count: number }`。
5. **`archiveApprovedPdfsToNas(year, semester, studentId, studentName, blobBank, blobConfirm, blobMaxLoan)`**
   - **用途**：當初審勾稽合格（`isPassed === true`）後，正式將 3 份 PDF 儲存至 NAS 硬碟 `/share/CACHEDEV2_DATA/課外組公用/【就貸專區】/PDF/{學年度}-{學期}/` 專屬目錄；若初審不通過則完全不執行儲存，杜絕錯誤檔案存入。
   - **參數**：
     - `year` (`string`): 學年度。
     - `semester` (`string`): 學期代碼。
     - `studentId` (`string`): 學號。
     - `studentName` (`string`): 姓名。
     - `blobBank`, `blobConfirm`, `blobMaxLoan` (`Blob`): 三份 PDF 二進位物件。
   - **回傳值**：`Object: { success: boolean, message: string, folder: string }`。
6. **`writeToRawDataSheets(ss, serialNo, formData, resBank, resConfirm, resMaxLoan)`**
   - **用途**：將「臺銀對保單」、「登錄確認單」、「可貸金額明細表」明細寫入對應分頁，第 1 欄一律寫入「審核序號」，末欄透過 `formatParseStatus` 清楚註明存檔狀態，以利跨表比對追蹤。
   - **參數**：`ss` (試算表), `serialNo` (`string`), `formData` (`Object`), `resBank`, `resConfirm`, `resMaxLoan` (`Object`)。
   - **回傳值**：無。
7. **`writeToReviewResultSheet(ss, serialNo, formData, resBank, resConfirm, resMaxLoan, reviewResult, mailSendResult, nasArchiveResult)`**
   - **用途**：寫入「審查結果」分頁，第 1 欄為「審核序號」，末欄記錄「NAS硬碟歸檔狀態」。
5. **`extractFormData(e)` 與 `extractStudentEmail(e)`**
   - **用途**：全方位多重管道智慧偵測學生填報之 Email、身分證號、學號、姓名、班級與 3 份 PDF 網址（支援 namedValues 表頭檢測 -> 正則表達式掃描 -> 預設索引後備），徹底防止因表單題目調動或無「備註」題造成索引錯位。
   - **參數**：`e` (`Object`) - 表單事件物件。
   - **回傳值**：`Object` - 完整表單填報資料物件。
6. **`escapeHtml(str)`**
   - **用途**：將字串中的 HTML 特殊保留字元（`&`, `<`, `>`, `"`, `'`）進行安全實體跳脫，防止郵件客戶端（Gmail、Outlook）因解析到特殊標籤而導致郵件 HTML DOM 損毀被過濾為空白。
   - **參數**：`str` (`string`) - 待處理之原始字串。
   - **回傳值**：`string` - 安全轉義後之字串。
7. **`sendReviewResultEmail(toEmail, studentId, studentName, year, semester, isPassed, errorMessages, serialNo)`**
   - **用途**：發送審查結果郵件，提供純文字與 HTML 美化雙格式，並實作 `MailApp` + `GmailApp` 雙重發信備援。主旨包含動態唯一審核流水號防止 Gmail 郵件折疊，內文全數經 `escapeHtml` 嚴密防護。
   - **審查合格通知【注意事項】最新內容**：
     1. 生活費核撥時間約為期中考(第9週)過後(約為每年4月及11月中下旬)。
     2. 申貸書籍費、校外住宿費等多貸退費，預計完成作業時間將延後至第18週前後(約為每年6月及1月底)。（含內部行政作業流程備註）
     3. 檢附【如何辦理就學貸款】及【就學貸款相關問題】校網超連結。
   - **參數**：
     - `toEmail` (`string`): 收件信箱。
     - `studentId` (`string`): 學號。
     - `studentName` (`string`): 姓名。
     - `year` (`string`): 學年度。
     - `semester` (`string`): 學期。
     - `isPassed` (`boolean`): 是否審查通過。
     - `errorMessages` (`Array<string>`): 不合格缺失原因陣列。
     - `serialNo` (`string`, 選填): 審核序號。
   - **回傳值**：`Object: { success: boolean, method: string, reason: string }`。
8. **`validateLoanSubmission(formData, resBank, resConfirm, resMaxLoan)`**
   - **用途**：執行系統需求之七大核心規則嚴格比對。
   - **回傳值**：`Object` (`isPassed`, `errorMessages`, `summaryText`)。
9. **`onOpen()` 與 `testSendReviewEmailManual()`**
   - **用途**：建立試算表專屬功能表，提供管理者一鍵測試發信與完成帳號授權。

---

### 3.3 模組三：學生自主查詢系統 (`frontend/`)
- **`index.html`**：包含學號輸入框、狀態卡片展示區塊、查詢須知與警告提示區塊。
- **`style.css`**：採用 CSS 變數設計現代配色，包含通過（綠）與不通過（紅）動態樣式，支援電腦與行動裝置自適應。
- **`app.js`**：非同步調用 GAS Web App API，並在頁面即時渲染查詢結果。

---

### 3.4 模組四：GitHub Actions 自動部署工作流程 (`.github/workflows/deploy.yml`)
- 當推送到 `main` 分支時，自動利用 GitHub 官方 Actions 將 `frontend/` 目錄安全封裝並直接部署至 GitHub Pages 服務。

---

## 肆、 完整操作與部署手冊

### 4.1 QNAP NAS Docker 服務部署與更新維護流程 (關鍵重點)

> [!IMPORTANT]
> **為什麼初審不通過時 NAS 依然存有檔案？**
> 因為先前 Docker 容器在建置時將舊程式碼編譯進映像檔，若只有替換 `app.py` 但沒有使用 `--build` 重新建立映像檔，容器內部依然會運行舊版「解析即存檔」的舊邏輯！
> 最新版 `docker-compose.yml` 已加入 `./app.py:/app/app.py` 實體映射掛載，日後修改程式碼只要重啟容器即可秒級生效。

#### 【更新容器至 v2.1.0 步驟】（二擇一即可）：

##### 途徑 A：透過 SSH 終端機執行（最推薦、最徹底）
1. 透過 SSH 登入 QNAP NAS，切換至專案目錄：
   ```bash
   cd /share/Container/pdf_parser/
   ```
2. 將本專案最新之 `app.py` 與 `docker-compose.yml` 複製至該目錄覆蓋。
3. 確保 NAS 實體儲存目錄存在：
   `/share/CACHEDEV2_DATA/課外組公用/【就貸專區】/PDF`
4. 執行強制重新建置並啟動服務：
   ```bash
   # 1. 停止舊容器並強制以最新 app.py 重新建立映像檔
   docker compose down
   docker compose build --no-cache
   docker compose up -d

   # 2. 檢視啟動日誌確認運行正常
   docker compose logs -f
   ```
5. 驗證服務版本（於 NAS 本機測試）：
   ```bash
   curl http://localhost:5000/api/version
   # 預期回傳：{"mode":"Memory-First Two-Stage Archive","status":"success","version":"2.1.0", ...}
   ```

##### 途徑 B：透過 QNAP Container Station 圖形介面
1. 登入 QNAP QTS 網頁管理介面，開啟 **Container Station**。
2. 進入「總覽」或「容器」，找到 `pdf_parser_api` 容器。
3. 點選 **「停止」** 容器。
4. 將更新後的 `app.py` 與 `docker-compose.yml` 上傳覆蓋 NAS 上的專案目錄。
5. 進入「映像檔」，刪除舊的 `pdf_parser_api` 本地映像檔，或在「應用程式」點選 **「重新建置 (Rebuild)」**。
6. 重新啟動容器。

##### 途徑 C：Google 試算表一鍵驗證
更新完成後，直接在 Google 試算表上方點擊：
**「🎓 就學貸款自動化系統」 -> 「🔍 檢測 NAS 容器版本與連線狀態」**
若彈出視窗顯示 **「• 容器程式版本：2.1.0」**，代表 NAS 容器已 100% 成功套用最新無存檔解析邏輯！

### 4.2 Tailscale Funnel HTTPS 穿透設定
在 NAS 終端機執行以下指令：
```bash
# 1. 將本機 Docker 的 55000 連接埠指向 Tailscale HTTPS 443
/share/CACHEDEV1_DATA/.qpkg/Tailscale/tailscale serve https / http://127.0.0.1:55000

# 2. 開啟對外公開 Funnel 存取權限
/share/CACHEDEV1_DATA/.qpkg/Tailscale/tailscale funnel on

# 3. 取得公開網址
/share/CACHEDEV1_DATA/.qpkg/Tailscale/tailscale serve status
```
複製輸出結果中的 Public HTTPS 網址（例如：`https://your-nas.tailnet-name.ts.net/api/parse_pdf`）。

### 4.3 Google Apps Script (GAS) 設定流程
1. 開啟存放學生表單回覆的 Google 試算表。
2. 點擊頂端選單的 **「擴充功能」 -> 「Apps Script」**。
3. 將本專案 `google_apps_script/Code.js` 的完整內容貼入編輯器中。
4. 將本專案 `google_apps_script/appsscript.json` 內容更新至專案設定中（點選左側齒輪「專案設定」，勾選「在編輯器中顯示 appsscript.json 資訊清單檔案」並覆蓋）。
5. 將腳本最上方的 `NAS_TAILSCALE_URL` 替換為步驟 4.2 取得的 Tailscale Funnel 網址。
6. **手動測試發信與執行授權（關鍵步驟）**：
   - 在編輯器頂端函式下拉選單中選擇 `testSendReviewEmailManual`。
   - 點擊「**執行**」。
   - Google 會跳出「需要授權」對話框，點選「審查權限」-> 選擇您的 Google 帳號 -> 點選「進階」-> 點選「前往 (專案名稱)」-> 點選「允許」。
   - 執行完畢後，檢查您的信箱是否已收到測試審查通知信！
7. **設定表單送出自動觸發程序**：
   - 點擊左側時鐘圖示（**觸發條件**）。
   - 點擊右下角「**新增觸發條件**」。
   - 選擇要執行的功能：`onFormSubmitHandler`。
   - 活動來源：`來自試算表`。
   - 活動類型：`提交表單時`。
   - 儲存觸發條件。
8. **部署 Web App API（供前端查詢系統使用）**：
   - 點擊右上角「**部署**」 -> 「**新增部署作業**」。
   - 類型選擇「**網頁應用程式 (Web App)**」。
   - 說明填寫：`就學貸款審查查詢 API`。
   - 執行身分：`我 (您的 Google 帳號)`。
   - 誰可以存取：`所有人 (Anyone)`。
   - 點擊「部署」，並**複製 Web 應用程式網址**（格式如 `https://script.google.com/macros/s/AKfycbx.../exec`）。

### 4.4 GitHub Pages 自動部署操作流程
1. 開啟本專案的 `frontend/app.js`，將第 16 行的 `GAS_WEB_APP_URL` 替換為步驟 4.3 取得的 Web 應用程式網址。
2. 將本專案程式碼推送到 GitHub 儲存庫的 `main` 分支：
   ```bash
   git add .
   git commit -m "修復住宿費解析與Email發信邏輯"
   git push origin main
   ```
3. 前往 GitHub 儲存庫頁面，點擊 **「Settings」 -> 「Pages」**：
   - 在 **Build and deployment** 下的 **Source** 選擇 **GitHub Actions**。
4. 切換至儲存庫頂部的 **「Actions」** 頁籤，您將看到「部署就貸查詢系統至 GitHub Pages」工作流程正在自動執行。
5. 部署完成後，GitHub 會提供您的公開查詢網址（例如：`https://<您的帳號>.github.io/<儲存庫名稱>/`）。

### 4.5 Google Sites 協作平台嵌入步驟
1. 開啟學校就學貸款的 Google Sites 編輯頁面。
2. 在右側工具面板中點選「**嵌入 (Embed)**」。
3. 選擇「**透過網址 (By URL)**」。
4. 貼入步驟 4.4 取得的 GitHub Pages 網址。
5. 點選「**整頁顯示**」或調整卡片大小至適當位置。
6. 發布 Google Sites 協作平台，學生即可直接在校網內透過學號即時查詢就貸初審結果！

---

## 伍、 驗證與測試指南

1. **本機單元測試驗證**：
   - 於終端機執行 `python test_loan_system.py`。
   - 確認 `4B180109_第115學年1學期可貸金額明細表.pdf` 之住宿費成功提取為 `19,200`，且審查規則判定全數合格通過。
2. **GAS 手動模擬測試**：
   - 開啟試算表，從頂端自訂選單「🎓 就學貸款自動化系統」點選「📋 執行手動模擬送件測試」。
   - 檢查「審查結果」分頁第 11 欄是否顯示 `✓ 已發送 (MailApp)`。
3. **實際表單提交測試**：
   - 前往 Google 表單實際填寫並上傳三份 PDF。
   - 檢查「審查結果」分頁最新一列是否完整寫入審查時間、審查結論與郵件寄送狀態。
   - 檢查填表學生之收件匣是否正常收到審查結果通知信。
4. **線上查詢頁面測試**：
   - 開啟 GitHub Pages 網址，輸入學號（如 `4B180109`），確認即時顯示遮罩姓名（陳○瑧）、就讀班級與審查通過詳細文字。
