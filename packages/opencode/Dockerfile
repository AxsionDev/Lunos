FROM alpine AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
# XCOD-144: git so agents in a sandbox (`lunos run --sandbox`) have a working repository, and a
# uid-1000 user, which is what the sandbox runs as (it passes --user 1000:1000 regardless).
RUN apk add libgcc libstdc++ ripgrep git && adduser -D -u 1000 -h /home/lunos lunos

# XCOD-49: the dist directories were renamed opencode-* -> lunos-* by the rebrand, but this
# Dockerfile kept its own hardcoded copy of the old paths. It went unnoticed because the ghcr
# leg runs after the npm publishes in script/publish.ts, and npm failed on every run — so this
# build was never reached.
#
# The build artifact is still named `bin/opencode` upstream; it is installed as `lunos` here so
# the first published image carries the product's own name. (XCOD-144: images have since been
# pushed — v1.18.42 is ghcr.io/axsiondev/lunos@sha256:d4f5c3e3… — but the package isn't public, so
# anonymous pulls fail.)
FROM base AS build-amd64
COPY dist/lunos-linux-x64-baseline-musl/bin/opencode /usr/local/bin/lunos

FROM base AS build-arm64
COPY dist/lunos-linux-arm64-musl/bin/opencode /usr/local/bin/lunos

ARG TARGETARCH
FROM build-${TARGETARCH}
RUN lunos --version
ENTRYPOINT ["lunos"]
