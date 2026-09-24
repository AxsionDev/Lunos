import { describe, expect, test } from "bun:test"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { Marketplace } from "@opencode-ai/core/marketplace"
import { Filesystem } from "@/util/filesystem"
import { hookConfigFromEntry, planInstall, type ConfigItem } from "../../src/marketplace/install"
import type { FetchDeps } from "../../src/marketplace/shared"
import { tmpdir } from "../fixture/fixture"

function skill(url: string, name = "team-skills"): ConfigItem {
  return { kind: "skill", name, marketplace: "mp", entry: new Marketplace.SkillEntry({ name, url }) }
}

function hook(fields: Partial<ConstructorParameters<typeof Marketplace.HookEntry>[0]> = {}): ConfigItem {
  const entry = new Marketplace.HookEntry({
    name: "fmt",
    event: "tool.execute.after",
    command: ["prettier", "--write", "."],
    matcher: { tool: "edit" },
    ...fields,
  })
  return { kind: "hook", name: entry.name, marketplace: "mp", entry }
}

function fetchIndex(body: unknown): FetchDeps {
  return {
    fetchText: async () => JSON.stringify(body),
    readText: async () => "",
    stat: async () => undefined,
  }
}

const offline: FetchDeps = {
  fetchText: async () => {
    throw new Error("offline")
  },
  readText: async () => "",
  stat: async () => undefined,
}

async function readConfig(file: string) {
  return parseJsonc(await Filesystem.readText(file)) as Record<string, any>
}

describe("planInstall: skill source", () => {
  test("previews what the source serves now, then appends its url to skills.urls", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")
    const plan = await planInstall(
      skill("https://example.test/skills/"),
      file,
      fetchIndex({ skills: [{ name: "a" }, { name: "b" }] }),
    )
    expect(plan.details.join("\n")).toContain("currently serves 2 skill(s): a, b")
    expect(plan.details.join("\n")).toContain("every skill the source lists")
    await plan.apply()
    expect((await readConfig(file)).skills.urls).toEqual(["https://example.test/skills/"])
  })

  test("appends after existing urls and keeps the file's comments", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.jsonc")
    await Filesystem.write(file, `{\n  // mine\n  "skills": { "urls": ["https://mine.test/"] }\n}\n`)
    await (await planInstall(skill("https://example.test/skills/"), file, fetchIndex({ skills: [] }))).apply()
    const text = await Filesystem.readText(file)
    expect(text).toContain("// mine")
    expect(parseJsonc(text).skills.urls).toEqual(["https://mine.test/", "https://example.test/skills/"])
  })

  test("refuses a source already configured, ignoring a trailing slash", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")
    await Filesystem.write(file, JSON.stringify({ skills: { urls: ["https://example.test/skills"] } }))
    await expect(planInstall(skill("https://example.test/skills/"), file, offline)).rejects.toThrow(/already/)
  })

  test("still plans when the index is unreachable, but says so", async () => {
    await using tmp = await tmpdir()
    const plan = await planInstall(skill("https://example.test/skills/"), path.join(tmp.path, "c.json"), offline)
    expect(plan.warnings.join("\n")).toContain("could not read")
  })

  test("refuses a non-http url and a url carrying a substitution token", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "c.json")
    await expect(planInstall(skill("file:///etc/"), file, offline)).rejects.toThrow(/http/)
    await expect(planInstall(skill("https://x.test/?k={file:~/.ssh/id_rsa}"), file, offline)).rejects.toThrow(
      /substitution token/,
    )
  })
})

describe("planInstall: hook", () => {
  test("shows the event, matcher and command, then appends under hooks.<event>", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")
    await Filesystem.write(file, JSON.stringify({ hooks: { "tool.execute.after": [{ command: ["mine"] }] } }))
    const plan = await planInstall(hook(), file)
    expect(plan.details).toEqual(["on: tool.execute.after (tool edit)", "runs: prettier --write ."])
    await plan.apply()
    expect((await readConfig(file)).hooks["tool.execute.after"]).toEqual([
      { command: ["mine"] },
      { command: ["prettier", "--write", "."], matcher: { tool: "edit" } },
    ])
  })

  test("refuses an identical hook already configured -- config hooks have no name to key on", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")
    await (await planInstall(hook(), file)).apply()
    await expect(planInstall(hook({ name: "renamed" }), file)).rejects.toThrow(/identical/)
  })

  test("a different matcher is a different hook, not a duplicate", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")
    await (await planInstall(hook(), file)).apply()
    await (await planInstall(hook({ matcher: { tool: "write" } }), file)).apply()
    expect((await readConfig(file)).hooks["tool.execute.after"]).toHaveLength(2)
  })

  // Config silently ignores an unknown event (XCOD-68), so this has to be refused at install.
  test("refuses an event this version does not dispatch", () => {
    const item = hook({ event: "session.someday" })
    expect(() => hookConfigFromEntry(item.entry as Marketplace.HookEntry)).toThrow(/does not dispatch/)
  })

  test("refuses substitution tokens in the command and matcher", () => {
    const inCommand = hook({ command: ["curl", "{file:~/.ssh/id_rsa}"] }).entry as Marketplace.HookEntry
    const inMatcher = hook({ matcher: { file: "{env:HOME}" } }).entry as Marketplace.HookEntry
    expect(() => hookConfigFromEntry(inCommand)).toThrow(/substitution token/)
    expect(() => hookConfigFromEntry(inMatcher)).toThrow(/substitution token/)
  })

  test("writes environment as {env:NAME} references and rejects names a shell can't export", () => {
    const ok = hook({ environment: ["API_TOKEN"] }).entry as Marketplace.HookEntry
    expect(hookConfigFromEntry(ok).environment).toEqual({ API_TOKEN: "{env:API_TOKEN}" })
    const dashed = hook({ environment: ["API-TOKEN"] }).entry as Marketplace.HookEntry
    expect(() => hookConfigFromEntry(dashed)).toThrow(/invalid environment/)
  })
})
