# Builds the long-running daemon. Multi-arch: works on a Raspberry Pi (arm64) and x86.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:daemon

FROM node:22-alpine
ENV NODE_ENV=production \
    STORE=sqlite \
    SQLITE_PATH=/data/memai.db
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/dist/daemon ./dist/daemon
USER node
VOLUME ["/data"]
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/daemon/daemon.mjs"]
