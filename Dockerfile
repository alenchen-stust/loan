# ==============================================================================
# Dockerfile：學生就學貸款 PDF 解析與歸檔服務映像檔建置腳本
# 基礎映像檔採用官方輕量化 Python 3.9 Slim
# ==============================================================================
FROM python:3.9-slim

# 設定時區為台北標準時間 (UTC+8)
ENV TZ=Asia/Taipei
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 設定容器內部工作目錄
WORKDIR /app

# 複製依賴套件清單並安裝
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 複製 Python 主程式
COPY app.py .

# 建立內部存放 PDF 檔案的目錄 (後續將透過 docker-compose 映射至 NAS 實體路徑)
RUN mkdir -p /app/saved_pdfs

# 暴露 Flask 預設監聽的 5000 連接埠
EXPOSE 5000

# 容器啟動指令：執行 Flask 伺服器
CMD ["python", "app.py"]

