# Cynthia — production image (used by Railway via railway.json)
FROM node:22-bookworm-slim

# Chromium gives Cynthia her own web browser; fonts make screenshots readable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji fonts-noto-cjk ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    DATA_DIR=/data \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

EXPOSE 3000
CMD ["node", "server/index.js"]
