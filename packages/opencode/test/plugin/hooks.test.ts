import { describe, expect, test } from "bun:test"
import { ConfigHooksPlugin, filePathFrom, matches, runEntry } from "../../src/plugin/hooks"

// Config-driven hooks run user-supplied commands on events Lunos already
// dispatches. The behaviour that matters is which entries fire and what a
// non-zero exit means: a `before` hook's failure is a veto that must abort the
// caller, while an `after` hook's failure must not.

const entry = (over: Partial<Parameters<typeof runEntry>[0]> = {}) =>
  ({ command: ["true"], ...over }) as Parameters<typeof runEntry>[0]

describe("filePathFrom", () => {
  test("reads the keys tools actually use", () => {
    expect(filePathFrom({ filePath: "/a.ts" })).toBe("/a.ts")
    expect(filePathFrom({ path: "/b.ts" })).toBe("/b.ts")
    expect(filePathFrom({ file: "/c.ts" })).toBe("/c.ts")
  })

  test("prefers filePath when a tool supplies several", () => {
    expect(filePathFrom({ file: "/c.ts", path: "/b.ts", filePath: "/a.ts" })).toBe("/a.ts")
  })

  test("returns undefined rather than throwing on junk", () => {
    expect(filePathFrom(undefined)).toBeUndefined()
    expect(filePathFrom("string")).toBeUndefined()
    expect(filePathFrom({ filePath: "" })).toBeUndefined()
    expect(filePathFrom({ other: 1 })).toBeUndefined()
  })
})

describe("matches", () => {
  test("an entry with no matcher fires for everything", () => {
    expect(matches(entry(), { tool: "bash" })).toBe(true)
    expect(matches(entry(), {})).toBe(true)
  })

  test("disabled entries never fire", () => {
    expect(matches(entry({ disabled: true }), { tool: "bash" })).toBe(false)
  })

  test("tool globs", () => {
    expect(matches(entry({ matcher: { tool: "edit" } }), { tool: "edit" })).toBe(true)
    expect(matches(entry({ matcher: { tool: "edit" } }), { tool: "bash" })).toBe(false)
    expect(matches(entry({ matcher: { tool: "*" } }), { tool: "anything" })).toBe(true)
  })

  test("file globs", () => {
    const e = entry({ matcher: { file: "**/*.ts" } })
    expect(matches(e, { file: "/src/deep/a.ts" })).toBe(true)
    expect(matches(e, { file: "/src/a.md" })).toBe(false)
  })

  test("a matcher requiring a field it cannot see does not fire", () => {
    // Session events carry no tool or file; a file-scoped hook must stay silent
    // rather than firing on everything.
    expect(matches(entry({ matcher: { file: "**/*.ts" } }), {})).toBe(false)
    expect(matches(entry({ matcher: { tool: "edit" } }), {})).toBe(false)
  })

  test("both conditions must hold", () => {
    const e = entry({ matcher: { tool: "edit", file: "**/*.ts" } })
    expect(matches(e, { tool: "edit", file: "/a.ts" })).toBe(true)
    expect(matches(e, { tool: "bash", file: "/a.ts" })).toBe(false)
    expect(matches(e, { tool: "edit", file: "/a.md" })).toBe(false)
  })
})

describe("runEntry", () => {
  test("a success is silent", async () => {
    await expect(runEntry(entry({ command: ["true"] }), "tool.execute.after", {})).resolves.toBeUndefined()
  })

  test("a failing `before` hook vetoes by throwing", async () => {
    await expect(runEntry(entry({ command: ["false"] }), "tool.execute.before", {})).rejects.toThrow(
      /tool\.execute\.before failed \(exit 1\)/,
    )
  })

  test("a failing `after` hook does not throw", async () => {
    // Observational events must not take down a tool call that already succeeded.
    await expect(runEntry(entry({ command: ["false"] }), "tool.execute.after", {})).resolves.toBeUndefined()
  })

  test("stderr is surfaced in the veto message", async () => {
    const e = entry({ command: ["sh", "-c", "echo 'no commits on dev' >&2; exit 2"] })
    await expect(runEntry(e, "command.execute.before", {})).rejects.toThrow(/no commits on dev/)
  })

  test("context is exported to the command's environment", async () => {
    const out = "/tmp/lunos-hook-env-" + Bun.hash(Math.random().toString()).toString(16)
    const e = entry({
      command: ["sh", "-c", `printf '%s %s %s' "$LUNOS_HOOK_EVENT" "$LUNOS_TOOL" "$LUNOS_FILE" > ${out}`],
    })
    await runEntry(e, "tool.execute.after", { tool: "edit", file: "/a.ts" })
    expect(await Bun.file(out).text()).toBe("tool.execute.after edit /a.ts")
  })

  test("a command that hangs is killed by its timeout", async () => {
    const e = entry({ command: ["sleep", "10"], timeout: 150 })
    // Killed by signal rather than exiting 0, so a `before` hook treats it as a veto.
    await expect(runEntry(e, "tool.execute.before", {})).rejects.toThrow()
  }, 5_000)
})

describe("ConfigHooksPlugin", () => {
  test("does nothing when no hooks are configured", async () => {
    const plugin = await ConfigHooksPlugin({} as never)
    await plugin.config?.({} as never)
    await expect(
      plugin["tool.execute.before"]?.({ tool: "edit", sessionID: "s" } as never, { args: {} } as never),
    ).resolves.toBeUndefined()
  })

  test("a matching before-hook failure aborts the tool call", async () => {
    const plugin = await ConfigHooksPlugin({} as never)
    await plugin.config?.({
      hooks: { "tool.execute.before": [{ command: ["false"], matcher: { file: "**/*.ts" } }] },
    } as never)

    // Matches the glob, so it runs and vetoes.
    await expect(
      plugin["tool.execute.before"]?.(
        { tool: "edit", sessionID: "s" } as never,
        { args: { filePath: "/src/a.ts" } } as never,
      ),
    ).rejects.toThrow(/exit 1/)

    // Different extension, so the hook never runs.
    await expect(
      plugin["tool.execute.before"]?.(
        { tool: "edit", sessionID: "s" } as never,
        { args: { filePath: "/src/a.md" } } as never,
      ),
    ).resolves.toBeUndefined()
  })

  test("unconfigured session events are ignored", async () => {
    const plugin = await ConfigHooksPlugin({} as never)
    await plugin.config?.({ hooks: { "session.idle": [{ command: ["false"] }] } } as never)
    // session.created is not configured, so nothing runs despite the failing entry.
    await expect(
      plugin.event?.({ event: { type: "session.created", properties: {} } } as never),
    ).resolves.toBeUndefined()
  })
})
