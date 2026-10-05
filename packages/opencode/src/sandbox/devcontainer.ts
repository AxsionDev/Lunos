import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { SandboxExec } from "./exec"
import { SandboxDocker } from "./docker"

// XCOD-158: a project's .devcontainer/devcontainer.json as the sandbox's toolchain. Its image (or,
// when you allow it, its Dockerfile) becomes the base, and Lunos is added on top from the trusted
// Lunos image, so the sandbox has the project's compilers and SDKs and still runs Lunos.
//
// Lunos is the musl build. Devcontainer images are usually glibc (Debian, Ubuntu), so the binary
// brings musl's loader, at its own path (/lib/ld-musl-<arch>.so.1, unused on a glibc system), and
// its libraries in /opt/lunos/lib, which musl finds through /etc/ld-musl-<arch>.path. glibc programs
// never read either, so the image's own toolchain is unchanged. No LD_LIBRARY_PATH: every tool the
// agent runs would inherit it.
//
// Adding Lunos runs nothing of the base image: the Dockerfile is FROM, COPY, ENV and ENTRYPOINT,
// and the files come out of the trusted image with `create` + `cp`, which runs nothing either.

export const IMAGE_REPOSITORY = "lunos-sandbox-devcontainer"
export const LABEL = `${SandboxDocker.LABEL}.devcontainer`
export const OPT = "/opt/lunos"

/** What a devcontainer.json says, as far as a sandbox uses it. */
export type Spec = {
  /** The devcontainer.json, relative to the repository root. */
  file: string
  image?: string
  build?: { dockerfile: string; context: string; args: Record<string, string>; target?: string }
  /** Set when it can't be used at all, and why. */
  unsupported?: string
  /** Keys a sandbox doesn't apply. */
  ignored: string[]
}

/** Keys of devcontainer.json a sandbox doesn't apply: they configure an editor's container. */
const IGNORED = [
  "features",
  "initializeCommand",
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
  "postAttachCommand",
  "remoteUser",
  "containerUser",
  "containerEnv",
  "remoteEnv",
  "runArgs",
  "mounts",
  "workspaceMount",
  "workspaceFolder",
  "forwardPorts",
  "privileged",
  "capAdd",
  "securityOpt",
  "init",
]

/**
 * The devcontainer.json for a repository: `.devcontainer/devcontainer.json`, `.devcontainer.json`,
 * or the only `.devcontainer/<name>/devcontainer.json`. Undefined when there's none; an error when
 * there are several named ones, since which one is meant isn't known.
 */
export function find(root: string): string | undefined {
  for (const candidate of [path.join(".devcontainer", "devcontainer.json"), ".devcontainer.json"])
    if (existsSync(path.join(root, candidate))) return candidate
  const dir = path.join(root, ".devcontainer")
  if (!existsSync(dir)) return undefined
  const named = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, "devcontainer.json")))
    .map((entry) => path.join(".devcontainer", entry.name, "devcontainer.json"))
  if (named.length > 1)
    throw new Error(
      `${named.length} devcontainer configurations (${named.join(", ")}), and a sandbox doesn't know which to use. ` +
        `Set sandbox.image, or sandbox.devcontainer "off".`,
    )
  return named[0]
}

const inside = (root: string, item: string) => item === root || item.startsWith(root + path.sep)

