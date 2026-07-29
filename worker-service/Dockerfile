FROM node:20.18.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src

FROM node:20.18.1-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20.18.1-alpine AS final
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S nodeapp && adduser -S nodeapp -G nodeapp

COPY --chown=nodeapp:nodeapp package.json ./
COPY --chown=nodeapp:nodeapp --from=deps /app/node_modules ./node_modules
COPY --chown=nodeapp:nodeapp --from=build /app/src ./src

USER nodeapp
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3001/healthz || exit 1

CMD ["node", "src/index.js"]
