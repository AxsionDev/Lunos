import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import Ajv from "ajv"
import { Audit } from "@opencode-ai/core/audit"
import { Offline } from "@opencode-ai/core/offline"
import { AuditLog } from "../../src/audit/log"
import { SecurityDeps } from "../../src/security/deps"
import { SecurityReview } from "../../src/security/review"
import { SecurityRules } from "../../src/security/rules"
import { SecurityTarget } from "../../src/security/target"
import SARIF_SCHEMA from "../fixtures/security/sarif-schema-2.1.0.json"
import { tmpdir } from "../fixture/fixture"

const ENTRY = path.join(import.meta.dir, "../../src/index.ts")

// The four planted issues of XCOD-334's acceptance test. Realistic on purpose: the model-driven
// "Fix all" run uses the same repository, and a toy (AWS's documented example key, an action that
// changes nothing) is rightly dismissed by a model as not exploitable.
const CONTROLLER = (attributes: string) =>
  [
    "using Microsoft.AspNetCore.Authorization;",
    "using Microsoft.AspNetCore.Mvc;",
    "",
    "[Authorize]",
    "public class TransfersController : Controller",
    "{",
    "    private readonly IBank _bank;",
    "    public TransfersController(IBank bank) => _bank = bank;",
    "",
    `    [HttpPost]${attributes}`,
    "    public IActionResult Create(string toAccount, decimal amount)",
    "    {",
    "        _bank.Transfer(User.Identity!.Name!, toAccount, amount);",
    '        return RedirectToAction("Index");',
    "    }",
    "}",
    "",
  ].join("\n")

const PLANTED = {
  "src/users.ts": [
    'import { Pool } from "pg"',
    'import type { Request, Response } from "express"',
    "",
    "const pool = new Pool()",
    "",
    "export async function findUser(req: Request, res: Response) {",
    "  const result = await pool.query(`SELECT id, email FROM users WHERE email = '${req.query.email}'`)",
    "  res.json(result.rows)",
    "}",
    "",
  ].join("\n"),
  "src/storage.ts": [
    'import { S3Client } from "@aws-sdk/client-s3"',
    "",
    'export const s3 = new S3Client({ region: "eu-central-1", credentials: { accessKeyId: "AKIA2E0A8F3B244C9986", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! } })',
    "",
  ].join("\n"),
  "Controllers/TransfersController.cs": CONTROLLER(""),
  "package.json": JSON.stringify({ name: "fx", dependencies: { lodash: "4.17.15" } }, null, 2) + "\n",
}

// What the fix subagents change: parameters, the environment, the anti-forgery attribute, the fixed version.
const FIXED = {
  "src/users.ts": PLANTED["src/users.ts"].replace(
    "pool.query(`SELECT id, email FROM users WHERE email = '${req.query.email}'`)",
    'pool.query("SELECT id, email FROM users WHERE email = $1", [req.query.email])',
  ),
  "src/storage.ts": PLANTED["src/storage.ts"].replace('"AKIA2E0A8F3B244C9986"', "process.env.AWS_ACCESS_KEY_ID!"),
  "Controllers/TransfersController.cs": CONTROLLER("\n    [ValidateAntiForgeryToken]"),
  "package.json": JSON.stringify({ name: "fx", dependencies: { lodash: "4.17.21" } }, null, 2) + "\n",
}

// OSV's answer for lodash 4.17.15 (GHSA-p6mc-m468-83gw, abridged); nothing for 4.17.21.
const lookup: SecurityDeps.Lookup = async (bump) =>
  bump.name === "lodash" && bump.to === "4.17.15"
    ? [
        {
          id: "GHSA-p6mc-m468-83gw",
          summary: "Prototype Pollution in lodash",
          aliases: ["CVE-2020-8203"],
          database_specific: { severity: "HIGH", cwe_ids: ["CWE-1321"] },
          affected: [
            {
              package: { name: "lodash", ecosystem: "npm" },
              ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.19" }] }],
            },
          ],
        },
      ]
    : []

async function repo() {
  return tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "package.json"), FIXED["package.json"])
      await Bun.write(path.join(dir, ".lunos/security.md"), "- All controllers need [Authorize].\n")
      await $`git add -A && git commit -qm base`.cwd(dir).quiet()
    },
  })
}

async function write(dir: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) await Bun.write(path.join(dir, file), text)
}

const offline = process.env[Offline.ENV]
afterEach(() => {
  if (offline === undefined) delete process.env[Offline.ENV]
  else process.env[Offline.ENV] = offline
})

