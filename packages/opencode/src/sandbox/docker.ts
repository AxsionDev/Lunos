import { SandboxExec } from "./exec"
import type { SandboxConfig } from "./config"
import { PROXY_PORT } from "./egress"

// XCOD-144: everything that talks to the Docker CLI. The isolation flags live in `createArgs` and are
// not configurable — config chooses the image, resources and lifecycle only.

export const LABEL = "lunos.sandbox"
export const PORT = 4096
export const UID = "1000:1000"
export const ROOT = "/sandbox"
export const WORKSPACE = `${ROOT}/workspace`
export const HOME = `${ROOT}/home`
/** XCOD-157: tmpfs for the runtime file (see boot.ts); owned by the sandbox user, gone on stop. */
export const RUNTIME_DIR = "/run/lunos"
export const RUNTIME_FILE = `${RUNTIME_DIR}/runtime.json`
/**
 * XCOD-157: where Lunos reads managed config on Linux. A separate volume, root-owned and mounted
 * read-only, holds the organisation's managed config and the marker saying this is a sandbox, so
 * neither can be changed from inside.
 */
export const POLICY_DIR = "/etc/lunos"
/**
 * XCOD-157: the audit log of the server inside. Config pointing elsewhere (the host's audit.path)
 * is rewritten to this, since the host path doesn't exist in the container and the root is read-only.
 */
export const AUDIT_FILE = `${HOME}/audit.log`
export const MARKER = "sandbox.json"

export const containerName = (id: string) => `lunos-sandbox-${id}`
export const volumeName = (id: string) => `lunos-sandbox-${id}`
export const policyVolumeName = (id: string) => `lunos-sandbox-${id}-policy`
/** XCOD-157: the egress proxy and relay container, and the internal network it guards. */
export const egressName = (id: string) => `lunos-sandbox-${id}-egress`
export const networkName = (id: string) => `lunos-sandbox-${id}-net`
/** The sandbox container's name on its network, and the proxy's. */
export const SANDBOX_ALIAS = "sandbox"
export const EGRESS_ALIAS = "egress"

// XCOD-158: Docker or Podman. Every command below goes through `bin()`: the two CLIs take the same
// arguments for everything the sandbox does, and differ only where output is parsed (`info`, `ps`),
// which is why listing uses `inspect` templates both understand.
/** `name` is the command; `engine` what answers it (a podman-docker shim is `docker` running podman). */
export type Runtime = { name: "docker" | "podman"; engine: "docker" | "podman"; version: string }

let runtime: Runtime | undefined

/** The container CLI: the one `available()` found, or the one a known sandbox was made with (`use`). */
export const bin = () => runtime?.name ?? "docker"

/** Commands on an existing sandbox use the runtime that created it, without probing. */
export function use(name: Runtime["name"] | undefined, engine: Runtime["engine"] | undefined = name) {
  if (name && runtime?.name !== name) runtime = { name, engine: engine ?? name, version: name }
}

const engine = () => runtime?.engine ?? "docker"

/**
 * The runtime tmpfs, owned by the sandbox user. Podman refuses Docker's uid=/gid= options and has
 * its own, `U`: chown to the container's user (verified on rootless Podman 5.8).
 */
export function runtimeTmpfs(on: Runtime["engine"] = engine(), user = UID) {
  const [uid, gid] = user.split(":")
  const owner = on === "podman" ? "U" : `uid=${uid},gid=${gid}`
  return `${RUNTIME_DIR}:rw,noexec,nosuid,nodev,size=1m,mode=0700,${owner}`
}

/**
 * The network the egress container starts on, before it joins the sandbox's internal one. Rootless
 * Podman otherwise gives it `pasta` networking, which can't join a bridge network afterwards.
 */
export const outsideNetwork = (on: Runtime["engine"] = engine()) => (on === "podman" ? "podman" : "bridge")

