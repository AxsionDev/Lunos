import { describe, expect, test } from "bun:test"
import path from "path"
import { compareVersions, parseVersion, resolveBinary, versionWarning, MIN_CLI_VERSION } from "../src/cli"

describe("resolveBinary", () => {
  const unix = (files: string[]) => (file: string) => files.includes(file)

  test("finds lunos on PATH", () => {
    const found = resolveBinary({
      env: { PATH: "/usr/bin:/home/me/.lunos/bin" },
      platform: "linux",
      exists: unix(["/home/me/.lunos/bin/lunos"]),
    })
    expect(found).toBe(path.join("/home/me/.lunos/bin", "lunos"))
  })

  test("never falls back to opencode", () => {
    expect(
      resolveBinary({ env: { PATH: "/usr/local/bin" }, platform: "linux", exists: unix(["/usr/local/bin/opencode"]) }),
    ).toBeUndefined()
  })

  test("the lunos.path setting wins, and a wrong one isn't silently replaced by PATH", () => {
    const exists = unix(["/opt/lunos/bin/lunos", "/usr/bin/lunos"])
    expect(
      resolveBinary({ setting: "/opt/lunos/bin/lunos", env: { PATH: "/usr/bin" }, platform: "linux", exists }),
    ).toBe("/opt/lunos/bin/lunos")
    expect(
      resolveBinary({ setting: "/missing/lunos", env: { PATH: "/usr/bin" }, platform: "linux", exists }),
    ).toBeUndefined()
  })

  test("finds the npm .cmd shim on Windows", () => {
    const found = resolveBinary({
      env: { Path: "C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.CMD" },
      platform: "win32",
      exists: (file) => file === path.join("C:\\Users\\me\\AppData\\Roaming\\npm", "lunos.cmd"),
    })
    expect(found).toBe(path.join("C:\\Users\\me\\AppData\\Roaming\\npm", "lunos.cmd"))
  })
})

describe("versions", () => {
  test("reads the version lunos --version prints", () => {
    expect(parseVersion("1.18.40\n")).toBe("1.18.40")
    expect(parseVersion("local\n")).toBeUndefined()
  })

  test("compares numerically, not as strings", () => {
    expect(compareVersions("1.18.9", "1.18.10")).toBe(-1)
    expect(compareVersions("1.19.0", "1.18.40")).toBe(1)
    expect(compareVersions("1.18.40", "1.18.40")).toBe(0)
  })

  test("warns only below the minimum, and trusts local builds", () => {
    expect(versionWarning("1.18.36")).toContain(`older than ${MIN_CLI_VERSION}`)
    expect(versionWarning("1.18.36")).toContain("npm i -g lunos-ai@latest --allow-scripts=lunos-ai")
    expect(versionWarning(MIN_CLI_VERSION)).toBeUndefined()
    expect(versionWarning(undefined)).toBeUndefined()
  })
})
