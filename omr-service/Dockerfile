# AI-Capella scan service: GPT reads every page of the sheet music, checks it in a second run and
# asks back where it still can't tell (see README.md). For Cloud Run (`gcloud run deploy --source .`)
# or docker compose. Only Node and the PDF tools -- runs on any machine, ARM (Raspberry Pi) too.
# (The variant with Audiveris reading first: Dockerfile.audiveris.)
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates poppler-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
