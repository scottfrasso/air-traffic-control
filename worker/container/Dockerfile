# Checker container for the review pipeline: snapshots, CI commands, merges (ADR-0010, ADR-0027).
# Pinned by digest (node:24-trixie-slim on 2026-10-23): a re-tagged base image can't change what runs here. Bump it
# for security fixes; the upgrade below also takes the Debian security updates published since the image was built.
FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
RUN apt-get update \
  && apt-get upgrade --yes --no-install-recommends \
  && apt-get install --yes --no-install-recommends ca-certificates git procps \
  && rm -rf /var/lib/apt/lists/*
# pnpm and yarn for repos' own CI commands (.atc/ci.yml).
RUN corepack enable
# The ci group; each CI job runs as its own throwaway uid in it (container/check.ts), never as root with the tokens.
RUN useradd --create-home --uid 10001 --user-group ci
RUN git config --system user.email atc@agentmesh.dev \
  && git config --system user.name "ATC" \
  && git config --system init.defaultBranch main \
  && git config --system advice.detachedHead false \
  && git config --system --add safe.directory '*'
COPY check.ts /opt/agentmesh/
RUN mkdir -p /work
CMD ["sleep", "infinity"]
