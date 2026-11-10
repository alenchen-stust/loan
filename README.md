# 南臺科技大學 就學貸款審查結果線上即時查詢系統

本儲存庫為南臺科技大學學務處課外活動組「學生就學貸款申貸資料審查結果」之線上即時查詢系統前端靜態網站。
透過 GitHub Pages 進行全球高速 CDN 託管，提供日間部與進修部同學即時查詢就貸初審進度與核對狀態。

---

## 🌐 線上即時查詢網址

學生可直接透過瀏覽器訪問以下專屬網址進行查詢：

👉 **[https://alenchen-stust.github.io/loan/](https://alenchen-stust.github.io/loan/)**

*(亦支援以 iframe 形式嵌入學校「[就學貸款專區](https://sites.google.com/stust.edu.tw/loan/)」Google Sites 網站中)*

---

## 📱 系統特色與功能

1. **極速秒查**：學生僅需輸入「學生學號」（例如 `4B180109`），點擊查詢即可於 1 秒內獲取最新審查狀態。
2. **個資安全防護**：
   - 姓名自動採用去識別化遮罩（如 `陳○瑧`、`周○真`），不顯示身分證字號與金額細項。
   - 完全符合《個人資料保護法》及校園資訊安全政策。
3. **跨裝置響應式設計 (RWD)**：
   - 採用現代化卡片式 UI 配色（支援手機、平板、筆記型電腦與桌面螢幕自適應）。
4. **狀態標籤即時回饋**：
   - 綠色卡片：`✓ 審查通過`（文件核對無誤，不重複繳交紙本）。
   - 紅色卡片：`✕ 待補正`（詳細列出不符原因，引導學生儘速更正）。
   - 藍色標籤：提供全系統唯一之「審核序號」（例如 `20261109-180501`），利於學生與承辦人員核對進度。

---

## 🛠️ 技術架構

- **前端技術**：純原生 HTML5、現代化 CSS3（Flexbox / Grid / CSS 變數）、非同步 JavaScript (Fetch API)。
- **外部依賴**：Google Fonts (Noto Sans TC)。
- **後端 API 串接**：Google Apps Script (GAS) 部署之 Web App API。
- **自動化部署**：GitHub Actions (`.github/workflows/deploy.yml`)。

---

## 🚀 部署與設定指引 (管理者維護)

### 1. GitHub Pages 啟用方式
本儲存庫已內建 GitHub Actions 自動部署工作流程，只需在儲存庫完成一次性設定：
1. 進入本儲存庫的 **「Settings」** -> **「Pages」**。
2. 在 **「Build and deployment」** 區塊：
   - **Source** 選擇：`GitHub Actions`（推薦）或 `Deploy from a branch`（選擇 `main` 分支與 `/ (root)` 目錄）。
3. 當程式碼推送到 `main` 分支時，GitHub Actions 會自動在 1 分鐘內完成打包與發布！

### 2. 串接 Google Apps Script Web App
在 [`app.js`](app.js) 中設定您的 GAS Web App 發布網址：
```javascript
// app.js 第 16 行：
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/您的部署ID/exec";
```

---

## 📄 專案目錄結構

```
loan/
├── .github/
│   └── workflows/
│       └── deploy.yml    # GitHub Actions 自動部署工作流程
├── .gitignore            # 排除非前端檔案與敏感資料
├── index.html            # 查詢系統首頁
├── app.js                # 查詢請求與 DOM 渲染互動腳本
├── style.css             # 響應式卡片 UI 樣式表
└── README.md             # 本說明手冊
```

---

## 📞 承辦單位與諮詢窗口

- **主辦單位**：南臺科技大學 學務處課外活動組（L101 辦公室）
- **就學貸款專區**：[https://sites.google.com/stust.edu.tw/loan/](https://sites.google.com/stust.edu.tw/loan/)
- **常見問題 FAQ**：[https://sites.google.com/stust.edu.tw/loan/FAQ](https://sites.google.com/stust.edu.tw/loan/FAQ)
