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

const docker = (args: string[], options?: SandboxExec.Options) => SandboxExec.check(["docker", ...args], options)

export async function available() {
  const result = await SandboxExec.run(["docker", "info", "--format", "{{.ServerVersion}}"]).catch(() => undefined)
  if (!result || result.code !== 0)
    throw new Error(
      "Sandboxed runs need Docker, and it isn't available: " +
        (result?.stderr.trim() || "the docker command was not found") +
        ". Install Docker Desktop or Docker Engine and start it, then try again.",
    )
  return result.stdout.trim()
}

export type Image = { ref: string; id: string; digest?: string }

/** Resolve the image to an immutable ID, pulling it if it isn't present. */
export async function image(ref: string): Promise<Image> {
  const inspect = () =>
    SandboxExec.run(["docker", "image", "inspect", ref, "--format", "{{.Id}}|{{json .RepoDigests}}"])
  let result = await inspect()
  if (result.code !== 0) {
    const pull = await SandboxExec.run(["docker", "pull", ref])
    if (pull.code !== 0)
      throw new Error(
        `Couldn't get the sandbox image ${ref}: ${pull.stderr.trim()}. ` +
          `Build one locally with \`bun run packages/opencode/script/sandbox-image.ts\` (tags lunos-sandbox:local) ` +
          `and set "sandbox": { "image": "lunos-sandbox:local" }, or point sandbox.image at an image you can pull.`,
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
}) {
  const network = input.network ?? "open"
  const proxy = `http://${EGRESS_ALIAS}:${PROXY_PORT}`
  const networkArgs =
    network === "open"
      ? // The server is reachable from the host's loopback only, on a port Docker picks.
        ["--publish", `127.0.0.1::${PORT}`]
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
    // the sandbox volume and /tmp. The Docker socket is never mounted.
    "--user",
    UID,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,exec,nosuid,nodev,size=${input.resources.tmp}`,
    "--tmpfs",
    `${RUNTIME_DIR}:rw,noexec,nosuid,nodev,size=1m,mode=0700,uid=${UID.split(":")[0]},gid=${UID.split(":")[1]}`,
    "--volume",
    `${volumeName(input.id)}:${ROOT}`,
    "--volume",
    `${policyVolumeName(input.id)}:${POLICY_DIR}:ro`,
    "--workdir",
    input.workdir,
    "--cpus",
    String(input.resources.cpus),
    "--memory",
    input.resources.memory,
    "--pids-limit",
    String(input.resources.pids),
    ...networkArgs,
    ...Object.entries({ ...input.env, ...proxyEnv, LUNOS_SANDBOX_RUNTIME: RUNTIME_FILE }).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
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
export async function seed(id: string, imageID: string, tar: string[], tarEnv?: Record<string, string>) {
  await SandboxExec.pipe(
    tar,
    [
      "docker",
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--user",
      "0:0",
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
      `mkdir -p ${WORKSPACE} ${HOME} && tar -x -o -f - -C ${WORKSPACE} && chown -R ${UID} ${ROOT}`,
    ],
    { from: { env: tarEnv } },
  )
}

/**
 * Fill the policy volume from a directory holding managed.json (when the organisation has managed
 * config) and the sandbox marker. Root-owned and world-readable, so the sandbox user can read it
 * and, even before the read-only mount, not change it.
 */
export async function seedPolicy(id: string, imageID: string, dir: string, tarEnv?: Record<string, string>) {
  await SandboxExec.pipe(
    ["tar", "-c", "-f", "-", "-C", dir, "."],
    [
      "docker",
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--user",
      "0:0",
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
}) {
  return [
    "create",
    "--name",
    egressName(input.id),
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
  return (await SandboxExec.run(["docker", "container", "inspect", egressName(id)])).code === 0
}

/** The egress proxy's decisions, one JSON line each, from its log. */
export async function egressLog(id: string) {
  const result = await SandboxExec.run(["docker", "logs", egressName(id)])
  return result.stdout
}

/**
 * Write the runtime file into the running container's tmpfs, as the sandbox user, through stdin: the
 * values never appear in an argv, an environment or a file on the host.
 */
export async function inject(id: string, runtime: string) {
  await docker(
    [
      "exec",
      "-i",
      "--user",
      UID,
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
  await SandboxExec.run(["docker", "rm", "--force", "--volumes", containerName(id)])
  await SandboxExec.run(["docker", "rm", "--force", egressName(id)])
  await SandboxExec.run(["docker", "network", "rm", networkName(id)])
  for (const name of [volumeName(id), policyVolumeName(id)]) {
    const volume = await SandboxExec.run(["docker", "volume", "rm", "--force", name])
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
  const result = await SandboxExec.run(["docker", "logs", "--tail", String(tail), containerName(id)])
  return (result.stdout + result.stderr).trim()
}

/** `docker logs`, straight to this process's stdout and stderr; `follow` streams until it stops. */
export async function streamLogs(id: string, options: { tail?: number; follow?: boolean } = {}) {
  const proc = Bun.spawn(
    [
      "docker",
      "logs",
      ...(options.tail !== undefined ? ["--tail", String(options.tail)] : []),
      ...(options.follow ? ["--follow"] : []),
      containerName(id),
    ],
    { stdout: "inherit", stderr: "inherit", stdin: "ignore" },
  )
  return proc.exited
}

/** Stream the workspace out of the container (running or stopped) and extract it into `into`. */
export async function copyOut(id: string, into: string) {
  await SandboxExec.pipe(
    ["docker", "cp", `${containerName(id)}:${WORKSPACE}`, "-"],
    ["tar", "-x", "-f", "-", "-C", into],
  )
}

export type Listed = { id: string; name: string; state: string; status: string; project?: string; created: string }

export async function list(): Promise<Listed[]> {
  const out = await docker(["ps", "--all", "--filter", `label=${LABEL}`, "--format", "{{json .}}"])
  return out
    .split("\n")
    .filter(Boolean)
    .map(
      (line) => JSON.parse(line) as { Names: string; State: string; Status: string; Labels: string; CreatedAt: string },
    )
    .map((row) => {
      const labels = Object.fromEntries(
        row.Labels.split(",").map((pair) => {
          const at = pair.indexOf("=")
          return [pair.slice(0, at), pair.slice(at + 1)]
        }),
      )
      return {
        id: labels[LABEL],
        name: row.Names,
        state: row.State,
        status: row.Status,
        project: labels[`${LABEL}.project`],
        created: row.CreatedAt,
      }
    })
    .filter((row) => row.id)
}

export async function exists(id: string) {
  return (await SandboxExec.run(["docker", "container", "inspect", containerName(id)])).code === 0
}

export * as SandboxDocker from "./docker"
