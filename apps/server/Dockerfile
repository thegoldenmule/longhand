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

# Manifests first, so dependency layers cache across source changes. Every
# workspace manifest is copied so the frozen lockfile matches the workspace;
# the install itself is filtered to the server and its dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/agent/package.json packages/agent/
COPY packages/annotations/package.json packages/annotations/
COPY packages/binder/package.json packages/binder/
COPY packages/client/package.json packages/client/
COPY packages/editor/package.json packages/editor/
COPY packages/export/package.json packages/export/
COPY packages/ledger/package.json packages/ledger/
COPY packages/provenance-ui/package.json packages/provenance-ui/
COPY packages/report/package.json packages/report/
COPY packages/research/package.json packages/research/
COPY packages/schema/package.json packages/schema/
COPY packages/verifier/package.json packages/verifier/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
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
