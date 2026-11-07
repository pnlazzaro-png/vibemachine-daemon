# The push relay (src/pushrelay.ts) as a container, for Fly.io (fly.toml) or any host. It holds the
# team's APNs key, given as secrets: APNS_KEY (the .p8's text), APNS_KEY_ID, APNS_TEAM_ID. It keeps
# and logs nothing about the pushes it forwards. The daemon itself is not run here.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-fund --no-audit
COPY src ./src
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production RELAY_HOST=0.0.0.0 RELAY_PORT=8080 RELAY_CLIENT_HEADER=fly-client-ip DATA_DIR=/tmp/vibemachine
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/pushrelay.js"]
