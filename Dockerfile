FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY lib ./lib
COPY scripts ./scripts
COPY server.js ./
COPY public ./public
COPY api ./api

ENV NODE_ENV=production

# Default: continuous recorder. Override on Render web services with: npm start
CMD ["npm", "run", "record:24x7"]
