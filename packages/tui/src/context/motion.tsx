import { createMemo } from "solid-js"
import { useKV } from "./kv"
import { useTuiConfig } from "../config"
import { animationsEnabled } from "../util/motion"

/** Whether animations run, from TUI config, the environment and the in-app toggle (XCOD-107). */
export function useAnimationsEnabled() {
  const kv = useKV()
  const config = useTuiConfig()
  return createMemo(() => animationsEnabled(config.reduced_motion, kv.get("animations_enabled")))
}
