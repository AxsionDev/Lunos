import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AgentSchedule } from "@/agent/schedule"
import { AgentUnattended } from "@/agent/unattended"

// XCOD-211: cron (a documented subset) to launchd, systemd and Task Scheduler.

const command = ["/usr/local/bin/lunos", "agent", "run", "--job", "ab12cd34"]

describe("AgentSchedule.parse", () => {
  const cases: [string, string][] = [
    ["30 9 * * *", "at 09:30 every day (local time)"],
    ["30 9 * * 1-5", "at 09:30 on Mon, Tue, Wed, Thu, Fri (local time)"],
    ["0 9,13 * * 0,6", "at 09:00, 13:00 on Sun, Sat (local time)"],
    ["*/15 * * * *", "every 15 minutes every day"],
    ["5 * * * *", "every hour at :05 every day"],
    ["0 */6 * * *", "every 6 hours at :00 every day"],
    ["0 8 * * 7", "at 08:00 on Sun (local time)"],
  ]
  for (const [cron, said] of cases)
    test(`"${cron}" is ${said}`, () => expect(AgentSchedule.describe(AgentSchedule.parse(cron))).toBe(said))

  const refused: [string, RegExp][] = [
    ["0 9 * *", /5 fields/],
    ["0 9 1 * *", /day-of-month and month/],
    ["0 9 * 1 *", /day-of-month and month/],
    ["*/15 9 * * *", /every hour/],
    ["60 9 * * *", /out of range/],
    ["0 24 * * *", /out of range/],
    ["0 9 * * MON", /isn't supported/],
    ["0 9 * * 5-1", /backwards/],
    ["@daily", /5 fields/],
  ]
  for (const [cron, reason] of refused)
    test(`"${cron}" is refused`, () => expect(() => AgentSchedule.parse(cron)).toThrow(reason))
})

describe("job files", () => {
  test("launchd: one entry per time, weekdays as 0-6, the command as separate arguments", () => {
    const plist = AgentSchedule.launchdPlist({
      id: "ab12cd34",
      command: [...command.slice(0, 1), "agent", "run", "--job", "ab12cd34"],
      cwd: "/Users/me/project & co",
      log: "/tmp/x.log",
      cron: AgentSchedule.parse("0 9,13 * * 1-5"),
    })
    expect(plist.match(/<key>Minute<\/key>/g)).toHaveLength(10)
    expect(plist).toContain("<key>Weekday</key><integer>5</integer>")
    expect(plist).toContain("<string>--job</string>")
    expect(plist).toContain("/Users/me/project &amp; co")
    expect(plist).toContain("<string>tech.lunos.agent.ab12cd34</string>")
  })

  test.skipIf(process.platform !== "darwin")("launchd accepts the plist (plutil -lint)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xcod-211-"))
    try {
      const file = path.join(dir, "job.plist")
      await fs.writeFile(
        file,
        AgentSchedule.launchdPlist({
          id: "ab12cd34",
          command,
          cwd: dir,
          log: "/tmp/x.log",
          cron: AgentSchedule.parse("*/15 * * * *"),
        }),
      )
      const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" })
      expect(lint.stdout + lint.stderr).toContain("OK")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("systemd: OnCalendar from the cron, arguments quoted for ExecStart", () => {
    expect(AgentSchedule.onCalendar(AgentSchedule.parse("30 9 * * 1-5"))).toBe("Mon,Tue,Wed,Thu,Fri *-*-* 09:30:00")
    expect(AgentSchedule.onCalendar(AgentSchedule.parse("*/15 * * * *"))).toBe("*-*-* *:0/15:00")
    expect(AgentSchedule.onCalendar(AgentSchedule.parse("0 */6 * * *"))).toBe("*-*-* 0/6:00:00")
    const units = AgentSchedule.systemdUnits({
      id: "ab12cd34",
      command: ["/opt/lunos 1/lunos", "agent", "run", "--job", "ab12cd34"],
      cwd: "/home/me",
      cron: AgentSchedule.parse("30 9 * * *"),
    })
    expect(units.service).toContain('ExecStart="/opt/lunos 1/lunos" "agent" "run" "--job" "ab12cd34"')
    expect(units.timer).toContain("OnCalendar=*-*-* 09:30:00")
    expect(units.timer).toContain("Persistent=true")
  })

  test("Task Scheduler: daily, weekly or every N minutes; anything else is refused", () => {
    const args = (cron: string) =>
      AgentSchedule.schtasksArgs({ id: "ab12cd34", command, cron: AgentSchedule.parse(cron) })
    expect(args("30 9 * * *").slice(-4)).toEqual(["/SC", "DAILY", "/ST", "09:30"])
    expect(args("30 9 * * 1-5").slice(-6)).toEqual(["/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI", "/ST", "09:30"])
    expect(args("*/15 * * * *").slice(-4)).toEqual(["/SC", "MINUTE", "/MO", "15"])
    expect(args("30 9 * * *")).toContain("Lunos\\agent-ab12cd34")
    expect(() => args("0 9,13 * * *")).toThrow(/one time a day/)
    expect(() =>
      AgentSchedule.schtasksArgs({
        id: "x",
        command: ["C:\\" + "a".repeat(300)],
        cron: AgentSchedule.parse("0 9 * * *"),
      }),
    ).toThrow(/too long/)
  })
})

test("durations", () => {
  expect(AgentUnattended.duration("90s")).toBe(90)
  expect(AgentUnattended.duration("30m")).toBe(1800)
  expect(AgentUnattended.duration("2h")).toBe(7200)
  expect(AgentUnattended.duration("45")).toBe(45)
  expect(() => AgentUnattended.duration("soon")).toThrow(/isn't a duration/)
})
