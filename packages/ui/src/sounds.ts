// XCOD-311: the bundled notification sounds, shared by the desktop/web app and the TUI so a choice
// saved in one is understood by the other. Each ID has an .aac (app) and an .mp3 (TUI) under
// assets/audio; a test checks both exist.

export const SOUND_FAMILIES = [
  { id: "alert", label: "Alert", count: 10 },
  { id: "bip-bop", label: "Bip-bop", count: 10 },
  { id: "staplebops", label: "Staplebops", count: 7 },
  { id: "nope", label: "Nope", count: 12 },
  { id: "yup", label: "Yup", count: 6 },
] as const

export type SoundFamily = (typeof SOUND_FAMILIES)[number]["id"]

/** Every bundled sound ID, family by family: "alert-01" … "yup-06". */
export const SOUND_IDS: readonly string[] = SOUND_FAMILIES.flatMap((family) =>
  Array.from({ length: family.count }, (_, index) => `${family.id}-${String(index + 1).padStart(2, "0")}`),
)

/** Saved for an event that should make no sound. */
export const NO_SOUND = "none"

export function isSoundID(value: unknown): value is string {
  return typeof value === "string" && SOUND_IDS.includes(value)
}

/** "Alert 04", from "alert-04". */
export function soundLabel(id: string) {
  const family = SOUND_FAMILIES.find((item) => id.startsWith(item.id + "-"))
  return family ? `${family.label} ${id.slice(family.id.length + 1)}` : id
}

export function soundFamily(id: string) {
  return SOUND_FAMILIES.find((item) => id.startsWith(item.id + "-"))
}

/**
 * The events a sound can be chosen for, in the order the settings list them, with the labels both
 * apps show. `default` ("Other") is any alert a plugin sends without naming an event.
 */
export const SOUND_EVENTS = [
  { id: "done", label: "Lunos finished" },
  { id: "subagent_done", label: "Subagent finished" },
  { id: "permission", label: "Needs your approval" },
  { id: "question", label: "Question for you" },
  { id: "waiting", label: "Waiting for action" },
  { id: "budget_warning", label: "Budget warning" },
  { id: "error", label: "Error" },
  { id: "default", label: "Other" },
] as const

export type SoundEvent = (typeof SOUND_EVENTS)[number]["id"]

/** The built-in pack: what each event plays when nothing else is chosen. */
export const DEFAULT_SOUNDS: Record<SoundEvent, string> = {
  default: "bip-bop-01",
  question: "bip-bop-03",
  permission: "staplebops-06",
  error: "nope-03",
  done: "bip-bop-01",
  subagent_done: "yup-01",
  // A subagent's approval or question: the approval sound, so most asks sound as they did.
  waiting: "staplebops-06",
  budget_warning: "alert-02",
}

/** Custom files a sound can be loaded from. */
export const SOUND_FILE_EXTENSIONS = [".mp3", ".aac", ".wav"] as const

/** Within 0–1; anything that isn't a number is silent. */
export function clampVolume(volume: number) {
  if (!Number.isFinite(volume)) return 0
  return Math.min(1, Math.max(0, volume))
}

/** The settings choose volume in steps of 10%: 0.3, never 0.30000000000000004. */
export function stepVolume(volume: number) {
  return Math.round(clampVolume(volume) * 10) / 10
}
