# slack-inquiry-bot Dockerfile
# self-context build — 이 디렉토리를 build context로 사용
# 빌드 및 실행: docker compose up -d --build

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps

COPY src ./src

# logs 디렉토리 (apiLogger.js 적재 위치) — USER 전환 전 권한 부여
RUN mkdir -p logs && chown -R node:node logs

# Socket Mode 봇 — 인바운드 HTTP 리스너 없음 (EXPOSE / HEALTHCHECK / 포트 매핑 불요)
USER node

CMD ["node", "src/app.js"]
