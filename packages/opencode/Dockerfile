FROM alpine AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apk add libgcc libstdc++ ripgrep

# XCOD-49: the dist directories were renamed opencode-* -> lunos-* by the rebrand, but this
# Dockerfile kept its own hardcoded copy of the old paths. It went unnoticed because the ghcr
# leg runs after the npm publishes in script/publish.ts, and npm failed on every run — so this
# build was never reached.
#
# The build artifact is still named `bin/opencode` upstream; it is installed as `lunos` here so
# the first published image carries the product's own name. Safe to rename because no image has
# ever been pushed to ghcr.io/axsiondev/lunos — there is nothing depending on the old entrypoint.
FROM base AS build-amd64
COPY dist/lunos-linux-x64-baseline-musl/bin/opencode /usr/local/bin/lunos

FROM base AS build-arm64
COPY dist/lunos-linux-arm64-musl/bin/opencode /usr/local/bin/lunos

ARG TARGETARCH
FROM build-${TARGETARCH}
RUN lunos --version
ENTRYPOINT ["lunos"]
