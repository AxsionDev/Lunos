// XCOD-338: what a typed /remote asks for. Anything else is an ordinary prompt.
import { expect, test } from "bun:test"
import { parseRemote } from "../../src/component/remote-control"

test("/remote, /remote on, /remote off", () => {
  expect(parseRemote("/remote")).toBe("toggle")
  expect(parseRemote("/remote on")).toBe("on")
  expect(parseRemote("  /remote OFF  ")).toBe("off")
  expect(parseRemote("/remote please")).toBeUndefined()
  expect(parseRemote("/remotes")).toBeUndefined()
  expect(parseRemote("turn /remote on")).toBeUndefined()
})