/**
 * XCOD-158: the name a container reaches this machine by (a model served here, e.g. Ollama). Docker
 * Desktop and Podman provide one; Docker Engine on Linux doesn't, so without this the egress proxy
 * answered "Couldn't reach host.docker.internal". `host-gateway` works on Docker Desktop too.
 */
export const hostAlias = (on: Runtime["engine"] = engine()) =>
  on === "podman" ? [] : ["--add-host", "host.docker.internal:host-gateway"]

/**
 * XCOD-158: who the sandbox runs as. `user` is the container user; `userns` a Podman user namespace.
 * The default (uid 1000) suits copy mode everywhere. With the working tree bind-mounted, files the
 * agent writes must end up owned by you, so mount mode depends on the runtime (see `mountIdentity`).
 */
export type Identity = { user: string; userns?: string }
export const DEFAULT_IDENTITY: Identity = { user: UID }
const usernsArgs = (identity: Identity) => (identity.userns ? ["--userns", identity.userns] : [])

/**
 * The identity for `workspace: "mount"`, or why it can't be offered here. Only what has been
 * verified: Docker Desktop (its file sharing maps ownership to you), rootless Podman (keep-id maps
 * uid 1000 to you), and rootful Docker Engine on Linux (the sandbox runs as your own uid). Never
 * root, and never a chown of your files.
 */
export async function mountIdentity(
  on: Runtime["engine"] = engine(),
  host = { platform: process.platform, uid: process.getuid?.(), gid: process.getgid?.() },
): Promise<Identity> {
  if (on === "podman") {
    const rootless = (await run(["info", "--format", "{{.Host.Security.Rootless}}"])).stdout.trim() === "true"
    if (rootless) return { user: UID, userns: `keep-id:uid=${UID.split(":")[0]},gid=${UID.split(":")[1]}` }
    return hostIdentity(host)
  }
  const info = (await run(["info", "--format", "{{.OperatingSystem}}|{{json .SecurityOptions}}"])).stdout
  if (/rootless/.test(info))
    throw new Error(
      'sandbox.workspace "mount" isn\'t supported with rootless Docker yet: file ownership in your working tree ' +
        'hasn\'t been verified there. Use "copy", or rootless Podman.',
    )
  if (/Docker Desktop/i.test(info) || host.platform !== "linux") return DEFAULT_IDENTITY
  return hostIdentity(host)
}

function hostIdentity(host: { uid?: number; gid?: number }): Identity {
  if (host.uid === undefined || host.gid === undefined) return DEFAULT_IDENTITY
  if (host.uid === 0)
    throw new Error(
      'sandbox.workspace "mount" would run the sandbox as root, because you are root here. Use "copy", or run Lunos as a regular user.',
    )
  return { user: `${host.uid}:${host.gid}` }
}

/** XCOD-158: the host side of `workspace: "mount"` and of sandbox.mounts. */
export type Binds = {
  /** Your working tree, mounted read-write at WORKSPACE. Unset in copy mode. */
  root?: string
  /** Paths under root mounted read-only over it: .git, Lunos's own config. Relative to root. */
  protect: string[]
  /** Paths outside root mounted read-only at the same path: a linked worktree's git directories. */
  outside: string[]
  /** sandbox.mounts, already checked: read-only. */
  extra: { source: string; target: string }[]
}
export const NO_BINDS: Binds = { protect: [], outside: [], extra: [] }

const bind = (source: string, target: string, readonly: boolean) => [
  "--mount",
  `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`,
]

export function bindArgs(binds: Binds) {
  return [
    ...(binds.root ? bind(binds.root, WORKSPACE, false) : []),
    ...(binds.root
      ? binds.protect.flatMap((item) =>
          bind(`${binds.root}/${item}`, `${WORKSPACE}/${item.split("\\").join("/")}`, true),
        )
      : []),
    ...binds.outside.flatMap((item) => bind(item, item, true)),
    ...binds.extra.flatMap((item) => bind(item.source, item.target, true)),
  ]
}

export const current = () => runtime

