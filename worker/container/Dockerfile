# Speculative-merge checker for agentmesh (ADR-0010).
FROM node:24-trixie-slim
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g typescript@7.0.2 && tsc --version
RUN git config --system user.email checker@agentmesh.dev \
  && git config --system user.name "agentmesh checker" \
  && git config --system init.defaultBranch main \
  && git config --system advice.detachedHead false
COPY check.ts /opt/agentmesh/check.ts
RUN mkdir -p /work
CMD ["sleep", "infinity"]
