#!/bin/bash
# The fix Lunos shipped (XCOD-77, 4d57a25ce8): wait for stdout to drain before exiting.
sed -i 's|^process.stdout.write(JSON.stringify(skills, null, 2) + "\\n")|await Bun.write(Bun.stdout, JSON.stringify(skills, null, 2) + "\\n")|' /app/print.ts
