#!/bin/sh
# XCOD-185: builds the lunos_idp mapper jar into providers/ (mounted into Keycloak by compose.yaml).
# Maven runs in Docker so nothing but Docker is needed on the build machine. Tests run as part of it.
set -eu
cd "$(dirname "$0")"
docker run --rm -v "$PWD/lunos-idp-mapper:/src" -v lunos-idp-m2:/root/.m2 -w /src \
  maven:3.9-eclipse-temurin-21 mvn -q -B package
mkdir -p providers
cp lunos-idp-mapper/target/lunos-idp-mapper.jar providers/lunos-idp-mapper.jar
echo "built providers/lunos-idp-mapper.jar"
