# syntax=docker/dockerfile:1
# BhoomiTrace backend container image for API, worker, and migration CLI
# Pinned to Debian bookworm (glibc) for @node-rs/argon2 native bindings

# Build stage: compile TypeScript with full toolchain
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Cache dependencies across source edits by copying manifests first
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Dependency stage: production dependencies only
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

# Runtime stage: minimal image for execution
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# NODE_ENV and network settings are supplied by runtime environment
COPY --from=deps /app/node_modules ./node_modules

# Remove vendor agent config published in thread-stream npm package
RUN rm -rf node_modules/thread-stream/.claude

COPY --from=build /app/dist ./dist
# Runtime migration CLI reads generated SQL from drizzle/ directory
COPY drizzle ./drizzle
# Root package.json defines ESM module type and engine constraints
COPY package.json ./

# Initialize upload volume directory with unprivileged node user ownership
RUN mkdir -p /data/uploads && chown -R node:node /data

USER node
EXPOSE 3000

# Default container role is API server; overridden for worker and migration jobs
CMD ["node", "dist/server.js"]
