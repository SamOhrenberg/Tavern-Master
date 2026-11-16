# syntax=docker/dockerfile:1.7
# The DM launcher: Claude Code plus scripts/dm-launcher.mjs. It brings Claude to
# a Tavern Master table when players sit down and sends it away when they leave.
# See "Claude on call" in the README.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim

# Rebuild to pick up a newer Claude Code; pin one with
#   docker compose build --build-arg CLAUDE_CODE_VERSION=x.y.z dm-launcher
ARG CLAUDE_CODE_VERSION=latest
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# The root filesystem is read-only in compose: updates come from rebuilding.
ENV DISABLE_AUTOUPDATER=1 \
    HOME=/home/node \
    NODE_ENV=production

WORKDIR /app
COPY scripts/dm-launcher.mjs ./

# The image's own unprivileged user. Its home is a volume holding Claude Code's
# sign-in and state, the launcher's settings and logs, and the campaign folders.
USER node
VOLUME ["/home/node"]

CMD ["node", "/app/dm-launcher.mjs", "run"]
