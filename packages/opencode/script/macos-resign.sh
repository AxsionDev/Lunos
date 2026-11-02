#!/usr/bin/env bash
# XCOD-207: give the macOS CLI binaries a valid signature before they are packed and published.
#
# The release builds the darwin binaries on Linux. Bun embeds the JS bundle after linking, which
# invalidates the binary's signature (arm64: the linker's ad-hoc one; x64: Bun's own Developer ID
# one), so `codesign --verify --strict` fails on every shipped macOS binary. This re-signs each one
# ad-hoc on a Mac, verifies it, and repacks its release zip so the zip carries the re-signed file.
#
# Ad-hoc, not Developer ID: there is no Apple certificate yet (PO decision 2026-10-12). A valid
# ad-hoc signature does not satisfy Gatekeeper, so a quarantined download is still refused; npm and
# the install script don't set the quarantine flag. Swap `-` for a Developer ID identity (plus
# --timestamp --options runtime) when one exists.
#
#   macos-resign.sh <dist dir> [expected version]
#
# <dist dir> holds lunos-darwin-{arm64,x64,x64-baseline}/bin/opencode as build.ts lays it out, plus
# lunos-darwin-*.zip when the build was a release. With [expected version], the binary for this
# Mac's architecture is run from the repacked zip and must print that version.
set -euo pipefail

dist=${1:?usage: macos-resign.sh <dist dir> [expected version]}
expected=${2:-}
targets=(lunos-darwin-arm64 lunos-darwin-x64 lunos-darwin-x64-baseline)
dist=$(cd "$dist" && pwd)
check=$(mktemp -d)
trap 'rm -rf "$check"' EXIT

case "$(uname -m)" in
  arm64) native=lunos-darwin-arm64 ;;
  x86_64) native=lunos-darwin-x64 ;;
  *) native= ;;
esac

# Fail on a missing target before signing anything, rather than signing whatever happens to be there.
for name in "${targets[@]}"; do
  [ -f "$dist/$name/bin/opencode" ] || { echo "::error::missing $dist/$name/bin/opencode"; exit 1; }
done

for name in "${targets[@]}"; do
  bin="$dist/$name/bin/opencode"
  # Artifact downloads drop the executable bit; the zip below must carry it.
  chmod 755 "$bin"
  # --force replaces the broken signature. No --options runtime: the hardened runtime would refuse
  # the unsigned native libraries Bun extracts at run time, and is meaningless without notarisation.
  codesign --force --sign - "$bin"
  codesign --verify --strict --verbose=2 "$bin"
  codesign --display --verbose=2 "$bin" 2>&1 | grep -E '^(Identifier|Format|Signature|CodeDirectory)'

  zip="$dist/$name.zip"
  # build.ts only makes the zips for a release; don't invent one for a non-release build.
  if [ -f "$zip" ]; then
    rm -f "$zip"
    # Same flat layout as build.ts: opencode, LICENSE, THIRD_PARTY_NOTICES at the zip root.
    (cd "$dist/$name/bin" && zip -q -r "$zip" ./*)
    unzip -q "$zip" -d "$check/$name"
    codesign --verify --strict "$check/$name/opencode"
    [ -x "$check/$name/opencode" ] || { echo "::error::$name.zip: opencode is not executable"; exit 1; }
    echo "$name.zip: repacked, signature verified after unzip"
    run="$check/$name/opencode"
  else
    echo "$name.zip: not present (not a release build), skipped"
    run="$bin"
  fi

  if [ -n "$expected" ] && [ "$name" = "$native" ]; then
    # Throwaway HOME/XDG and working directory: `--version` must not read or write a real profile
    # or the checkout.
    home="$check/home"
    mkdir -p "$home/project"
    smoke=(HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_DATA_HOME="$home/.local/share"
      XDG_CACHE_HOME="$home/.cache" XDG_STATE_HOME="$home/.local/state")
    printf '%s\n' "${smoke[@]}"
    actual=$(cd "$home/project" && env "${smoke[@]}" "$run" --version)
    echo "$name: --version printed '$actual'"
    [ "$actual" = "$expected" ] || { echo "::error::$name: expected version $expected, got '$actual'"; exit 1; }
  fi
done

if [ -n "$expected" ] && [ -z "$native" ]; then
  echo "::error::cannot smoke-test on $(uname -m)"
  exit 1
fi
echo "re-signed and verified: ${targets[*]}"
