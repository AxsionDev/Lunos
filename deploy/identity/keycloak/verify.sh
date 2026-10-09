#!/bin/sh
# XCOD-185: check a deployed Lunos identity provider is ready for `lunos login`.
# Usage: ./verify.sh https://id.lunos.tech        (or http://localhost:8080 on the server itself)
set -eu
BASE=${1:?usage: verify.sh <keycloak base url>}
ISSUER="$BASE/realms/lunos"
fail() { echo "FAIL: $*" >&2; exit 1; }

DISCOVERY=$(curl -fsS "$ISSUER/.well-known/openid-configuration") || fail "no discovery document at $ISSUER"
echo "$DISCOVERY" | grep -q '"issuer":"'"$ISSUER"'"' || fail "issuer in discovery isn't $ISSUER (check KC_HOSTNAME)"
echo "$DISCOVERY" | grep -q '"device_authorization_endpoint"' || fail "no device authorization endpoint"
echo "$DISCOVERY" | grep -q '"revocation_endpoint"' || fail "no revocation endpoint"
echo "ok   discovery: issuer, device and revocation endpoints"

DEVICE=$(curl -fsS -X POST "$ISSUER/protocol/openid-connect/auth/device" \
  -d client_id=lunos-cli -d "scope=openid profile email offline_access") || fail "lunos-cli can't start a device sign-in"
echo "$DEVICE" | grep -q '"device_code"' || fail "no device_code in: $DEVICE"
echo "ok   lunos-cli: device sign-in starts ($(echo "$DEVICE" | sed -E 's/.*"verification_uri":"([^"]+)".*/\1/'))"

case "$ISSUER" in
  https://*) echo "ok   https issuer" ;;
  http://localhost* | http://127.0.0.1*) echo "note local http issuer: fine for testing, users need the https URL" ;;
  *) fail "Lunos refuses non-https issuers: $ISSUER" ;;
esac
echo
echo "Ready. Users sign in with:  lunos login --issuer $ISSUER"
