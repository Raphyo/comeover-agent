# Come Over agent for Maritime: WhatsApp bot + Claude Code brain + Chromium, state under /data.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright DATA_DIR=/data NO_TUNNEL=1
RUN apt-get update && apt-get install -y --no-install-recommends xvfb ca-certificates fonts-liberation fonts-noto-color-emoji fonts-noto-core curl procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npx playwright install --with-deps chromium \
  && npm install -g @anthropic-ai/claude-code@latest \
  && rm -rf /root/.npm

COPY *.mjs *.md mcp.json ./
COPY wa ./wa
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh && mkdir -p /data

CMD ["./entrypoint.sh"]
