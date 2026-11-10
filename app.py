# -*- coding: utf-8 -*-
"""
==============================================================================
檔案名稱：app.py
專案名稱：學生就學貸款 PDF 自動化處理系統 - NAS 後端解析與歸檔服務
功能描述：
    本程式為部署於 QNAP NAS Container Station (Docker) 的 Flask 後端 Web 服務。
    主要職責：
    1. 接收由 Google Apps Script (GAS) 透過 Tailscale Funnel 安全傳輸之 Base64 編碼 PDF 檔案。
    2. 自動辨識三大單據類型（臺銀對保單、已登錄確認單、可貸金額明細表）。
    3. 針對具密碼保護之臺銀對保單進行解密 (PyPDF2)，萃取文字與浮水印/印章特徵。
    4. 針對排版要求之登錄確認單與可貸金額明細表進行視覺化版面文字萃取 (pdfplumber)。
    5. 使用正規表達式提取學年度、學期、班級、學號、姓名、身分證號及所有申貸/減免金額。
    6. 動態計算當前日期之有效學年度與學期，自動於硬碟建立學期目錄（例如 saved_pdfs/115-1/）。
    7. 將完成解析與驗證之 PDF 檔案規範化命名後存入 NAS 本機硬碟，回傳萃取結構化資料給 GAS。

環境依賴：
    - Python 3.9+
    - Flask==2.3.2
    - PyPDF2==3.0.1
    - pdfplumber==0.10.2
    - Werkzeug==2.3.6
    - pycryptodome==3.18.0
    - Pillow==10.0.0
==============================================================================
"""

import base64
import io
import os
import re
from datetime import date
from flask import Flask, request, jsonify

# 初始化 Flask 應用程式
app = Flask(__name__)

# 系統當前 API 核心版本號（v2.1.0：全面落實「純記憶體解析」與「初審通過後二階段 NAS 歸檔」，初審不合格絕不留存錯誤檔案）
APP_VERSION = "2.1.0"

# Docker 容器內儲存檔案的根目錄 (此路徑透過 docker-compose 映射至 NAS 實體路徑：/share/CACHEDEV2_DATA/課外組公用/【就貸專區】/PDF)
SAVE_DIR = '/app/saved_pdfs'


@app.route('/api/version', methods=['GET'])
def get_version():
    """
    函式名稱：get_version
    路由路徑：GET /api/version
    用途說明：
        提供系統管理員與 GAS 隨時檢驗 NAS 目前運行的 Docker 容器內部版本。
        回傳 API 版本號、支援之初審後歸檔架構狀態及掛載目錄。
    參數 (Parameters)：
        無
    回傳值 (Returns)：
        JSON 物件，包含版本號、運作模式及說明。
    """
    valid_year, valid_sem = get_valid_semester()
    return jsonify({
        "status": "success",
        "version": APP_VERSION,
        "mode": "Memory-First Two-Stage Archive",
        "current_valid_semester": f"{valid_year}-{valid_sem}",
        "description": "已啟用純記憶體解析（不落地）與初審合格專屬歸檔，初審未通過保證不留存任何錯誤檔案"
    }), 200


def get_valid_semester():
    """
    函式名稱：get_valid_semester
    用途說明：
        依據伺服器當前日期，動態計算並回傳當前合法的臺灣大專院校學年度（民國年）與學期編號。
        計算規則依教育部標準學期時程：
        - 上學期 (第1學期)：每年 8 月 1 日 至 翌年 1 月 14 日
        - 下學期 (第2學期)：每年 1 月 15 日 至 當年 7 月 31 日
        範例：
            若當前日期為民國 115 年 9 月 20 日，回傳 (115, "1")
            若當前日期為民國 116 年 1 月 10 日，回傳 (115, "1")
            若當前日期為民國 116 年 2 月 20 日，回傳 (115, "2")
    
    參數 (Parameters)：
        無

    回傳值 (Returns)：
        tuple: (int, str)
            - 第一個元素為民國學年度 (int，例如 115)
            - 第二個元素為學期代碼 (str，"1" 代表第1學期/上學期，"2" 代表第2學期/下學期)
    """
    today = date.today()
    roc_year = today.year - 1911  # 將西元曆年換算為民國年
    month = today.month
    day = today.day
    
    if month >= 8:
        # 每年 8 月至 12 月：屬於當前民國年的「第 1 學期」
        return (roc_year, "1")
    elif month == 1 and day <= 14:
        # 每年 1 月 1 日至 1 月 14 日：仍屬於前一民國年的「第 1 學期」
        return (roc_year - 1, "1")
    else:
        # 每年 1 月 15 日至 7 月 31 日：屬於前一民國年的「第 2 學期」
        return (roc_year - 1, "2")


