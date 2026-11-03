import { expect, test } from "bun:test"
import { sandboxExternalDirectory } from "../../src/agent/agent"
import { Permission } from "../../src/permission"

const config = "/sandbox/home/.config/lunos"
const data = "/sandbox/home/.local/share/lunos"
const cache = "/sandbox/home/.cache/lunos"
const audit = "/sandbox/home/audit.log"

test("XCOD-343: inside a sandbox, its own volume doesn't ask, but Lunos's config there still does", () => {
  const rules = Permission.fromConfig({
    external_directory: { "*": "ask", ...sandboxExternalDirectory(true, [config, data, cache], audit) },
  })
  const action = (pattern: string) => Permission.evaluate("external_directory", pattern, rules).action
  // The prompt from the report: the workspace's parent.
  expect(action("/sandbox/*")).toBe("allow")
  expect(action("/sandbox")).toBe("allow")
  expect(action("/sandbox/home/*")).toBe("allow")
  // Config that could loosen the agent's own permissions keeps asking.
  expect(action(`${config}/*`)).toBe("ask")
  expect(action(config)).toBe("ask")
  // Nor its sessions and run logs, the binaries it runs, or the sandbox's audit log.
  expect(action(`${data}/*`)).toBe("ask")
  expect(action(`${cache}/bin/*`)).toBe("ask")
  expect(action(audit)).toBe("ask")
  // Anything else outside the project still asks.
  expect(action("/etc/*")).toBe("ask")
})

test("XCOD-343: on the host, nothing changes", () => {
  expect(sandboxExternalDirectory(false, [config], audit)).toEqual({})
})