/** Read a devcontainer.json (JSONC). Paths in `build` are resolved and must stay in the repository. */
export function read(root: string, file: string): Spec {
  const absolute = path.join(root, file)
  const doc = parse(readFileSync(absolute, "utf8"), [], { allowTrailingComma: true }) as Record<string, unknown>
  const ignored = IGNORED.filter((key) => doc?.[key] !== undefined)
  if (!doc || typeof doc !== "object") return { file, unsupported: "it isn't a JSON object", ignored }
  if (doc.dockerComposeFile)
    return { file, unsupported: "it uses Docker Compose (dockerComposeFile), which a sandbox doesn't run", ignored }
  if (typeof doc.image === "string") return { file, image: doc.image, ignored }
  const build = doc.build as Record<string, unknown> | undefined
  const dockerfile = (build?.dockerfile ?? build?.dockerFile ?? doc.dockerFile) as string | undefined
  if (!dockerfile) return { file, unsupported: "it has neither an image nor a Dockerfile", ignored }
  const base = path.dirname(absolute)
  const realRoot = realpathSync(root)
  const resolved = (item: string, what: string) => {
    const full = path.resolve(base, item)
    const real = existsSync(full) ? realpathSync(full) : full
    if (!inside(realRoot, real)) throw new Error(`${file}: the build ${what} ${item} is outside the repository`)
    return full
  }
  const args = Object.fromEntries(
    Object.entries((build?.args as Record<string, unknown>) ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
  return {
    file,
    build: {
      dockerfile: resolved(dockerfile, "Dockerfile"),
      context: resolved(typeof build?.context === "string" ? build.context : ".", "context"),
      args,
      ...(typeof build?.target === "string" ? { target: build.target } : {}),
    },
    ignored,
  }
}

/** The musl architecture name for an image's architecture. */
export function muslArch(architecture: string) {
  if (architecture === "amd64") return "x86_64"
  if (architecture === "arm64") return "aarch64"
  throw new Error(`a devcontainer image for ${architecture} isn't supported; amd64 and arm64 are`)
}

/**
 * The Dockerfile that adds Lunos to a base image. Nothing in it runs: FROM, COPY, ENV, ENTRYPOINT.
 * The base's own PATH comes first, so its tools win; Lunos's bin (the binary and rg) comes last.
 */
export function dockerfile(base: string, arch: string) {
  return [
    `FROM ${base}`,
    `COPY ld-musl-${arch}.so.1 /lib/ld-musl-${arch}.so.1`,
    `COPY ld-musl-${arch}.path /etc/ld-musl-${arch}.path`,
    `COPY opt/ ${OPT}/`,
    "ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
    // ${PATH} is the base image's own (Docker expands it at build time; nothing runs), so its tools,
    // e.g. /usr/local/go/bin, stay where the image put them, ahead of Lunos's.
    `ENV PATH=\${PATH}:${OPT}/bin`,
    `ENTRYPOINT ["${OPT}/bin/lunos"]`,
    "",
  ].join("\n")
}

const docker = (args: string[], options?: SandboxExec.Options) =>
  SandboxExec.check([SandboxDocker.bin(), ...args], options)
const run = (args: string[]) => SandboxExec.run([SandboxDocker.bin(), ...args])

async function architecture(ref: string) {
  return (await docker(["image", "inspect", ref, "--format", "{{.Architecture}}"])).trim()
}

/** The platform a sandbox runs on: the trusted Lunos image's. */
export async function platformOf(image: SandboxDocker.Image) {
  return `linux/${await architecture(image.id)}`
}

/** Copy files out of an image without running it: create a container, `cp`, remove it. */
async function copyOut(image: string, files: [from: string, to: string][]) {
  const id = (await docker(["create", image])).trim()
  // Docker copies a symlink as a link unless told -L; Podman has no -L and follows it already. If a
  // link still comes out (it would dangle here), copy what it points to instead.
  const follow = SandboxDocker.current()?.engine === "podman" ? [] : ["-L"]
  try {
    for (const [from, to] of files) {
      let source = from
      for (let hops = 0; ; hops++) {
        await fs.rm(to, { force: true })
        await docker(["cp", ...follow, `${id}:${source}`, to])
        const stat = await fs.lstat(to)
        if (!stat.isSymbolicLink()) break
        if (hops === 5) throw new Error(`${from} in ${image} is a chain of symlinks`)
        source = path.posix.resolve(path.posix.dirname(source), await fs.readlink(to))
      }
    }
  } finally {
    await run(["rm", "-f", id])
  }
}

/** Whether an image is musl-based (Alpine): Lunos's loader would then change the image's own libc. */
async function isMusl(image: string, arch: string) {
  const id = (await docker(["create", image])).trim()
  const into = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-devcontainer-libc-"))
  try {
    return (await run(["cp", `${id}:/lib/ld-musl-${arch}.so.1`, into])).code === 0
  } finally {
    await run(["rm", "-f", id])
    await fs.rm(into, { recursive: true, force: true })
  }
}

/**
 * Pull a base image for the trusted image's platform. An image without that platform would only
 * fail later, with "exec format error".
 */
export async function pull(ref: string, platform: string) {
  const present = await run(["image", "inspect", ref, "--format", "{{.Architecture}}"])
  if (present.code !== 0 || `linux/${present.stdout.trim()}` !== platform) {
    const pulled = await run(["pull", "--platform", platform, ref])
    if (pulled.code !== 0)
      throw new Error(`Couldn't get the devcontainer image ${ref} for ${platform}: ${pulled.stderr.trim()}`)
  }
  const arch = await architecture(ref)
  if (`linux/${arch}` !== platform)
    throw new Error(`The devcontainer image ${ref} is for linux/${arch}, and this machine's sandbox needs ${platform}`)
  return SandboxDocker.image(ref)
}

/**
 * Build a devcontainer's Dockerfile on this machine: the repository's own build steps, with the
 * network open. Only called when your global or managed config allows it (sandbox.devcontainer
 * "build").
 */
export async function buildBase(spec: NonNullable<Spec["build"]>, platform: string, log: (line: string) => void) {
  const hash = createHash("sha256")
    .update(JSON.stringify(spec))
    .update(await fs.readFile(spec.dockerfile))
    .digest("hex")
    .slice(0, 16)
  const tag = `${IMAGE_REPOSITORY}-base:${hash}`
  log(`building the devcontainer's Dockerfile ${spec.dockerfile} (sandbox.devcontainer "build")`)
  await docker([
    "build",
    "--platform",
    platform,
    "--label",
    `${LABEL}=base`,
    "-t",
    tag,
    "-f",
    spec.dockerfile,
    ...Object.entries(spec.args).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
    ...(spec.target ? ["--target", spec.target] : []),
    spec.context,
  ])
  return SandboxDocker.image(tag)
}

/**
 * The sandbox image for a devcontainer base: the base plus Lunos from the trusted image. Reused
 * when it already exists (tagged by both images' IDs). Checked by running it as the sandbox runs:
 * no network, no capabilities, read-only, as the sandbox user.
 */
export async function prepare(base: SandboxDocker.Image, trusted: SandboxDocker.Image): Promise<SandboxDocker.Image> {
  const arch = muslArch(await architecture(trusted.id))
  // Keyed by both images and by the Dockerfile itself, so a change to how Lunos is added rebuilds it.
  const recipe = dockerfile(base.digest ?? base.ref, arch)
  const key = createHash("sha256").update(base.id).update(trusted.id).update(recipe).digest("hex").slice(0, 16)
  const tag = `${IMAGE_REPOSITORY}:${key}`
  const existing = await run(["image", "inspect", tag, "--format", "{{.Id}}"])
  if (existing.code !== 0) {
    if (await isMusl(base.id, arch))
      throw new Error(
        `The devcontainer image ${base.ref} is musl-based (Alpine, say). Lunos's musl runtime would change its own ` +
          `libc there, so it isn't supported as a sandbox base yet. Set sandbox.image, or sandbox.devcontainer "off".`,
      )
    const context = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-devcontainer-"))
    try {
      await fs.mkdir(path.join(context, "opt", "lib"), { recursive: true })
      await fs.mkdir(path.join(context, "opt", "bin"), { recursive: true })
      const lib = path.join(context, "opt", "lib")
      await copyOut(trusted.id, [
        ["/usr/local/bin/lunos", path.join(context, "opt", "bin", "lunos")],
        ["/usr/bin/rg", path.join(context, "opt", "bin", "rg")],
        [`/lib/ld-musl-${arch}.so.1`, path.join(context, `ld-musl-${arch}.so.1`)],
        ["/usr/lib/libstdc++.so.6", path.join(lib, "libstdc++.so.6")],
        ["/usr/lib/libgcc_s.so.1", path.join(lib, "libgcc_s.so.1")],
        ["/usr/lib/libpcre2-8.so.0", path.join(lib, "libpcre2-8.so.0")],
      ])
      // musl's libc and its loader are one file; binaries ask for it by the libc name.
      await fs.copyFile(path.join(context, `ld-musl-${arch}.so.1`), path.join(lib, `libc.musl-${arch}.so.1`))
      await fs.writeFile(path.join(context, `ld-musl-${arch}.path`), `${OPT}/lib\n`)
      await fs.writeFile(path.join(context, "Dockerfile"), recipe)
      await docker([
        "build",
        "--platform",
        `linux/${await architecture(trusted.id)}`,
        "--label",
        `${LABEL}=sandbox`,
        "--label",
        `${LABEL}.base=${base.digest ?? base.ref}`,
        "-t",
        tag,
        context,
      ])
    } finally {
      await fs.rm(context, { recursive: true, force: true })
    }
  }
  const lockdown = [
    "run",
    "--rm",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--user",
    SandboxDocker.UID,
    "--tmpfs",
    "/tmp",
    "--env",
    "HOME=/tmp",
  ]
  const version = await run([...lockdown, tag, "--version"])
  if (version.code !== 0)
    throw new Error(
      `Lunos doesn't start in the devcontainer image ${base.ref}: ${version.stderr.trim() || version.stdout.trim()}`,
    )
  const tools = await run([...lockdown, "--entrypoint", "/bin/sh", tag, "-c", "command -v cat && command -v mv"])
  if (tools.code !== 0)
    throw new Error(`The devcontainer image ${base.ref} needs /bin/sh, cat and mv, which the sandbox uses to start`)
  return SandboxDocker.image(tag)
}

export * as SandboxDevcontainer from "./devcontainer"
