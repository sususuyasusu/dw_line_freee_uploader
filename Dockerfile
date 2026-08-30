FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn \
    PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /app/tmp && chown -R node:node /app

USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
