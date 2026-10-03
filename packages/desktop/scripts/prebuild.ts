#!/usr/bin/env bun
import { $ } from "bun"

import { downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`
// XCOD-177: the licence notices for what the app ships (fails on a licence the gate doesn't allow),
// and Lunos's own licence, packaged next to the executable and opened from Help.
await $`bun ../opencode/script/notices.ts --desktop --check`
await $`bun ../opencode/script/notices.ts --desktop --output resources/THIRD_PARTY_NOTICES`
await $`cp ../../LICENSE resources/LICENSE`
if (channel === "dev") await downloadCliToResources()
