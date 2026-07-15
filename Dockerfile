# syntax=docker/dockerfile:1

# --- build stage: install everything, compile TS, drop dev deps ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Build tools so better-sqlite3 compiles from source when its prebuilt binary
# can't be downloaded (the prebuild fetch from GitHub can time out on some
# networks). Kept out of the runtime image, which stays slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Remove devDependencies in place, keeping better-sqlite3's built native binary
# so the runtime stage needs no second install (deterministic, offline-safe).
RUN npm prune --omit=dev

# --- runtime stage: compiled output + pruned node_modules only ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Results (SQLite DB + PDFs + JSON/CSV exports) are written here — mount a
# volume (`-v "$(pwd)/output:/data"`) to keep them on the host.
VOLUME /data

ENTRYPOINT ["node", "dist/index.js"]
# Default: scrape OEFA (no VPN needed) into the mounted volume.
CMD ["scrape", "--site", "oefa", "--out", "/data"]