const docker = (args: string[], options?: SandboxExec.Options) => SandboxExec.check([bin(), ...args], options)
const run = (args: string[], options?: SandboxExec.Options) => SandboxExec.run([bin(), ...args], options)

async function probe(name: Runtime["name"]): Promise<Runtime | string> {
  // `podman info` has no .ServerVersion; .Version.Version is podman's. Both print "podman" for a
  // podman-docker shim's `--version`, which is how a shim installed as `docker` is recognised.
  const version = await SandboxExec.run([name, "--version"]).catch(() => undefined)
  if (!version || version.code !== 0) return `the ${name} command was not found`
  const actual = /podman/i.test(version.stdout) ? "podman" : name
  const format = actual === "podman" ? "{{.Version.Version}}" : "{{.ServerVersion}}"
  const info = await SandboxExec.run([name, "info", "--format", format]).catch(() => undefined)
  if (!info || info.code !== 0)
    return `${name} is installed but not running: ${info?.stderr.trim().split("\n")[0] ?? "no response"}`
  return { name, engine: actual, version: `${actual} ${info.stdout.trim()}` }
}

/**
 * Find a container runtime: `sandbox.runtime` if set, else Docker, then Podman. Throws, saying what
 * was tried and why each failed, when neither is usable: a sandboxed run never falls back to the host.
 */
export async function available(preferred?: Runtime["name"]) {
  const order: Runtime["name"][] = preferred ? [preferred] : ["docker", "podman"]
  const reasons: string[] = []
  for (const name of order) {
    const found = await probe(name)
    if (typeof found !== "string") {
      runtime = found
      return found.version
    }
    reasons.push(found)
  }
  throw new Error(
    `Sandboxed runs need Docker or Podman, and ${preferred ? `${preferred} (sandbox.runtime) isn't` : "neither is"} available: ` +
      reasons.join("; ") +
      ". Install Docker Desktop, Docker Engine or Podman and start it, then try again. Nothing was run on this machine.",
  )
}

export type Image = { ref: string; id: string; digest?: string }

/** Resolve the image to an immutable ID, pulling it if it isn't present. */
export async function image(ref: string): Promise<Image> {
  const inspect = () => SandboxExec.run([bin(), "image", "inspect", ref, "--format", "{{.Id}}|{{json .RepoDigests}}"])
  let result = await inspect()
  if (result.code !== 0) {
    const pull = await SandboxExec.run([bin(), "pull", ref])
    if (pull.code !== 0)
      throw new Error(
        `Couldn't get the sandbox image ${ref}: ${pull.stderr.trim()}. ` +
          `Build one locally with \`bun run packages/opencode/script/sandbox-image.ts\` (tags lunos-sandbox:local) ` +
          `and set "sandbox": { "image": "lunos-sandbox:local" }, or point sandbox.image at an image you can pull. ` +
          `Set it in your global config (~/.config/opencode/opencode.json) or managed config: the network ` +
          `policy's proxy runs from that image too, and ignores an image a repository's config chooses.`,
      )
    result = await inspect()
    if (result.code !== 0) throw new Error(`docker image inspect ${ref} failed: ${result.stderr.trim()}`)
  }
  const [id, digests] = result.stdout.trim().split("|")
  const digest = (JSON.parse(digests || "[]") as string[])[0]
  return { ref, id, ...(digest ? { digest } : {}) }
}

/**
 * `docker create` arguments for the sandbox container. No secret is among them: provider keys and
 * the server password arrive after start, through the runtime file (`inject`), so they never show in
 * `docker inspect` or on a retained container.
 */
