# AI-Capella scan service: Audiveris (optical music recognition) + a GPT check, for Cloud Run.
# Built by `gcloud run deploy --source .` (see README.md) -- Cloud Build downloads Audiveris from
# its GitHub releases while building.

FROM node:22-bookworm-slim AS node

FROM ubuntu:24.04

# "latest", or a release tag such as "5.6.2" to pin the Audiveris version.
ARG AUDIVERIS_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu tesseract-ocr-lat \
      poppler-utils img2pdf fontconfig \
 && if [ "$AUDIVERIS_VERSION" = "latest" ]; then REL=latest; else REL="tags/$AUDIVERIS_VERSION"; fi \
 && URL=$(curl -fsSL "https://api.github.com/repos/Audiveris/audiveris/releases/$REL" \
      | jq -r '[.assets[] | select(.name | test("ubuntu24.*x86_64.*\\.deb$"))][0].browser_download_url // [.assets[] | select(.name | test("ubuntu.*x86_64.*\\.deb$"))][0].browser_download_url') \
 && test -n "$URL" && test "$URL" != "null" \
 && echo "Audiveris package: $URL" \
 && curl -fsSL -o /tmp/audiveris.deb "$URL" \
 && apt-get install -y --no-install-recommends /tmp/audiveris.deb \
 && rm /tmp/audiveris.deb \
 && ln -s "$(find /opt -type f -path '*/bin/Audiveris' | head -n 1)" /usr/local/bin/audiveris \
 && test -x /usr/local/bin/audiveris \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    AUDIVERIS_CMD=/usr/local/bin/audiveris \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata \
    JAVA_TOOL_OPTIONS="-Djava.awt.headless=true -Xmx3g" \
    PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
