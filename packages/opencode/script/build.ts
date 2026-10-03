#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

// XCOD-177: licence notices for what ships, built into the binary (`lunos licenses`) and copied into
// every npm package. The build stops on a shipped licence the gate doesn't allow.
const shippedPackages = shipped()
const licenceProblems = problems(shippedPackages)
if (licenceProblems.length) throw new Error(`build: licences not allowed:\n${licenceProblems.join("\n")}`)
const notices = render(shippedPackages, [bunNotice()])
await Bun.write("./THIRD_PARTY_NOTICES", notices)

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"
import { platformMeta } from "./package-meta"
import { bunNotice, problems, render, shipped } from "./notices"

// Published brand identity, mirroring script/publish.ts. Deliberately NOT derived from this
// package's `name`, which stays "opencode" to avoid a duplicate workspace name (XCOD-4).
const brand = "lunos"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

// XCOD-144: `--target=linux-arm64-musl` builds just that one binary (the dist folder name without
// "lunos-"), e.g. to build the sandbox image locally from a Mac with script/sandbox-image.ts.
const targetFlag = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
const targetName = (item: (typeof allTargets)[number]) =>
  [item.os === "win32" ? "windows" : item.os, item.arch, item.avx2 === false ? "baseline" : undefined, item.abi]
    .filter(Boolean)
    .join("-")

const targets = targetFlag
  ? allTargets.filter((item) => targetName(item) === targetFlag)
  : singleFlag
    ? allTargets.filter((item) => {
        if (item.os !== process.platform || item.arch !== process.arch) {
          return false
        }

        // When building for the current platform, prefer a single native binary by default.
        // Baseline binaries require additional Bun artifacts and can be flaky to download.
        if (item.avx2 === false) {
          return baselineFlag
        }

        // also skip abi-specific builds for the same reason
        if (item.abi !== undefined) {
          return false
        }

        return true
      })
    : allTargets
if (targetFlag && targets.length === 0) throw new Error(`unknown --target ${targetFlag}`)

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  // Must be `brand`, NOT pkg.name. pkg.name is "opencode", and `opencode-darwin-arm64`
  // et al. are real packages on npm owned by upstream's maintainer — publishing under
  // those names fails with 403 before the main package is ever reached.
  const name = [
    brand,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const workerPath = "./src/cli/tui/worker.ts"
  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    // XCOD-159: off, because with it Bun 1.3.14 (package.json's pin, which the release builds with)
    // emits a chunk of core/src/schema.ts twice under one name and fails: "Multiple files share the
    // same output path". Hash-unique chunk names don't avoid it, and neither do static imports of the
    // sandbox. Costs 79 MB per binary, 8 MB per download (Linux x64 musl: 188 -> 267 MB; .tar.gz 64 -> 72 MB).
    splitting: false,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(brand, "bun") as any,
      outfile: `dist/${name}/bin/opencode`,
      execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
    },
    entrypoints: [
      "./src/index.ts",
      workerPath,
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
    ],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      LUNOS_THIRD_PARTY_NOTICES: JSON.stringify(notices),
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      LUNOS_UPSTREAM_VERSION: JSON.stringify(pkg.lunos?.upstreamVersion ?? ""),
      // Written by script/upstream-sync.ts on each upstream merge (XCOD-118); absent until the first one.
      LUNOS_UPSTREAM_SYNC: JSON.stringify("upstreamSync" in pkg.lunos ? pkg.lunos.upstreamSync : null),
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/opencode`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        ...platformMeta(`${item.os}-${item.arch}${item.abi ? `-${item.abi}` : ""}`),
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  await Bun.write(`dist/${name}/THIRD_PARTY_NOTICES`, notices)
  await Bun.write(`dist/${name}/LICENSE`, await Bun.file("../../LICENSE").text())
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    // `key` already carries the brand (see the name construction above), so it doubles as the
    // release asset name the `install` script asks for — "${APP}-${target}" with APP=lunos.
    // This previously needed a rename because the npm package name was still "opencode-*".
    // XCOD-177: the licence notices go in the archive next to the binary (install only moves the binary).
    await $`cp ../LICENSE ../THIRD_PARTY_NOTICES .`.cwd(`dist/${key}/bin`)
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  // XCOD-121: the model catalogue this build embeds, and the offline install instructions. Uploaded
  // before release-checksums.ts runs, so SHA256SUMS and its signature cover them and they can go
  // into the offline bundles (offline-bundles.ts) verifiably.
  await Bun.write("./dist/lunos-models-snapshot.json", generated.modelsData)
  const install = await Bun.file("./script/offline/INSTALL-OFFLINE.md").text()
  await Bun.write("./dist/INSTALL-OFFLINE.md", install.replaceAll("__VERSION__", Script.version))
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz ./dist/lunos-models-snapshot.json ./dist/INSTALL-OFFLINE.md --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
