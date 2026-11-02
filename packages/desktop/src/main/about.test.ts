import { expect, test } from "bun:test"
import { aboutPanel } from "./about"

test("the About box names Lunos, its version, and the upstream base", () => {
  expect(aboutPanel("1.18.41", "1.18.32")).toMatchObject({
    applicationName: "Lunos",
    applicationVersion: "1.18.41",
    version: "based on opencode 1.18.32",
    website: "https://lunos.tech",
  })
  expect(aboutPanel("1.18.41", "").version).toBe("")
})
