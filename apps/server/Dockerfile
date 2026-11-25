# The Longhand ledger service (and its Durable Streams server) for EC2.
# Build from the repo root:  docker build -f apps/server/Dockerfile -t longhand-ledger .
# Run:  see deploy/ec2/docker-compose.yml and docs/DEPLOY.md.
FROM node:24-bookworm-slim

ARG PNPM_VERSION=11.1.3
# Real reviews run the Claude Code CLI headlessly (docs/BUILD.md, "AI runtime").
ARG INSTALL_CLAUDE_CLI=1

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && if [ "$INSTALL_CLAUDE_CLI" = "1" ]; then npm install -g @anthropic-ai/claude-code && npm cache clean --force; fi

WORKDIR /app

# Manifests first, so dependency layers cache across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/schema/package.json packages/schema/
COPY packages/ledger/package.json packages/ledger/
COPY packages/agent/package.json packages/agent/
COPY packages/export/package.json packages/export/
COPY packages/research/package.json packages/research/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter "@longhand/server..."

# Sources (TypeScript, run with tsx: no build step, docs/BUILD.md).
COPY packages/schema packages/schema
COPY packages/ledger packages/ledger
COPY packages/agent packages/agent
COPY packages/export packages/export
COPY packages/research packages/research
COPY apps/server apps/server

RUN mkdir -p /data/streams && chown -R node:node /data /app
USER node

ENV LEDGER_HOST=0.0.0.0 \
    LEDGER_PORT=3200 \
    DURABLE_STREAMS_DATA_DIR=/data/streams
EXPOSE 3200 3300

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LEDGER_PORT||3200)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# `start`: migrations, then the service against DURABLE_STREAMS_URL.
# `streams`: the file-backed Durable Streams server alone.
ENTRYPOINT ["pnpm", "--filter", "@longhand/server", "--silent"]
CMD ["start"]
