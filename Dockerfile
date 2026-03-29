# syntax=docker/dockerfile:1
# Build stage
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy package files + registry config (no creds — injected via --secret)
COPY package.json bun.lockb* .npmrc ./

# Install dependencies — mount Nexus auth token as a secret (never stored in layer)
RUN --mount=type=secret,id=npmrc_auth,target=/tmp/npmrc_auth \
    if [ -f /tmp/npmrc_auth ]; then cat /tmp/npmrc_auth >> .npmrc; fi && \
    bun install --frozen-lockfile && \
    rm -f .npmrc

# Copy source code
COPY . .

# Build TypeScript
RUN bun run build

# Production stage
FROM oven/bun:1-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S bunuser && \
    adduser -S bunuser -u 1001

# Copy package files + registry config (no creds)
COPY package.json bun.lockb* .npmrc ./

# Install prod dependencies — same secret mount, never stored in layer
RUN --mount=type=secret,id=npmrc_auth,target=/tmp/npmrc_auth \
    if [ -f /tmp/npmrc_auth ]; then cat /tmp/npmrc_auth >> .npmrc; fi && \
    bun install --production --frozen-lockfile && \
    rm -f .npmrc

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Change ownership
RUN chown -R bunuser:bunuser /app

# Switch to non-root user
USER bunuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start application
CMD ["bun", "run", "dist/index.js"]