export function createArgs(input: {
  id: string
  project: string
  image: Image
  resources: SandboxConfig.Resolved["resources"]
  workdir: string
  env: Record<string, string>
  /** XCOD-157: "open" keeps Docker's default network; otherwise only the internal one, via the proxy. */
  network?: SandboxConfig.Network
  engine?: Runtime["engine"]
  identity?: Identity
  binds?: Binds
}) {
  const network = input.network ?? "open"
  const identity = input.identity ?? DEFAULT_IDENTITY
  const binds = input.binds ?? NO_BINDS
  // XCOD-158: with the working tree mounted, git sees a directory it may not own (and .git read-only):
  // trust it, and don't take optional locks such as `git status` refreshing the index.
  const gitEnv: Record<string, string> = binds.root
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "*",
        GIT_OPTIONAL_LOCKS: "0",
      }
    : {}
  const proxy = `http://${EGRESS_ALIAS}:${PROXY_PORT}`
  const networkArgs =
    network === "open"
      ? // The server is reachable from the host's loopback only, on a port Docker picks.
        ["--publish", `127.0.0.1::${PORT}`, ...hostAlias(input.engine)]
      : // No route out and no published port: the egress container is the only way in or out.
        ["--network", networkName(input.id), "--network-alias", SANDBOX_ALIAS]
  const proxyEnv =
    network === "open"
      ? {}
      : {
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          NO_PROXY: "localhost,127.0.0.1",
          no_proxy: "localhost,127.0.0.1",
          // models.dev isn't on the allow list; the bundled snapshot is used instead.
          OPENCODE_DISABLE_MODELS_FETCH: "1",
        }
  return [
    "create",
    "--name",
    containerName(input.id),
    "--label",
    `${LABEL}=${input.id}`,
    "--label",
    `${LABEL}.project=${input.project}`,
    // Isolation defaults: non-root, no capabilities, no privilege escalation, Docker's default
    // seccomp profile (never overridden), read-only root filesystem. The only writable paths are
    // the sandbox volume, /tmp, and in mount mode your working tree. The Docker socket is never mounted.
    "--user",
    identity.user,
    ...usernsArgs(identity),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,exec,nosuid,nodev,size=${input.resources.tmp}`,
    "--tmpfs",
    runtimeTmpfs(input.engine, identity.user),
    "--volume",
    `${volumeName(input.id)}:${ROOT}`,
    "--volume",
    `${policyVolumeName(input.id)}:${POLICY_DIR}:ro`,
    ...bindArgs(binds),
    "--workdir",
    input.workdir,
    "--cpus",
    String(input.resources.cpus),
    "--memory",
    input.resources.memory,
    "--pids-limit",
    String(input.resources.pids),
    ...networkArgs,
    ...Object.entries({ ...input.env, ...proxyEnv, ...gitEnv, LUNOS_SANDBOX_RUNTIME: RUNTIME_FILE }).flatMap(
      ([key, value]) => ["--env", `${key}=${value}`],
    ),
    input.image.id,
    "serve",
    "--hostname",
    "0.0.0.0",
    "--port",
    String(PORT),
  ]
}

export async function createVolume(id: string) {
  await docker(["volume", "create", "--label", `${LABEL}=${id}`, volumeName(id)])
  await docker(["volume", "create", "--label", `${LABEL}=${id}`, policyVolumeName(id)])
}

/**
 * Fill the volume from a tar stream in a throwaway container: no network, no host mounts, only the
 * CHOWN capability so the files end up owned by the sandbox user.
 */
export async function seed(
  id: string,
  imageID: string,
  tar: string[],
  tarEnv?: Record<string, string>,
  identity: Identity = DEFAULT_IDENTITY,
) {
  await SandboxExec.pipe(
    tar,
    [
      bin(),
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--user",
      "0:0",
      // The same user namespace as the sandbox, or under Podman's keep-id the files' owner wouldn't
      // be the sandbox user there.
      ...usernsArgs(identity),
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--volume",
      `${volumeName(id)}:${ROOT}`,
      "--entrypoint",
      "/bin/sh",
      imageID,
      "-c",
      `mkdir -p ${WORKSPACE} ${HOME} && tar -x -o -f - -C ${WORKSPACE} && chown -R ${identity.user} ${ROOT}`,
    ],
    { from: { env: tarEnv } },
  )
}

/**
 * Fill the policy volume from a directory holding managed.json (when the organisation has managed
 * config) and the sandbox marker. Root-owned and world-readable, so the sandbox user can read it
 * and, even before the read-only mount, not change it.
 */
export async function seedPolicy(
  id: string,
  imageID: string,
  dir: string,
  tarEnv?: Record<string, string>,
  identity: Identity = DEFAULT_IDENTITY,
) {
  await SandboxExec.pipe(
    ["tar", "-c", "-f", "-", "-C", dir, "."],
    [
      bin(),
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--user",
      "0:0",
      ...usernsArgs(identity),
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "FOWNER",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--volume",
      `${policyVolumeName(id)}:${POLICY_DIR}`,
      "--entrypoint",
      "/bin/sh",
      imageID,
      "-c",
      `tar -x -o -f - -C ${POLICY_DIR} && chown -R 0:0 ${POLICY_DIR} && chmod -R go-w,a+rX ${POLICY_DIR}`,
    ],
    { from: { env: tarEnv } },
  )
}

export async function create(args: string[]) {
  await docker(args)
}

/**
 * The egress side of a sandbox whose network isn't "open": an internal network, and a container
 * from the trusted Lunos image on both it and Docker's default network, running `lunos sandbox
 * egress` with the allow list. Locked down like the sandbox itself; it publishes the relay port.
 */
export function egressArgs(input: {
  id: string
  image: Image
  allow: readonly string[]
  network?: SandboxConfig.Network
  engine?: Runtime["engine"]
}) {
  return [
    "create",
    "--name",
    egressName(input.id),
    "--network",
    outsideNetwork(input.engine),
    ...hostAlias(input.engine),
    "--label",
    `${LABEL}.egress=${input.id}`,
    "--user",
    UID,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--memory",
    "256m",
    "--pids-limit",
    "64",
    "--publish",
    `127.0.0.1::${PORT}`,
    "--env",
    "HOME=/tmp",
    "--env",
    "OPENCODE_DISABLE_AUTOUPDATE=1",
    "--env",
    `LUNOS_EGRESS_ALLOW=${JSON.stringify(input.allow)}`,
    "--env",
    `LUNOS_EGRESS_UPSTREAM=${SANDBOX_ALIAS}:${PORT}`,
    "--env",
    `LUNOS_EGRESS_MODE=${input.network ?? "policy"}`,
    input.image.id,
    "sandbox",
    "egress",
  ]
}

export async function createEgress(input: {
  id: string
  image: Image
  allow: readonly string[]
  network?: SandboxConfig.Network
}) {
  await docker(["network", "create", "--internal", "--label", `${LABEL}.net=${input.id}`, networkName(input.id)])
  await docker(egressArgs(input))
  await docker(["network", "connect", "--alias", EGRESS_ALIAS, networkName(input.id), egressName(input.id)])
}

export async function hasEgress(id: string) {
  return (await SandboxExec.run([bin(), "container", "inspect", egressName(id)])).code === 0
}

/** The egress proxy's decisions, one JSON line each, from its log. */
export async function egressLog(id: string) {
  const result = await SandboxExec.run([bin(), "logs", egressName(id)])
  return result.stdout
}

/**
 * Write the runtime file into the running container's tmpfs, as the sandbox user, through stdin: the
 * values never appear in an argv, an environment or a file on the host.
 */
export async function inject(id: string, runtime: string, identity: Identity = DEFAULT_IDENTITY) {
  await docker(
    [
      "exec",
      "-i",
      "--user",
      identity.user,
      containerName(id),
      "/bin/sh",
      "-c",
      `umask 077 && cat > ${RUNTIME_FILE}.part && mv ${RUNTIME_FILE}.part ${RUNTIME_FILE}`,
    ],
    { input: runtime },
  )
}

export async function start(id: string) {
  if (await hasEgress(id)) await docker(["start", egressName(id)])
  await docker(["start", containerName(id)])
}

export async function stop(id: string) {
  await docker(["stop", "--time", "10", containerName(id)])
  if (await hasEgress(id)) await docker(["stop", "--time", "5", egressName(id)])
}

/** Remove the container and its volume. Missing ones are not an error. */
export async function remove(id: string) {
  await SandboxExec.run([bin(), "rm", "--force", "--volumes", containerName(id)])
  await SandboxExec.run([bin(), "rm", "--force", egressName(id)])
  await SandboxExec.run([bin(), "network", "rm", networkName(id)])
  for (const name of [volumeName(id), policyVolumeName(id)]) {
    const volume = await SandboxExec.run([bin(), "volume", "rm", "--force", name])
    if (volume.code !== 0) throw new Error(`docker volume rm ${name} failed: ${volume.stderr.trim()}`)
  }
}

/** The host port the sandbox server is reached on: the egress relay's, or with network "open" its own. */
export async function hostPort(id: string) {
  const out = await docker(["port", (await hasEgress(id)) ? egressName(id) : containerName(id), `${PORT}/tcp`])
  const line = out.split("\n").find((item) => item.startsWith("127.0.0.1:"))
  if (!line) throw new Error(`the sandbox server port isn't published: ${out.trim()}`)
  return Number(line.split(":")[1])
}

