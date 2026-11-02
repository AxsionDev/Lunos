#!/bin/bash
# The fix Lunos shipped (XCOD-111, 7c41978120).
cat > /app/install.ts <<'TS'
export function manualInstallCommand(target?: string) {
  return `npm i -g lunos-ai${target ? `@${target}` : ""} --allow-scripts=lunos-ai`
}
TS
