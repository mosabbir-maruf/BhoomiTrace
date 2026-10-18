# syntax=docker/dockerfile:1
# BhoomiTrace frontend image: build the Vite bundle, serve static output with
# unprivileged nginx. No source, tooling, or package-manager cache ships at runtime.

# Build stage: install from the frozen lockfile and produce the production bundle
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Pinned pnpm major compatible with the committed lockfileVersion 9.0
RUN npm install -g pnpm@9.15.9

# Install dependencies deterministically; only manifests change the layer cache
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy only what the production build needs
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN pnpm run build

# Runtime stage: unprivileged nginx serving only the compiled static assets.
# Pinned to the current stable Alpine release (busybox wget for the healthcheck,
# uid 101, listening on 8080). Bump the tag to the digest behind `stable-alpine`
# when updating; Renovate/Dependabot can automate this.
# Tags: https://hub.docker.com/r/nginxinc/nginx-unprivileged/tags
FROM nginxinc/nginx-unprivileged:1.30.6-alpine AS runtime

# Replace the default server config (reverse proxy + SPA fallback)
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

# Copy only the built output; no source or node_modules reach the runtime image
COPY --from=build /app/dist /usr/share/nginx/html

# Unprivileged nginx already runs as uid 101 and listens on 8080
EXPOSE 8080
