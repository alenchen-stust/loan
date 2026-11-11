# 南臺科技大學 就學貸款審查結果線上即時查詢系統

本儲存庫為南臺科技大學學務處課外活動組「學生就學貸款申貸資料審查結果」之線上即時查詢系統前端靜態網站（考量個資法與校園資安合規，NAS 後端、Google Apps Script 腳本及學生檔案均由 `.gitignore` 排除，不上傳公開儲存庫）。
透過 GitHub Pages 託管，提供日間部與進修部同學即時查詢就貸初審進度與核對狀態。

---

## 🌐 線上即時查詢網址

學生可直接透過瀏覽器訪問以下專屬網址進行查詢：

👉 **[https://alenchen-stust.github.io/loan/](https://alenchen-stust.github.io/loan/)**

*(亦支援以 iframe 形式嵌入學校「[就學貸款專區](https://sites.google.com/stust.edu.tw/loan/)」Google Sites 網站中)*

---

## 📱 系統特色與功能

1. **極速秒查**：學生僅需輸入「學生學號」（例如 `4B180109`），點擊查詢即可即時獲取最新審查狀態。
2. **個資安全防護**：
   - 姓名自動採用去識別化遮罩（如 `陳○瑧`、`周○真`），不顯示身分證字號與金額細項。
   - 嚴格採用 DOM `.textContent` 安全寫入並進行 CORS 跨網域安全通訊。
3. **跨裝置響應式設計 (RWD)**：
   - 採用現代化卡片式 UI 配色（支援手機、平板、筆記型電腦與桌面螢幕自適應）。
4. **狀態標籤即時回饋**：
   - 綠色卡片：`✓ 審查通過`（文件核對無誤，無須重複繳交紙本）。
   - 紅色卡片：`✕ 審查不通過 (待補正)`（條列列出不符原因，引導學生依 Email 指引更正）。
   - 藍色標籤：提供全系統唯一之「審核序號」（例如 `20261109-180501`），利於學生與承辦人員跨表核對進度。

---

## 🛠️ 技術架構

- **前端技術**：純原生 HTML5、現代化 CSS3（CSS Variables / Flexbox / Grid）、非同步 JavaScript (Fetch API)。
- **外部依賴**：Google Fonts (Noto Sans TC)。
- **後端 API 串接**：Google Apps Script (GAS) 部署之 Web App RESTful JSON API（權限須設定為「執行身分：我」、「誰可以存取：所有人」）。
- **託管方式**：GitHub Pages 靜態網頁部署。

---

## 🚀 部署與設定指引 (管理者維護)

### 1. 串接 Google Apps Script Web App
在 [`app.js`](app.js) 中設定您的 GAS Web App 發布網址：
```javascript
// app.js 第 20 行：
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/您的部署ID/exec";
```
> ⚠️ **部署注意事項**：每次修改 GAS `Code.js` 後，務必在 Apps Script 編輯器點選 **「部署」 -> 「管理部署作業」 -> 「編輯 (鉛筆)」 -> 版本選擇「新版本」**（或建立新部署作業並更新 `app.js` URL），且存取權限必須保持為 **「所有人 (Anyone)」**，否則前端會出現「無法連線至審查伺服器」錯誤。

### 2. GitHub Pages 部署方式（兩種方案）

#### 方案 A：分支靜態直出部署（目前本儲存庫採用，免額外 Token 權限）
因部分本機 Git Personal Access Token (PAT) 預設未開啟 `workflow` 權限範圍（推送 `.github/workflows/*.yml` 會遭 GitHub 拒絕），目前採用直接推送根目錄靜態檔至 `main` / `gh-pages` 分支發布：
1. 進入 GitHub 儲存庫的 **「Settings」 -> 「Pages」**。
2. **Source** 選擇 `Deploy from a branch`。
3. **Branch** 選擇 `gh-pages`（或 `main`）與 `/ (root)` 目錄並儲存。
4. 每次更新前端後，推送至遠端即可完成發布：
   ```bash
   git add index.html app.js style.css README.md
   git commit -m "更新前端查詢系統"
   git push origin main
   git push origin main:gh-pages
   ```

#### 方案 B：GitHub Actions 自動部署工作流程 (選用)
若您的本機 GitHub Token 已勾選 **`workflow` 權限**，可於 GitHub 網頁介面或本機新增 `.github/workflows/deploy.yml`：
```yaml
name: 部署就貸查詢系統至 GitHub Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: 檢出儲存庫程式碼
        uses: actions/checkout@v4
      - name: 設定 GitHub Pages
        uses: actions/configure-pages@v5
      - name: 上傳前端靜態資源封裝
        uses: actions/upload-pages-artifact@v3
        with:
          path: '.'
      - name: 部署至 GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```
啟用流程：
1. 將上述 YAML 建立為 `.github/workflows/deploy.yml`（或至 GitHub 儲存庫 **「Settings」 -> 「Pages」** 將 Source 改為 `GitHub Actions`）。
2. 往後推送任何前端變更至 `main` 分支時，GitHub Actions 會自動執行打包並發布至 GitHub Pages。

---

## 📄 專案目錄結構（公開前端部分）

```text
loan/
├── .gitignore            # 排除所有內部後端、GAS、手冊與敏感 PDF 檔案
├── index.html            # 查詢系統首頁
├── app.js                # 查詢請求與 DOM 安全渲染互動腳本
├── style.css             # 響應式卡片 UI 樣式表
└── README.md             # 本說明手冊
```

---

## 📞 承辦單位與諮詢窗口

- **主辦單位**：南臺科技大學 學務處課外活動組（L101 辦公室）
- **就學貸款專區**：[https://sites.google.com/stust.edu.tw/loan/](https://sites.google.com/stust.edu.tw/loan/)
- **常見問題 FAQ**：[https://sites.google.com/stust.edu.tw/loan/FAQ](https://sites.google.com/stust.edu.tw/loan/FAQ)
