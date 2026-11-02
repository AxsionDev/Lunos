export * as AgentSchedule from "./schedule"

/**
 * XCOD-211: when a scheduled agent runs, as the operating system's own scheduler understands it.
 * launchd (macOS), systemd user timers (Linux) and Task Scheduler (Windows) each express a
 * different subset of cron, so Lunos accepts a small, documented subset and refuses the rest:
 *
 *   minute  N, N,M,…, or *\/N            hour  *, N, N,M,…, or *\/N
 *   day     *                            month *
 *   weekday *, D, D,E,…, or D-E (0 or 7 = Sunday)
 *
 * Times are local. The job files hold only `lunos agent run --job <id>`: the agent, prompt and
 * limits live in Lunos's own job registry, never in a file another program parses.
 */

export class Unsupported extends Error {
  override name = "ScheduleUnsupported"
}

export interface Cron {
  /** Minutes past the hour (`every` = every N minutes). */
  minute: { at: number[] } | { every: number }
  /** Hours (`undefined` = every hour). */
  hour: { at: number[] } | { every: number } | undefined
  /** Weekdays, 0 = Sunday (`undefined` = every day). */
  weekdays: number[] | undefined
  source: string
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const SCHTASKS_DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]

function numbers(field: string, what: string, max: number) {
  const out: number[] = []
  for (const part of field.split(",")) {
    if (!/^\d+$/.test(part)) throw new Unsupported(`${what} "${field}" isn't supported (use numbers, a list, or */N)`)
    const value = Number(part)
    if (value > max) throw new Unsupported(`${what} ${value} is out of range (0-${max})`)
    out.push(value)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

function every(field: string, what: string, max: number) {
  const match = field.match(/^\*\/(\d+)$/)
  if (!match) return undefined
  const value = Number(match[1])
  if (value < 1 || value > max) throw new Unsupported(`${what} step ${value} is out of range (1-${max})`)
  return value
}

export function parse(source: string): Cron {
  const fields = source.trim().split(/\s+/)
  if (fields.length !== 5)
    throw new Unsupported(`"${source}" isn't a cron schedule: it needs 5 fields (minute hour day month weekday)`)
  const [minute, hour, day, month, weekday] = fields
  if (day !== "*" || month !== "*")
    throw new Unsupported("Only * is supported for the day-of-month and month fields; schedule by weekday instead")

  const minuteEvery = every(minute, "Minute", 59)
  const hourEvery = hour === "*" ? undefined : every(hour, "Hour", 23)
  if (minuteEvery && hour !== "*")
    throw new Unsupported("*/N minutes only works with every hour (*); use explicit minutes for set hours")

  let weekdays: number[] | undefined
  if (weekday !== "*") {
    const range = weekday.match(/^(\d)-(\d)$/)
    const list = range
      ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, index) => Number(range[1]) + index)
      : numbers(weekday, "Weekday", 7)
    if (range && Number(range[2]) < Number(range[1])) throw new Unsupported(`Weekday range "${weekday}" runs backwards`)
    weekdays = [...new Set(list.map((day) => day % 7))].sort((a, b) => a - b)
  }

  return {
    minute: minuteEvery ? { every: minuteEvery } : { at: numbers(minute, "Minute", 59) },
    hour: hour === "*" ? undefined : hourEvery ? { every: hourEvery } : { at: numbers(hour, "Hour", 23) },
    weekdays,
    source: source.trim(),
  }
}

/** Plain-language description, for previews and `schedule list`. */
export function describe(cron: Cron) {
  const two = (value: number) => String(value).padStart(2, "0")
  const days = cron.weekdays ? ` on ${cron.weekdays.map((day) => DAYS[day]).join(", ")}` : " every day"
  if ("every" in cron.minute) return `every ${cron.minute.every} minutes${days}`
  const minutes = cron.minute.at
  if (!cron.hour) return `every hour at :${minutes.map(two).join(", :")}${days}`
  if ("every" in cron.hour) return `every ${cron.hour.every} hours at :${minutes.map(two).join(", :")}${days}`
  const hours = cron.hour.at
  const times = hours.flatMap((hour) => minutes.map((minute) => `${two(hour)}:${two(minute)}`))
  return `at ${times.join(", ")}${days} (local time)`
}

function expand(values: { at: number[] } | { every: number } | undefined, max: number) {
  if (!values) return undefined
  if ("at" in values) return values.at
  return Array.from({ length: Math.floor(max / values.every) + 1 }, (_, index) => index * values.every).filter(
    (value) => value <= max,
  )
}

