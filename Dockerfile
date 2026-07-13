FROM node:18-slim

WORKDIR /app

# better-sqlite3 可能需要编译（prebuilt 不匹配时）
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# 先装依赖（利用 Docker 层缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 复制应用代码
COPY . .

# SQLite 数据目录
RUN mkdir -p data logs

EXPOSE 19527

CMD ["node", "server.js"]