describe("XCOD-334 security review", () => {
  test("AC1: all four planted issues are reported with the right severity, and the fixed tree reviews clean", async () => {
    await using dir = await repo()
    await write(dir.path, PLANTED)
    const report = await SecurityReview.run({ cwd: dir.path, spec: { kind: "uncommitted" }, lookup })
    const summary = report.findings.map((item) => [item.id, item.severity, item.cwe, item.file, item.line])
    expect(summary).toEqual([
      ["secrets/aws-access-key", "critical", "CWE-798", "src/storage.ts", 3],
      ["csrf/missing-antiforgery", "high", "CWE-352", "Controllers/TransfersController.cs", 10],
      ["dependency/known-vulnerability", "high", "CWE-1321", "package.json", 4],
      ["injection/sql", "high", "CWE-89", "src/users.ts", 7],
    ])
    // Every finding says why and how to fix it; the key itself never reaches the report.
    for (const item of report.findings) expect(item.why && item.fix).toBeTruthy()
    expect(JSON.stringify(report)).not.toContain("AKIA2E0A8F3B244C9986")
    expect(report.findings[2]!.fix).toBe("Use lodash 4.17.19 or later.")
    expect(report.dependencies.bumps).toEqual([
      { ecosystem: "npm", name: "lodash", from: "4.17.21", to: "4.17.15", file: "package.json", line: 4 },
    ])
    // Project rules come from the base revision.
    expect(report.rules).toBe("- All controllers need [Authorize].")
    expect(SecurityReview.blocking(report)).toHaveLength(4)

    await write(dir.path, FIXED)
    const after = await SecurityReview.run({ cwd: dir.path, spec: { kind: "uncommitted" }, lookup })
    expect(after.findings).toEqual([])
    expect(SecurityReview.blocking(after)).toHaveLength(0)
  })

  test("AC3: a suppression with a reason is honoured and audited; one without a reason is not", async () => {
    await using dir = await repo()
    const file = path.join(dir.path, "audit.log")
    AuditLog.activate({ enabled: true, file, redact: [] })
    await write(dir.path, {
      "src/a.ts": [
        "// lunos-ignore-security test fixture, not a live key",
        'export const key = "AKIAIOSFODNN7EXAMPLE"',
        'export const h = require("crypto").createHash("md5") # lunos-ignore-security',
        "",
      ].join("\n"),
      "app.py":
        'cursor.execute(f"SELECT * FROM t WHERE id = {uid}")  # lunos-ignore-security uid is an int from our own table\n',
    })
    const report = await SecurityReview.run({ cwd: dir.path, spec: { kind: "uncommitted" }, osv: false })
    await AuditLog.flush()
    AuditLog.activate({ enabled: false, file, redact: [] })

    expect(report.suppressed.map((item) => [item.id, item.file, item.line, item.reason])).toEqual([
      ["secrets/aws-access-key", "src/a.ts", 2, "test fixture, not a live key"],
      ["injection/sql", "app.py", 1, "uid is an int from our own table"],
    ])
    expect(report.findings.map((item) => item.id)).toEqual(["crypto/weak-hash"])
    expect(report.unjustified).toEqual([{ file: "src/a.ts", line: 3 }])
    expect(SecurityReview.blocking(report)).toHaveLength(0)

    const rows = (await Audit.read(file)).filter((row) => row.event === "security.suppressed")
    expect(rows.map((row) => [row.rule, row.severity, row.paths, row.line, row.reason, row.target])).toEqual([
      ["secrets/aws-access-key", "critical", ["src/a.ts"], 2, "test fixture, not a live key", "uncommitted"],
      ["injection/sql", "high", ["app.py"], 1, "uid is an int from our own table", "uncommitted"],
    ])
    expect((await Audit.verify(file)).ok).toBe(true)
  })

  test("AC2: lunos security-review exits 1 on a High finding and 0 when clean, and its SARIF validates", async () => {
    await using dir = await repo()
    await write(dir.path, { ...PLANTED, "package.json": FIXED["package.json"] })
    const cli = (...args: string[]) =>
      Bun.spawn(["bun", "run", ENTRY, "security-review", "--no-osv", ...args], {
        cwd: dir.path,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LUNOS_DISABLE_AUTOUPDATE: "1" },
      })

    const failing = cli("--sarif", "out.sarif")
    expect(await failing.exited).toBe(1)
    expect(await new Response(failing.stdout).text()).toContain(
      "[High] SQL built from interpolated or concatenated values (CWE-89)",
    )
    const log = await Bun.file(path.join(dir.path, "out.sarif")).json()
    const validate = sarifValidator()
    expect(validate(log), JSON.stringify(validate.errors)).toBe(true)
    expect(log.runs[0].results.map((result: { ruleId: string }) => result.ruleId).toSorted()).toEqual([
      "csrf/missing-antiforgery",
      "injection/sql",
      "secrets/aws-access-key",
    ])

    await write(dir.path, FIXED)
    const clean = cli("--sarif", "out.sarif")
    expect(await clean.exited).toBe(0)
    expect(await new Response(clean.stdout).text()).toContain("No findings.")
    const empty = await Bun.file(path.join(dir.path, "out.sarif")).json()
    expect(validate(empty), JSON.stringify(validate.errors)).toBe(true)
    expect(empty.runs[0].results).toEqual([])
  }, 120_000)

  test("SARIF carries suppressions, CWE tags and security-severity", async () => {
    await using dir = await repo()
    await write(dir.path, {
      ...PLANTED,
      "src/storage.ts": 'export const id = "AKIA2E0A8F3B244C9986" // lunos-ignore-security revoked test key\n',
    })
    const log = SecurityReview.sarif(await SecurityReview.run({ cwd: dir.path, spec: { kind: "uncommitted" }, lookup }))
    const validate = sarifValidator()
    expect(validate(log), JSON.stringify(validate.errors)).toBe(true)
    const run = log.runs[0]!
    const suppressed = run.results.find((result) => result.ruleId === "secrets/aws-access-key")!
    expect(suppressed.suppressions).toEqual([{ kind: "inSource", justification: "revoked test key" }])
    const sql = run.tool.driver.rules.find((rule) => rule.id === "injection/sql")!
    expect(sql.properties.tags).toContain("external/cwe/cwe-89")
    expect(sql.properties["security-severity"]).toBe("8.0")
  })

  test("--branch reviews a branch against its merge base and reads rules from the base", async () => {
    await using dir = await repo()
    await $`git checkout -qb feature`.cwd(dir.path).quiet()
    await write(dir.path, { "src/users.ts": PLANTED["src/users.ts"], ".lunos/security.md": "nothing applies\n" })
    await $`git add -A && git commit -qm feature && git checkout -q -`.cwd(dir.path).quiet()
    const base = (await $`git rev-parse --abbrev-ref HEAD`.cwd(dir.path).text()).trim()
    const report = await SecurityReview.run({
      cwd: dir.path,
      spec: SecurityTarget.parse(`--branch feature --base ${base}`),
      osv: false,
    })
    expect(report.target).toBe("branch feature")
    expect(report.findings.map((item) => [item.id, item.file, item.line])).toEqual([
      ["injection/sql", "src/users.ts", 7],
    ])
    // The branch rewrote the rules; the base's still apply.
    expect(report.rules).toBe("- All controllers need [Authorize].")
  })

  test("a branch that only removes [ValidateAntiForgeryToken] is flagged (nothing added)", async () => {
    await using dir = await repo()
    await write(dir.path, { "Controllers/TransfersController.cs": FIXED["Controllers/TransfersController.cs"] })
    await $`git add -A && git commit -qm protected`.cwd(dir.path).quiet()
    const base = (await $`git rev-parse --abbrev-ref HEAD`.cwd(dir.path).text()).trim()
    await $`git checkout -qb feature`.cwd(dir.path).quiet()
    await write(dir.path, { "Controllers/TransfersController.cs": PLANTED["Controllers/TransfersController.cs"] })
    await $`git add -A && git commit -qm unprotected`.cwd(dir.path).quiet()
    const report = await SecurityReview.run({
      cwd: dir.path,
      spec: SecurityTarget.parse(`--branch feature --base ${base}`),
      osv: false,
    })
    expect(report.files).toBe(1)
    expect(report.findings.map((item) => [item.id, item.severity, item.file])).toEqual([
      ["csrf/missing-antiforgery", "high", "Controllers/TransfersController.cs"],
    ])
  })

  test("offline mode turns the OSV lookup off but still lists the dependency changes", async () => {
    await using dir = await repo()
    await write(dir.path, { "package.json": PLANTED["package.json"] })
    process.env[Offline.ENV] = "1"
    let called = false
    const report = await SecurityReview.run({
      cwd: dir.path,
      spec: { kind: "uncommitted" },
      lookup: async () => {
        called = true
        return []
      },
    })
    expect(called).toBe(false)
    expect(report.dependencies.osv).toBe("offline")
    expect(report.dependencies.bumps.map((bump) => bump.name)).toEqual(["lodash"])
    expect(SecurityReview.markdown(report)).toContain("offline mode (LUNOS_OFFLINE) is on")
    expect(Offline.CALLS.find((call) => call.id === "osv")?.offline).toBe("blocked")
  })

  test("/security-review's template gets the scan and the base branch's rules", async () => {
    await using dir = await repo()
    await write(dir.path, { "src/users.ts": PLANTED["src/users.ts"] })
    const text = await SecurityReview.expand("A $SECURITY_SCAN B $SECURITY_RULES C", "", dir.path)
    expect(text).toContain("[High] SQL built from interpolated or concatenated values (CWE-89)")
    expect(text).toContain('"id": "injection/sql"')
    expect(text).toContain("B - All controllers need [Authorize]. C")
    const outside = await SecurityReview.expand("$SECURITY_SCAN|$SECURITY_RULES", "", "/")
    expect(outside).toStartWith("The deterministic scan could not run:")
    expect(outside).toEndWith("|(none: no .lunos/security.md on the base branch)")
  })
})

