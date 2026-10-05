# syntax=docker/dockerfile:1

FROM node:24-alpine

# NO incoming network port: this integration only makes outgoing connections
# (to the Gladys host API, the WebSocket and the tado° cloud). There is
# deliberately no EXPOSE and no `-p` in the run contract.

# Run as an unprivileged user.
RUN addgroup -S gladys && adduser -S -G gladys gladys

# Single writable mount Gladys provides for integrations.
RUN mkdir -p /data && chown gladys:gladys /data

WORKDIR /app

# Install production dependencies first (better layer caching), then the code.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

USER gladys

ENV NODE_ENV=production
ENV LOG_LEVEL=info

# At runtime Gladys injects GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN and
# GLADYS_INTEGRATION_SELECTOR; the SDK reads them automatically.

CMD ["node", "src/index.js"]