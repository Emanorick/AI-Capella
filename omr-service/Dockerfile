# AI-Capella scan service: GPT reads every page of the sheet music, checks it in a second run and
# asks back where it still can't tell (see README.md). For Cloud Run (`gcloud run deploy --source .`)
# or docker compose. Only Node and the PDF tools -- runs on any machine, ARM (Raspberry Pi) too.
# (The variant with Audiveris reading first: Dockerfile.audiveris.)
FROM node:24-bookworm-slim

# Fails the build on a Node older than the October 2026 security release (24.22.1), whose CA bundle
# has the eMudhra fix -- e.g. an old node:24 image still in Docker's cache: build with --pull.
RUN node -e "const [a,b,c]=process.versions.node.split('.').map(Number); if (a*1e6+b*1e3+c < 24022001) { console.error('Node '+process.version+' predates the eMudhra CA fix: build with --pull'); process.exit(1) }"

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