// ---------------------------------------------------------------------------------------------
// macOS: a launchd agent

export function launchdLabel(id: string) {
  return `tech.lunos.agent.${id}`
}

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

export function launchdPlist(input: { id: string; command: string[]; cwd: string; log: string; cron: Cron }) {
  const minutes = expand(input.cron.minute, 59)!
  const hours = expand(input.cron.hour, 23)
  const days = input.cron.weekdays
  const entries: Record<string, number>[] = []
  for (const day of days ?? [undefined])
    for (const hour of hours ?? [undefined])
      for (const minute of minutes)
        entries.push({
          Minute: minute,
          ...(hour === undefined ? {} : { Hour: hour }),
          ...(day === undefined ? {} : { Weekday: day }),
        })
  if (entries.length > 500)
    throw new Unsupported("That schedule expands to more than 500 launchd entries; use a coarser one")
  const dict = (entry: Record<string, number>) =>
    `    <dict>\n${Object.entries(entry)
      .map(([key, value]) => `      <key>${key}</key><integer>${value}</integer>`)
      .join("\n")}\n    </dict>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(launchdLabel(input.id))}</string>
  <key>ProgramArguments</key>
  <array>
${input.command.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(input.cwd)}</string>
  <key>StandardOutPath</key><string>${xml(input.log)}</string>
  <key>StandardErrorPath</key><string>${xml(input.log)}</string>
  <key>StartCalendarInterval</key>
  <array>
${entries.map(dict).join("\n")}
  </array>
</dict>
</plist>
`
}

// ---------------------------------------------------------------------------------------------
// Linux: a systemd user service and timer

export function systemdName(id: string) {
  return `lunos-agent-${id}`
}

export function onCalendar(cron: Cron) {
  const field = (values: { at: number[] } | { every: number } | undefined) =>
    !values
      ? "*"
      : "every" in values
        ? `0/${values.every}`
        : values.at.map((value) => String(value).padStart(2, "0")).join(",")
  const days = cron.weekdays ? `${cron.weekdays.map((day) => DAYS[day]).join(",")} ` : ""
  return `${days}*-*-* ${field(cron.hour)}:${field(cron.minute)}:00`
}

/** systemd's own quoting for ExecStart: each argument double-quoted, `\` and `"` escaped. */
const systemdArg = (arg: string) => `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`

export function systemdUnits(input: { id: string; command: string[]; cwd: string; cron: Cron }) {
  const name = systemdName(input.id)
  return {
    service: `[Unit]
Description=Lunos scheduled agent ${input.id}

[Service]
Type=oneshot
WorkingDirectory=${input.cwd}
ExecStart=${input.command.map(systemdArg).join(" ")}
`,
    timer: `[Unit]
Description=Lunos scheduled agent ${input.id} (${input.cron.source})

[Timer]
OnCalendar=${onCalendar(input.cron)}
Persistent=true
Unit=${name}.service

[Install]
WantedBy=timers.target
`,
  }
}

// ---------------------------------------------------------------------------------------------
// Windows: a Task Scheduler task

export function schtasksName(id: string) {
  return `Lunos\\agent-${id}`
}

/**
 * `schtasks /Create` arguments. Task Scheduler's command line can say less than launchd or systemd:
 * one time a day (optionally on some weekdays), or every N minutes.
 */
export function schtasksArgs(input: { id: string; command: string[]; cron: Cron }) {
  const quoted = input.command.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)).join(" ")
  if (quoted.length > 261) throw new Unsupported("The command is too long for Task Scheduler (261 characters)")
  const base = ["/Create", "/F", "/TN", schtasksName(input.id), "/TR", quoted]
  const { minute, hour, weekdays } = input.cron
  if ("every" in minute) {
    if (weekdays) throw new Unsupported("On Windows, */N minutes can't be limited to some weekdays")
    return [...base, "/SC", "MINUTE", "/MO", String(minute.every)]
  }
  if (!hour || !("at" in hour) || hour.at.length !== 1 || minute.at.length !== 1)
    throw new Unsupported('On Windows a schedule is one time a day (e.g. "30 9 * * 1-5") or */N minutes')
  const time = `${String(hour.at[0]).padStart(2, "0")}:${String(minute.at[0]).padStart(2, "0")}`
  if (weekdays)
    return [...base, "/SC", "WEEKLY", "/D", weekdays.map((day) => SCHTASKS_DAYS[day]).join(","), "/ST", time]
  return [...base, "/SC", "DAILY", "/ST", time]
}
