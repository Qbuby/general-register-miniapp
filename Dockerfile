# 多阶段构建：依赖、编译、生产依赖、运行四层分开，保证镜像小且可复现。
# 运行时不需要任何编译工具链，也不需要开发依赖。

# ---------- 依赖层：仅当 package*.json 变化时才重建 ----------
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- 构建层：TypeScript 编译 + 复制 SQL 迁移 ----------
FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
# npm run build = tsc -p tsconfig.build.json && node scripts/copy-assets.mjs
# 第二步不可省略：tsc 不会搬运 .sql，缺了它服务启动时会找不到数据库迁移目录。
RUN npm run build

# ---------- 生产依赖层 ----------
FROM node:24-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- 运行层 ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    DATABASE_FILE=/app/data/app.db

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build    /app/dist        ./dist
COPY package.json ./

# 数据目录必须可写；用镜像内置的非 root 用户运行。
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
VOLUME ["/app/data"]

# slim 镜像里没有 curl，用 Node 自己的 fetch 探活。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 机密一律运行时注入，不写进镜像：
#   TOKEN_SECRET / WX_APPID / WX_APPSECRET / PREVIEW_TOKEN / PUBLIC_BASE_URL
# 缺少 TOKEN_SECRET 时服务会直接拒绝启动（见 src/config.ts）。
CMD ["node", "dist/index.js"]