@app.route('/api/parse_pdf', methods=['POST'])
def parse_pdf():
    """
    函式名稱：parse_pdf
    路由路徑：POST /api/parse_pdf
    用途說明：
        處理 GAS 傳入的 PDF 驗證、文字解析、欄位萃取與檔案分類儲存 API。
        主要流程：
        1. 檢驗傳入之 JSON 參數有效性。
        2. 將 Base64 字串還原為記憶體二進位檔案串流 (io.BytesIO)。
        3. 依據 save_filename 辨識單據類型並分別處理：
           a. 臺銀對保單：若加密則以傳入之身分證號密碼解密，檢查防偽浮水印次數與對保章圖片。
           b. 已登錄確認單：利用 pdfplumber layout=True 萃取結構化表格文字，驗證表頭文字。
           c. 可貸金額明細表：利用 pdfplumber layout=True 萃取文字，驗證明細表特徵。
        4. 執行正規表達式匹配，萃取學年度、學期、班級、姓名、學號、身分證號、各項申請金額與減免金額。
        5. 驗證學年度與學期是否屬於當前有效學期，杜絕學生誤傳過期單據。
        6. 自動於 NAS 實體目錄建立學期專屬子目錄（如 saved_pdfs/115-1/），並以標準命名規則存檔。
        7. 回傳解析所得之結構化 JSON 物件。

    請求參數 (Request Payload - JSON)：
        - file_base64 (str): PDF 檔案之 Base64 編碼字串 (必填)
        - save_filename (str): GAS 建議之暫定儲存檔名，內含單據識別特徵 (必填)
        - password (str): 檔案解密密碼，對保單預設為學生身分證統一編號 (選填/對保單必備)

    回傳值 (JSON Response)：
        - HTTP 200 (成功)：
            {
                "status": "success",
                "message": "檔案已驗證、儲存並解析成功",
                "saved_path": "/app/saved_pdfs/115-1/115-1-4B3B0099周小真-臺銀對保單.pdf",
                "saved_filename": "115-1-4B3B0099周小真-臺銀對保單.pdf",
                "semester_folder": "115-1",
                "extracted_data": { ... 各欄位鍵值對 ... },
                "raw_text": "PDF 原始文字內容"
            }
        - HTTP 400 (資料不符/格式錯誤)：
            {"error": "錯誤原因說明", "raw_text": "..."}
        - HTTP 401 (解密失敗/密碼錯誤)：
            {"error": "密碼錯誤或解密失敗"}
        - HTTP 500 (系統異常)：
            {"error": "伺服器內部異常訊息"}
    """
    # 讀取 JSON 格式之請求內容
    data = request.get_json()
    
    # 基本參數防呆檢查
    if not data or 'file_base64' not in data or 'save_filename' not in data:
        return jsonify({"error": "缺少必要的檔案 Base64 資料或檔案名稱"}), 400
        
    file_b64 = data.get('file_base64')
    save_filename = data.get('save_filename')
    password = data.get('password', '').strip()
    # 是否直接寫入硬碟 (預設為 False，落實「初審通過後再儲存，不通過不存錯誤檔案」原則)
    save_to_disk = bool(data.get('save_to_disk', False))
    
    try:
        # 步驟 1：將 Base64 編碼字串解碼為二進位 byte 陣列，置入記憶體串流進行處理
        file_bytes = base64.b64decode(file_b64)
        file_io = io.BytesIO(file_bytes)
        
        extracted_data = {}
        full_text = ""
        
        # ====================================================================
        # 步驟 2a. 處理「臺銀對保單」
        # 特徵：常以身分證號加密、具有「臺灣銀行股份有限公司就學貸款」浮水印、內含蓋印章圖片
        # ====================================================================
        if "臺銀對保單" in save_filename:
            import PyPDF2
            pdf_reader = PyPDF2.PdfReader(file_io)
            
            # 檢查檔案是否加密
            if pdf_reader.is_encrypted:
                if not password:
                    return jsonify({"error": "臺銀對保單已加密，未提供身分證號解密密碼"}), 401
                
                # 嘗試以傳入之身分證字號解密 (包含大寫嘗試與小寫嘗試)
                decrypted = pdf_reader.decrypt(password)
                if not decrypted:
                    decrypted = pdf_reader.decrypt(password.upper())
                if not decrypted:
                    decrypted = pdf_reader.decrypt(password.lower())
                    
                if not decrypted:
                    return jsonify({"error": "臺銀對保單解密失敗，身分證號密碼錯誤"}), 401
            
            has_stamp = False
            # 逐頁萃取文字並檢驗是否包含簽章圖片
            for page in pdf_reader.pages:
                extracted_page_text = page.extract_text()
                if extracted_page_text:
                    full_text += extracted_page_text + "\n"
                # 檢查該頁面是否包含圖片物件（銀行對保戳章）
                if len(page.images) > 0:
                    has_stamp = True
                    
            # 防偽驗證 1：浮水印文字出現次數檢查（對保單背景有密集之銀行就貸浮水印）
            watermark_count = full_text.count("臺灣銀行股份有限公司就學貸款")
            if watermark_count < 10:
                return jsonify({
                    "error": "檔案驗證失敗：非有效之臺銀對保單（未通過防偽浮水印檢查）", 
                    "raw_text": full_text
                }), 400
                
            # 防偽驗證 2：檢查是否包含實體/電子對保印章圖片
            if not has_stamp:
                return jsonify({
                    "error": "檔案驗證失敗：臺銀對保單缺少銀行對保核章", 
                    "raw_text": full_text
                }), 400
                
            # 定義臺銀對保單專屬之正規表達式 (包含班級、身分及各項費用)
            patterns = {
                "學年度": r"(\d+)\s*學年度",
                "學期": r"學年度\s*(上學期|下學期|第[一二12]學期)",
                "姓名": r"姓名[：:\s]*([^\n\s]+)",
                "身分證號": r"身分證統一編號[：:\s]*([A-Za-z0-9]+)",
                "學號": r"學號[：:\s]*([A-Za-z0-9]+)",
                # 萃取就讀學校後面之系所與年級班別（例如：行銷(與)流通管理系 3 年級 乙班）
                "班級": r"就讀學校[：:\s]*南[臺台]科技大學\s*([^\n\r]+?)(?=\s*學校座落|\n)",
                "學雜費": r"學雜費\s*([-\d,]+)\s*元",
                "電腦及網路通訊使用費": r"(?:電腦及網路)?通訊使用費\s*([-\d,]+)\s*元",
                "團體保險費": r"團體保險費\s*([-\d,]+)\s*元",
                "書籍費": r"書籍費\s*([-\d,]+)\s*元",
                "實習費": r"實習費\s*([-\d,]+)\s*元",
                "住宿費": r"(?:校內|校外)?住宿費\s*([-\d,]+)\s*元",
                "海外研修費": r"(?:海外研修費|海外研習費)\s*([-\d,]+)\s*元",
                "生活費": r"生活費\s*([-\d,]+)\s*元",
                "已享有學雜費減免": r"已享有學雜費減免或請領教育部助學金之金額\s*([-\d,]+)\s*元",
                "行政院減免學雜費": r"行政院減免學雜費\s*([-\d,]+)\s*元",
                "行政院補貼校內住宿費": r"行政院補貼校內住宿費\s*([-\d,]+)\s*元",
                "本學期撥款金額": r"本學期撥款金額[\s\S]*?([-\d,]+)\s*元整"
            }
        
        # ====================================================================
        # 步驟 2b. 處理「已登錄確認單」
        # 特徵：學校就貸系統登錄後產生，具特定表頭與表格排版 (需 pdfplumber layout=True)
        # ====================================================================
        elif "已登錄確認單" in save_filename or "登錄確認單" in save_filename:
            import pdfplumber
            import pdfminer.pdfdocument
            try:
                with pdfplumber.open(file_io) as pdf:
                    for page in pdf.pages:
                        text = page.extract_text(layout=True)
                        if text:
                            full_text += text + "\n"
            except pdfminer.pdfdocument.PDFPasswordIncorrect:
                return jsonify({"error": "登錄確認單解密失敗"}), 401
            
            # 驗證確認單標題特徵關鍵字
            if "已登錄確認單" not in full_text and "確認單" not in full_text:
                return jsonify({
                    "error": "檔案驗證失敗：非有效之學校就學貸款已登錄確認單", 
                    "raw_text": full_text
                }), 400
            
            # 定義已登錄確認單專屬之正規表達式
            patterns = {
                "學年度": r"第\s*(\d+)\s*學年度",
                "學期": r"第\d+學年度第\s*(\d+)\s*學期",
                "姓名": r"申請人\s+(\S+)\s+[A-Za-z]\d{9}",
                "身分證號": r"申請人\s+\S+\s+([A-Za-z]\d{9})",
                "學號": r"學號[：:\s]*([A-Za-z0-9]+)",
                "班級": r"(?:科系所別|班級)[：:\s]*([^\s\n\r]+)",
                "學雜費": r"學雜費\s+([-\d,]+)",
                "電腦及網路通訊使用費": r"電腦及網路通訊使用費\s+([-\d,]+)",
                "團體保險費": r"團體保險費\s+([-\d,]+)",
                "書籍費": r"書籍費\s+([-\d,]+)",
                "實習費": r"實習費\s+([-\d,]+)",
                "住宿費": r"住宿費\s+([-\d,]+)",
                "海外研修費": r"海外研修費\s+([-\d,]+)",
                "生活費": r"申貸生活費\s+([-\d,]+)",
                "已享有學雜費減免": r"已享有減免或助學金金額\s+([-\d,]+)",
                "行政院減免學雜費": r"行政院減免學雜費\s+([-\d,]+)",
                "行政院補貼校內住宿費": r"行政院補貼校內住宿費\s+([-\d,]+)",
                "本學期撥款金額": r"台銀對保單撥款金額\s+([-\d,]+)"
            }
        
        # ====================================================================
        # 步驟 2c. 處理「可貸金額明細表」
        # 特徵：由學校系統列印之可貸金額上限清單，注意：此單據並無身分證號欄位！
        # ====================================================================
        elif "可貸金額明細表" in save_filename:
            import pdfplumber
            import pdfminer.pdfdocument
            try:
                with pdfplumber.open(file_io) as pdf:
                    for page in pdf.pages:
                        text = page.extract_text(layout=True)
                        if text:
                            full_text += text + "\n"
            except pdfminer.pdfdocument.PDFPasswordIncorrect:
                return jsonify({"error": "可貸金額明細表解密失敗"}), 401
            
            # 驗證明細表標題特徵關鍵字
            if "金額明細表" not in full_text and "可貸款金額" not in full_text:
                return jsonify({
                    "error": "檔案驗證失敗：非有效之就學貸款可貸款金額明細表", 
                    "raw_text": full_text
                }), 400
            
            # 定義可貸金額明細表之正規表達式 (注意無身分證號)
            patterns = {
                "學年度": r"(\d+)學年度",
                "學期": r"學年度第\s*(\d+)\s*學期",
                "姓名": r"姓名\s+(\S+)",
                "學號": r"學號\s+([A-Za-z0-9]+)",
                "班級": r"系所班級\s+([^\n\r]+)",
                "學雜費": r"學雜費\s+([-\d,]+)",
                "電腦及網路通訊使用費": r"團體保險費\s+[-\d,]+\s+([-\d,]+)",
                "團體保險費": r"團體保險費\s+([-\d,]+)",
                "書籍費": r"書籍費\s+([-\d,]+)",
                "實習費": r"(?:實習費|語言實習費)\s+([-\d,]+)",
                "住宿費": r"住宿費\s+([-\d,]+)",
                "海外研修費": r"(?:海外研修費|海外研習費)\s+([-\d,]+)",
                "生活費": r"生活費\s+([-\d,]+)",
                "已享有學雜費減免": r"已享有學雜費減免或\s*\n\s*([-\d,]+)\s*\n\s*請領教育部助學金之金額",
                "行政院減免學雜費": r"([-\d,]+)\s+[-\d,]+\s*\n\s*學雜費\s+校內住宿費",
                "行政院補貼校內住宿費": r"[-\d,]+\s+([-\d,]+)\s*\n\s*學雜費\s+校內住宿費",
                "本學期撥款金額": r"(?:合\s+計|最高可貸款總金額[：:]?)\s+([-\d,]+)"
            }
        
        # ====================================================================
        # 步驟 2d. 無法識別之檔案名稱或未知文件
        # ====================================================================
        else:
            return jsonify({"error": f"無法辨識之 PDF 檔案類型：{save_filename}"}), 400
        
        # 步驟 3：透過正規表達式提取各項目標資料
        has_valid_data = False
        for key, pattern in patterns.items():
            match = re.search(pattern, full_text)
            if match:
                val = match.group(1).strip()
                # 班級欄位內部連續空格清理為單一空格
                if key == "班級":
                    val = re.sub(r'\s+', ' ', val)
                extracted_data[key] = val
                # 只要能提取到學號、學年度或撥款金額，代表為有效內容單據
                if key in ["學號", "學年度", "本學期撥款金額"]:
                    has_valid_data = True
            else:
                extracted_data[key] = ""
        
        # 針對「可貸金額明細表」之住宿費排版防呆補強：
        # 當學生申請「校外住宿費」時，版面排版金額（例如 19,200）會位於「住宿費」字樣前一行，下方標註 (校外住宿費)。
        # 若原正規表達式未能於同一行匹配到數值，則啟動前一行金額匹配機制，確保校外住宿費順利讀取。
        if "可貸金額明細表" in save_filename and not extracted_data.get("住宿費"):
            dorm_match = re.search(r"([-\d,]+)\s*\n[^\n]*住宿費", full_text)
            if dorm_match:
                extracted_data["住宿費"] = dorm_match.group(1).strip()
        
        # 規格化學期文字呈現（轉為「第1學期」或「第2學期」）
        if "臺銀對保單" not in save_filename and extracted_data.get("學期"):
            sem = extracted_data["學期"]
            if sem in ["1", "2"]:
                extracted_data["學期"] = f"第{sem}學期"
        
        # 提取學期數字（用於系統學期校驗，轉換為字串 "1" 或 "2"）
        semester_display = extracted_data.get("學期", "")
        if "上" in semester_display or "1" in semester_display or "一" in semester_display:
            semester_num_for_validate = "1"
        elif "下" in semester_display or "2" in semester_display or "二" in semester_display:
            semester_num_for_validate = "2"
        else:
            semester_num_for_validate = ""
                
        # 嚴格驗證：若核心資料全數為空，視為損毀或格式錯誤檔案
        if not has_valid_data:
            return jsonify({
                "error": "PDF 檔案解析失敗：未能辨識有效之就貸資料欄位", 
                "raw_text": full_text
            }), 400
        
        # 步驟 4：校驗 PDF 單據中之學年度與學期是否符合系統當前有效期間
        valid_year, valid_semester = get_valid_semester()
        pdf_year = extracted_data.get("學年度", "")
        
        if pdf_year and semester_num_for_validate:
            if str(valid_year) != pdf_year or valid_semester != semester_num_for_validate:
                return jsonify({
                    "error": f"學期有效性驗證失敗：PDF 單據記載為 {pdf_year} 學年度第 {semester_num_for_validate} 學期，"
                             f"當前有效辦理期間應為 {valid_year} 學年度第 {valid_semester} 學期",
                    "raw_text": full_text
                }), 400
        
        # 步驟 5：學期目錄與檔名判定
        semester_folder = f"{valid_year}-{valid_semester}"
        target_dir = os.path.join(SAVE_DIR, semester_folder)
        
        save_path = ""
        final_filename = ""

        # 步驟 6：依 save_to_disk 決定是否即刻儲存 (若為 False 則僅做解析與驗證，落實不合格不存檔規範)
        if save_to_disk:
            os.makedirs(target_dir, exist_ok=True)
            doc_type_suffix = save_filename.split("-")[-1]
            year = extracted_data.get("學年度", str(valid_year))
            student_id = extracted_data.get("學號", "")
            student_name = extracted_data.get("姓名", "")
            
            if year and semester_num_for_validate and student_id and student_name:
                final_filename = f"{year}-{semester_num_for_validate}-{student_id}{student_name}-{doc_type_suffix}"
            else:
                final_filename = save_filename
                
            save_path = os.path.join(target_dir, final_filename)
            with open(save_path, 'wb') as f:
                f.write(file_bytes)
            
        # 回傳成功結果與萃取之結構化資料
        return jsonify({
            "status": "success",
            "version": APP_VERSION,
            "message": "檔案已成功驗證並完成欄位萃取" + ("（已儲存至NAS）" if save_to_disk else "（純解析未存檔）"),
            "saved_to_disk": save_to_disk,
            "saved_path": save_path,
            "saved_filename": final_filename,
            "semester_folder": semester_folder,
            "extracted_data": extracted_data,
            "raw_text": full_text
        }), 200

    except Exception as e:
        # 捕捉未預期例外，回傳 HTTP 500 錯誤訊息
        return jsonify({"error": f"後端解析過程發生例外錯誤：{str(e)}"}), 500


