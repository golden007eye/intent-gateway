# The gateway's Docker image (ADR-0005, ADR-0010): the same package as on npm, serving MCP over HTTP for teams.
#
# Build it reproducibly from a clean checkout (two builds of one commit give the same digest):
#   docker buildx build --platform linux/amd64 \
#     --build-arg BUILD_COMMIT="$(git rev-parse HEAD)" \
#     --build-arg SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" \
#     --output type=docker,name=intent-gateway:dev,rewrite-timestamp=true .
# rewrite-timestamp needs a BuildKit builder that applies it (`docker buildx create --use`, as CI's setup-buildx
# does); the classic `docker` driver ignores it and the digest then changes on every build.
# BUILD_COMMIT is the commit the build records (`.git` is not in the build context); pass it only for a checkout
# with no local changes, as the CI package job does after checking.
#
# Run it (the token is printed once, on the first start):
#   docker run -p 127.0.0.1:8787:8787 -v intent-data:/data intent-gateway:dev
# Try the demo (sample catalog, test keys, nothing can be bought; 8788 is its local confirm page):
#   docker run -p 127.0.0.1:8787:8787 -p 127.0.0.1:8788:8788 -e INTENT_DEMO=1 intent-gateway:dev

# node:24-trixie-slim, linux/amd64 (pinned by digest; update the tag and digest together).
ARG NODE_IMAGE=node:24-trixie-slim@sha256:27526714fd6b7dc938f8cb1665bf1fe749efadadf0145d5bcc07f0fbd0370b60

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=12.9.1
RUN npm install --global --ignore-scripts --no-audit --no-fund "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json LICENSE NOTICE README.md ./
COPY scripts/build-info.ts scripts/
COPY src src
COPY policies policies
COPY contract contract
ARG BUILD_COMMIT
RUN test -n "${BUILD_COMMIT}" || { echo "pass --build-arg BUILD_COMMIT=\$(git rev-parse HEAD)" >&2; exit 1; } \
 && BUILD_COMMIT="${BUILD_COMMIT}" pnpm build \
 && chmod 0755 dist/main.js
# The runtime tree: what `npm pack` puts in the tarball, plus the production dependencies from the lockfile.
# pnpm's bookkeeping files carry install times, so they go, to keep the image reproducible.
RUN mkdir /out \
 && cp -R package.json pnpm-lock.yaml pnpm-workspace.yaml dist policies contract LICENSE NOTICE README.md /out/ \
 && cd /out \
 && pnpm install --prod --frozen-lockfile --ignore-scripts \
 && rm -f pnpm-lock.yaml pnpm-workspace.yaml node_modules/.modules.yaml node_modules/.pnpm-workspace-state*.json \
 && test -z "$(find dist -name '*.test.*')"

FROM ${NODE_IMAGE}
ARG BUILD_COMMIT
LABEL org.opencontainers.image.title="intent-gateway" \
      org.opencontainers.image.description="The intent gateway: MCP for agents, a local disclosure log, one human approval per purchase" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/golden007eye/intent-gateway" \
      org.opencontainers.image.revision="${BUILD_COMMIT}"
COPY --from=build /out /app
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/intent-entrypoint
# `node` (uid 1000) runs the gateway and owns /data: the store refuses a data dir owned by anyone else.
RUN ln -s /app/dist/main.js /usr/local/bin/intent \
 && ln -s /app/dist/main.js /usr/local/bin/intent-gateway \
 && mkdir -m 0700 /data \
 && chown 1000:1000 /data
# The entrypoint sets INTENT_HTTP_HOST=0.0.0.0 for the server only, so `docker exec <c> intent log` needs no token.
ENV INTENT_RUNTIME=container
USER 1000:1000
WORKDIR /data
VOLUME /data
# 8787: MCP over HTTP. 8788: the demo's local confirm page (INTENT_DEMO=1 only).
EXPOSE 8787 8788
# Needs no token: a request without one gets 401 (405 when no token is set on a loopback bind), which shows
# the server is up and checking; anything else, or no answer, is unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.INTENT_HTTP_PORT||8787)+'/mcp').then(r=>process.exit([401,405].includes(r.status)?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/intent-entrypoint"]
CMD ["serve", "--http"]
