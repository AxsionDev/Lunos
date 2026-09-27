import { describe, expect, test } from "bun:test"
import { PACKAGE_UNINSTALL, removeLunosPath } from "../../src/cli/cmd/uninstall"

describe("lunos uninstall", () => {
  test("removes the lunos-ai package, and never an opencode one", () => {
    expect(PACKAGE_UNINSTALL.npm).toEqual(["npm", "uninstall", "-g", "lunos-ai"])
    for (const cmd of Object.values(PACKAGE_UNINSTALL)) {
      expect(cmd).toContain("lunos-ai")
      expect(cmd!.join(" ")).not.toContain("opencode")
    }
  })

  test("has no Homebrew, Chocolatey or Scoop command: Lunos isn't published there", () => {
    expect(PACKAGE_UNINSTALL.brew).toBeUndefined()
    expect(PACKAGE_UNINSTALL.choco).toBeUndefined()
    expect(PACKAGE_UNINSTALL.scoop).toBeUndefined()
  })

  test("removes the PATH lines the Lunos install script wrote", () => {
    const zshrc = ["alias ll='ls -l'", "", "# lunos", "export PATH=/home/me/.lunos/bin:$PATH", ""].join("\n")
    expect(removeLunosPath(zshrc)).toBe("alias ll='ls -l'\n")
    const fish = ["set -x EDITOR vim", "", "# lunos", "fish_add_path /home/me/.lunos/bin"].join("\n")
    expect(removeLunosPath(fish)).toBe("set -x EDITOR vim\n")
  })

  test("leaves upstream opencode's PATH lines alone", () => {
    const rc = [
      "# opencode",
      "export PATH=/home/me/.opencode/bin:$PATH",
      "# lunos",
      "export PATH=/home/me/.lunos/bin:$PATH",
    ].join("\n")
    expect(removeLunosPath(rc)).toBe(["# opencode", "export PATH=/home/me/.opencode/bin:$PATH"].join("\n") + "\n")
  })
})