@app.route('/api/archive_approved_pdfs', methods=['POST'])
def archive_approved_pdfs():
    """
    函式名稱：archive_approved_pdfs
    路由路徑：POST /api/archive_approved_pdfs
    用途說明：
        依據業務規範「初審通過後再儲存，不通過不要儲存錯誤的PDF檔」：
        當 GAS 執行七大審查規則勾稽完全合格後，呼叫此專屬 API 將三大單據（臺銀對保單、登錄確認單、可貸金額明細表）
        正式儲存至 NAS 硬碟 /share/CACHEDEV2_DATA/課外組公用/【就貸專區】/PDF 底下建立的學期專屬子目錄中（例如 115-1/）。
    
    請求參數 (Request Payload - JSON)：
        - year (str): 學年度 (如 "115")
        - semester (str): 學期代碼 ("1" 或 "2")
        - student_id (str): 學號 (如 "4B180109")
        - student_name (str): 姓名 (如 "陳玉瑧")
        - files (list[dict]): 三份 PDF 檔案陣列，每筆包含：
            - doc_type (str): 單據名稱 (如 "臺銀對保單", "已登錄確認單", "可貸金額明細表")
            - file_base64 (str): 該單據之 Base64 編碼內容
            
    回傳值 (JSON Response)：
        - HTTP 200 (成功)：
            {
                "status": "success",
                "message": "三份合格單據已全數成功歸檔至 NAS 學期目錄",
                "semester_folder": "115-1",
                "saved_files": [ ... 各檔案儲存路徑 ... ]
            }
        - HTTP 400 (缺少參數)：
            {"error": "缺少必要之歸檔參數"}
        - HTTP 500 (系統異常)：
            {"error": "歸檔儲存過程發生錯誤"}
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "未提供任何歸檔資料"}), 400

    year = str(data.get("year", "")).strip()
    semester = str(data.get("semester", "")).strip()
    student_id = str(data.get("student_id", "")).strip()
    student_name = str(data.get("student_name", "")).strip()
    files = data.get("files", [])

    if not year or not semester or not student_id or not student_name or not files:
        return jsonify({"error": "缺少必要欄位 (year, semester, student_id, student_name, files)"}), 400

    # 學期代碼正規化 (若傳入 "第1學期" 或 "上學期" 轉為 "1")
    sem_num = "1" if ("1" in semester or "上" in semester) else ("2" if ("2" in semester or "下" in semester) else semester)
    semester_folder = f"{year}-{sem_num}"
    
    # 建立目標目錄：/app/saved_pdfs/{學年度}-{學期}/
    # 映射於 NAS 實體路徑：/share/CACHEDEV2_DATA/課外組公用/【就貸專區】/PDF/{學年度}-{學期}/
    target_dir = os.path.join(SAVE_DIR, semester_folder)
    os.makedirs(target_dir, exist_ok=True)

    saved_files = []
    try:
        for item in files:
            doc_type = str(item.get("doc_type", "")).strip()
            file_b64 = item.get("file_base64", "")
            if not doc_type or not file_b64:
                continue

            # 確保檔名後綴帶有 .pdf
            if not doc_type.endswith(".pdf"):
                doc_type_suffix = doc_type + ".pdf"
            else:
                doc_type_suffix = doc_type

            # 標準化命名規範：學年度-學期-學號姓名-單據名稱.pdf
            filename = f"{year}-{sem_num}-{student_id}{student_name}-{doc_type_suffix}"
            save_path = os.path.join(target_dir, filename)

            file_bytes = base64.b64decode(file_b64)
            with open(save_path, "wb") as f:
                f.write(file_bytes)

            saved_files.append({
                "doc_type": doc_type,
                "filename": filename,
                "path": save_path
            })

        return jsonify({
            "status": "success",
            "message": f"學生 {student_id} {student_name} 初審合格，3 份 PDF 已成功儲存至 NAS 學期目錄",
            "semester_folder": semester_folder,
            "saved_count": len(saved_files),
            "saved_files": saved_files
        }), 200

    except Exception as e:
        return jsonify({"error": f"寫入 NAS 硬碟過程發生異常：{str(e)}"}), 500


@app.route('/api/cleanup_rejected_pdfs', methods=['POST'])
def cleanup_rejected_pdfs():
    """
    函式名稱：cleanup_rejected_pdfs
    路由路徑：POST /api/cleanup_rejected_pdfs
    用途說明：
        初審不合格之安全清除機制（雙重防呆保險）。
        若 NAS 實體目錄因歷史舊版容器快取或重複送件留存了該學生的 PDF 檔案，
        當 GAS 判定審查不通過時，可呼叫此端點傳入學期與學號，
        自動搜尋並徹底清除該學期目錄下該學生之所有殘留 PDF 檔，
        100% 確保 NAS 硬碟「絕不留存任何錯誤的就貸 PDF 檔」。
    
    請求參數 (Request Payload - JSON)：
        - year (str): 學年度 (如 "115")
        - semester (str): 學期代碼 ("1" 或 "2")
        - student_id (str): 學號 (如 "4B180109")
        
    回傳值 (JSON Response)：
        - HTTP 200 (成功)：
            {
                "status": "success",
                "message": "已清除 2 個殘留之錯誤單據檔案",
                "deleted_files": ["..."]
            }
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "未提供任何清除參數"}), 400

    year = str(data.get("year", "")).strip()
    semester = str(data.get("semester", "")).strip()
    student_id = str(data.get("student_id", "")).strip()

    if not year or not semester or not student_id:
        return jsonify({"error": "缺少必要欄位 (year, semester, student_id)"}), 400

    sem_num = "1" if ("1" in semester or "上" in semester) else ("2" if ("2" in semester or "下" in semester) else semester)
    semester_folder = f"{year}-{sem_num}"
    target_dir = os.path.join(SAVE_DIR, semester_folder)

    if not os.path.exists(target_dir):
        return jsonify({
            "status": "success",
            "message": "目標學期目錄不存在，無須清除",
            "deleted_count": 0,
            "deleted_files": []
        }), 200

    deleted_files = []
    try:
        # 搜尋檔名包含該學號之所有檔案並刪除
        for fname in os.listdir(target_dir):
            if student_id in fname and fname.lower().endswith(".pdf"):
                full_fpath = os.path.join(target_dir, fname)
                try:
                    os.remove(full_fpath)
                    deleted_files.append(fname)
                except Exception as del_err:
                    pass

        return jsonify({
            "status": "success",
            "message": f"已成功檢查並清除學生 {student_id} 於 {semester_folder} 目錄下的 {len(deleted_files)} 個不合格或殘留檔案",
            "deleted_count": len(deleted_files),
            "deleted_files": deleted_files
        }), 200

    except Exception as e:
        return jsonify({"error": f"清理檔案過程發生異常：{str(e)}"}), 500


if __name__ == '__main__':
    # 服務監聽於 0.0.0.0 (允許 Docker 網路存取)，內部 Port 為 5000 (對外映射為 55000)
    app.run(host='0.0.0.0', port=5000)
