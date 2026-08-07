# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy Prisma schema and config
COPY prisma ./prisma
COPY prisma.config.ts ./

# Copy TypeScript config
COPY tsconfig.json ./

# Copy source code
COPY src ./src

# Copy scripts
COPY scripts ./scripts

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# ── Stage 2: Production ────────────────────────────────────────────────────
FROM node:20-slim AS production

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy built JavaScript
COPY --from=builder /app/dist ./dist

# Copy Prisma schema and migrations
COPY prisma ./prisma
COPY prisma.config.ts ./

# Generate Prisma client in production image
RUN npx prisma generate

# Copy scripts
COPY scripts ./scripts

# Expose the API port
EXPOSE 3000

# Health check — uses the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

# Start the server
CMD ["node", "dist/server.js"]