describe("XCOD-334 security review internals", () => {
  test("--fix answers the fix question in advance and doesn't change the target", async () => {
    expect(SecurityTarget.parse("--branch feature --base main --fix all")).toEqual({
      kind: "branch",
      name: "feature",
      base: "main",
    })
    expect(SecurityTarget.parse("--fix high")).toEqual({ kind: "uncommitted" })
    const template = await Bun.file(path.join(import.meta.dir, "../../src/command/template/security-review.txt")).text()
    expect(template).toContain("`--fix high`, `--fix all` or `--fix none`")
    // With no one to answer (lunos run in CI), nothing is fixed and the model doesn't choose.
    expect(template).toContain("If the question tool is unavailable or the question is refused")
    expect(template).toContain("Never choose for the user.")
  })

  test("parses targets as typed after the command", () => {
    expect(SecurityTarget.parse("")).toEqual({ kind: "uncommitted" })
    expect(SecurityTarget.parse("--branch feat/x")).toEqual({ kind: "branch", name: "feat/x", base: undefined })
    expect(SecurityTarget.parse("--branch=feat --base=dev")).toEqual({ kind: "branch", name: "feat", base: "dev" })
    expect(SecurityTarget.parse("--pr #42")).toEqual({ kind: "pr", number: "42" })
    expect(SecurityTarget.parse("--pr https://github.com/o/r/pull/7")).toEqual({ kind: "pr", number: "7" })
  })

  test("numbers added lines as in the new file, and marks deletions", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,0 +2,2 @@",
      "+one",
      "+++two",
      "@@ -9 +11 @@",
      "-old",
      "+eleven",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n")
    expect(SecurityTarget.parseDiff(diff)).toEqual([
      {
        file: "x.ts",
        added: [
          { line: 2, text: "one" },
          { line: 3, text: "++two" },
          { line: 11, text: "eleven" },
        ],
        deleted: false,
        removed: [10, 11],
      },
      { file: "gone.ts", added: [], deleted: true },
    ])
  })

  test.each([
    ["const q = `SELECT * FROM t WHERE id = ${id}`", "injection/sql"],
    ['cur.execute("SELECT * FROM t WHERE n = \'" + name + "\'")', "injection/sql"],
    ['cur.execute("DELETE FROM t WHERE id = %s" % uid)', "injection/sql"],
    ["exec(`git log ${branch}`)", "injection/command"],
    ["res.sendFile(path.join(root, req.params.name))", "injection/path-traversal"],
    ["const r = await fetch(req.query.url)", "ssrf/request-url"],
    ["el.innerHTML = comment", "xss/raw-html"],
    ["const data = pickle.loads(blob)", "deserialization/unsafe"],
    ['jwt.verify(token, key, { algorithms: ["none"] })', "auth/jwt-unverified"],
    ["const agent = new https.Agent({ rejectUnauthorized: false })", "auth/tls-unverified"],
    ['crypto.createCipheriv("aes-128-ecb", key, null)', "crypto/weak-cipher"],
    ['crypto.createHmac("sha256", "s3cr3t-signing-key")', "crypto/hardcoded-key"],
    ['res.setHeader("Access-Control-Allow-Origin", "*")', "config/cors-any"],
    ["app.run(host='0.0.0.0', debug=True)", "config/debug"],
    ['const dbPassword = "Zx9!qP2#vL7@mR4t"', "auth/hardcoded-credential"],
    ["@csrf_exempt", "csrf/disabled"],
  ])("flags %s", (text, rule) => {
    const file =
      text.includes("pickle") || text.includes("app.run") || text.includes("csrf_exempt") || text.includes("cur.")
        ? "a.py"
        : "a.ts"
    expect(SecurityRules.scanLines(file, [{ line: 1, text }]).map((item) => item.id)).toContain(rule)
  })

  test.each([
    'const q = db.query("SELECT * FROM t WHERE id = ?", [id])',
    "el.textContent = comment",
    "const password = process.env.DB_PASSWORD",
    'const password = "changeme"',
    '"integrity": "sha512-9b8f5f1e8d0b0c0a0e0f0a0b0c0d0e0f0a0b0c0d0e0f0a0b0c0d0e0f0a0b0c0d"',
    "const sha = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3a94a8fe5ccb19ba61c4c0873'",
  ])("does not flag %s", (text) => {
    expect(SecurityRules.scanLines("a.ts", [{ line: 1, text }])).toEqual([])
  })

  test("a pure deletion marks the new-file lines on each side of it", () => {
    const [change] = SecurityTarget.parseDiff(
      [
        "diff --git a/C.cs b/C.cs",
        "--- a/C.cs",
        "+++ b/C.cs",
        "@@ -11 +10,0 @@ public class C",
        "-    [ValidateAntiForgeryToken]",
        "@@ -20,2 +19,1 @@",
        "--- a removed SQL comment",
        "-x",
        "+y",
      ].join("\n"),
    )
    expect(change!.added).toEqual([{ line: 19, text: "y" }])
    expect(change!.removed).toEqual([10, 11, 18, 19])
  })

  test("anti-forgery: a class-level or global attribute and API controllers are covered", () => {
    const body = (prefix: string) =>
      `${prefix}public class C : Controller\n{\n    [HttpPost]\n    public IActionResult Save() => Ok();\n}\n`
    const added = [{ line: 1 }, { line: 2 }, { line: 3 }, { line: 4 }, { line: 5 }, { line: 6 }]
    expect(SecurityRules.scanFile("C.cs", added, body(""))).toHaveLength(1)
    expect(SecurityRules.scanFile("C.cs", added, body("[ValidateAntiForgeryToken]\n"))).toEqual([])
    expect(SecurityRules.scanFile("C.cs", added, body("[ApiController]\n"))).toEqual([])
    // An unchanged action isn't the change's finding.
    expect(SecurityRules.scanFile("C.cs", [{ line: 1 }], body(""))).toEqual([])
  })

  test("reads versions from manifests and lockfiles", () => {
    expect(
      SecurityDeps.versions(
        "package-lock.json",
        JSON.stringify({
          packages: {
            "": { version: "1.0.0" },
            "node_modules/a": { version: "1.2.3" },
            "node_modules/x/node_modules/@s/b": { version: "2.0.0" },
          },
        }),
      ),
    ).toEqual(
      new Map([
        ["a", "1.2.3"],
        ["@s/b", "2.0.0"],
      ]),
    )
    expect(SecurityDeps.versions("requirements.txt", "django==3.2.1\nrequests[socks]>=2.0.0\n# x\n")).toEqual(
      new Map([
        ["django", "3.2.1"],
        ["requests", "2.0.0"],
      ]),
    )
    expect(
      SecurityDeps.versions("App.csproj", '<PackageReference Include="Newtonsoft.Json" Version="12.0.1" />'),
    ).toEqual(new Map([["Newtonsoft.Json", "12.0.1"]]))
    expect(SecurityDeps.versions("go.mod", "require (\n\tgolang.org/x/net v0.7.0\n)\n")).toEqual(
      new Map([["golang.org/x/net", "0.7.0"]]),
    )
    expect(SecurityDeps.versions("bun.lock", '    "zod": ["zod@3.22.0", "", {}, "sha512-x"],\n')).toEqual(
      new Map([["zod", "3.22.0"]]),
    )
  })

  test("rates OSV advisories by their own label, else by the CVSS v3 score", () => {
    expect(SecurityDeps.cvss3("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8)
    expect(SecurityDeps.cvss3("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1)
    expect(SecurityDeps.severity({ id: "x", database_specific: { severity: "MODERATE" } })).toBe("medium")
    expect(
      SecurityDeps.severity({
        id: "x",
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
      }),
    ).toBe("critical")
    expect(SecurityDeps.severity({ id: "x" })).toBe("medium")
  })
})

function sarifValidator() {
  const ajv = new Ajv({ strict: false, allErrors: true })
  ajv.addFormat("uri", (value: string) => URL.canParse(value))
  ajv.addFormat("uri-reference", (value: string) => URL.canParse(value, "file:///"))
  ajv.addFormat("date-time", (value: string) => !Number.isNaN(Date.parse(value)))
  return ajv.compile<ReturnType<typeof SecurityReview.sarif>>(SARIF_SCHEMA)
}
