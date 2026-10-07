FROM node:24-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  e2fsprogs \
  git \
  gnupg \
  openssh-client \
  ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Claude Code — official stable APT repository.
RUN install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL \
  https://downloads.claude.ai/keys/claude-code.asc \
  -o /etc/apt/keyrings/claude-code.asc \
  && gpg --show-keys --with-colons /etc/apt/keyrings/claude-code.asc \
  | grep -q '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE' \
  && echo 'deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/stable stable main' \
  > /etc/apt/sources.list.d/claude-code.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends claude-code \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@latest

RUN node --version \
  && npm --version \
  && pnpm --version \
  && claude --version