export async function logs(id: string, tail = 40) {
  const result = await SandboxExec.run([bin(), "logs", "--tail", String(tail), containerName(id)])
  return (result.stdout + result.stderr).trim()
}

/** `docker logs`, straight to this process's stdout and stderr; `follow` streams until it stops. */
export async function streamLogs(id: string, options: { tail?: number; follow?: boolean } = {}) {
  const proc = Bun.spawn(
    [
      bin(),
      "logs",
      ...(options.tail !== undefined ? ["--tail", String(options.tail)] : []),
      ...(options.follow ? ["--follow"] : []),
      containerName(id),
    ],
    { stdout: "inherit", stderr: "inherit", stdin: "ignore" },
  )
  return proc.exited
}

/** One file's contents from the container (running or stopped), or undefined when it's absent. */
export async function readFile(id: string, file: string) {
  return SandboxExec.pipe([bin(), "cp", `${containerName(id)}:${file}`, "-"], ["tar", "-x", "-O", "-f", "-"]).catch(
    () => undefined,
  )
}

/** Stream the workspace out of the container (running or stopped) and extract it into `into`. */
export async function copyOut(id: string, into: string) {
  await SandboxExec.pipe([bin(), "cp", `${containerName(id)}:${WORKSPACE}`, "-"], ["tar", "-x", "-f", "-", "-C", into])
}

export type Listed = { id: string; name: string; state: string; status: string; project?: string; created: string }

/** The `inspect` template listing reads: the same fields and syntax in Docker and Podman. */
export const LIST_FORMAT = `{{index .Config.Labels "${LABEL}"}}\t{{.Name}}\t{{.State.Status}}\t{{index .Config.Labels "${LABEL}.project"}}\t{{.Created}}`

/** Parse `inspect --format LIST_FORMAT` output. `ps --format {{json .}}` differs between the runtimes. */
export function parseList(out: string): Listed[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, name, state, project, created] = line.split("\t")
      return { id, name: name.replace(/^\//, ""), state, status: state, project: project || undefined, created }
    })
    .filter((row) => row.id && row.id !== "<no value>")
}

export async function list(): Promise<Listed[]> {
  const ids = (await docker(["ps", "--all", "--quiet", "--filter", `label=${LABEL}`])).split("\n").filter(Boolean)
  if (ids.length === 0) return []
  return parseList(await docker(["inspect", "--format", LIST_FORMAT, ...ids]))
}

export async function exists(id: string) {
  return (await SandboxExec.run([bin(), "container", "inspect", containerName(id)])).code === 0
}

export * as SandboxDocker from "./docker"
