# Checker container for the review pipeline: snapshots, CI commands, merges (ADR-0010, ADR-0027).
FROM node:24-trixie-slim
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git procps \
  && rm -rf /var/lib/apt/lists/*
# pnpm and yarn for repos' own CI commands (.atc/ci.yml).
RUN corepack enable
# CI commands run as this unprivileged user (container/check.ts), never as root with the tokens.
RUN useradd --create-home --uid 10001 --user-group ci
RUN git config --system user.email atc@agentmesh.dev \
  && git config --system user.name "ATC" \
  && git config --system init.defaultBranch main \
  && git config --system advice.detachedHead false \
  && git config --system --add safe.directory '*'
COPY check.ts /opt/agentmesh/
RUN mkdir -p /work
CMD ["sleep", "infinity"]
