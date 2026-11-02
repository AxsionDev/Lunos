import { expect, test } from "bun:test"
import { manualInstallCommand } from "/app/install"

const words = (command: string) => command.trim().split(/\s+/)

test("allows lunos-ai's install script, which npm 12 skips by default", () => {
  const command = manualInstallCommand("1.18.40")
  expect(command).toMatch(/--allow-scripts[= ]lunos-ai\b/)
  expect(words(command)).toContain("lunos-ai@1.18.40")
  expect(words(command)[0]).toBe("npm")
  expect(words(command).some((word) => word === "-g" || word === "--global")).toBe(true)
})

test("without a version it installs the latest, still allowing the script", () => {
  const command = manualInstallCommand()
  expect(command).toMatch(/--allow-scripts[= ]lunos-ai\b/)
  expect(words(command).some((word) => word === "lunos-ai" || word === "lunos-ai@latest")).toBe(true)
})
