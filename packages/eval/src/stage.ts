// XCOD-200: registry datasets are exported to a local copy before a run, and that copy is what
// Harbor builds. Two fixes need a copy we own:
//
// - Every file in an exported Harbor task is dated 1970, and most Aider Polyglot oracle payloads
//   are the same size (206 of 225 are 10,272 bytes). BuildKit skips re-sending a context file whose
//   path, size and mtime match one it already has, so images got another task's solution:
//   go_bowling applied bank_account.cpp. `--no-cache` doesn't help; this is the context transfer,
//   not the layer cache. Giving each task its own mtime makes BuildKit send the real file.
// - The Java tasks hard-code JAVA_HOME to the amd64 JDK, which doesn't exist in an arm64 image.

import fs from "fs/promises"
import path from "path"
import { $ } from "bun"
import type { EvalConfig } from "./config"

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  )

/** Only a patched Dockerfile contains this. */
const JDK_LINK = "-openjdk-$(dpkg --print-architecture)"

/** Point JAVA_HOME at an arch-neutral symlink instead of the amd64 JDK directory. */
export function patchDockerfile(text: string) {
  return text.replace(
    /^ENV JAVA_HOME=\/usr\/lib\/jvm\/java-(\d+)-openjdk-amd64$/m,
    (_, version) =>
      `RUN ln -sfn /usr/lib/jvm/java-${version}${JDK_LINK} /usr/lib/jvm/java-${version}\n` +
      `ENV JAVA_HOME=/usr/lib/jvm/java-${version}`,
  )
}

/** Set every file and directory under `dir` to `time`. */
export async function restamp(dir: string, time: Date) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) await restamp(file, time)
    await fs.utimes(file, time, time)
  }
  await fs.utimes(dir, time, time)
}

/**
 * Restamp and patch each exported task's environment. Tasks get times one second apart: the same
 * time for all of them would leave same-size files across tasks matching again.
 */
export async function prepare(root: string, now = Date.now()) {
  const patched: string[] = []
  const tasks = (await Array.fromAsync(new Bun.Glob("**/task.toml").scan(root)))
    .map((file) => path.join(root, path.dirname(file)))
    .sort()
  for (const [index, task] of tasks.entries()) {
    const environment = path.join(task, "environment")
    const dockerfile = path.join(environment, "Dockerfile")
    if (await Bun.file(dockerfile).exists()) {
      const text = await Bun.file(dockerfile).text()
      const fixed = patchDockerfile(text)
      if (fixed !== text) await Bun.write(dockerfile, fixed)
      // Checked on the result, so a copy patched by an earlier run is still disclosed.
      if (fixed.includes(JDK_LINK)) patched.push(path.basename(task))
    }
    if (await exists(environment)) await restamp(environment, new Date(now - index * 1000))
  }
  return { tasks, patched }
}

/**
 * Export each registry dataset under `dir`. Returns the datasets pointing at the local copies and
 * the tasks whose Dockerfile was patched, which the report must disclose.
 */
export async function stage(config: EvalConfig, dir: string) {
  const datasets: EvalConfig["datasets"] = []
  const patched: string[] = []
  for (const dataset of config.datasets) {
    if (dataset.harbor.startsWith(".") || dataset.harbor.startsWith("/")) {
      datasets.push(dataset)
      continue
    }
    const out = path.join(dir, dataset.name)
    if (!(await exists(out))) {
      console.log(`exporting ${dataset.harbor} to ${out}`)
      await $`uvx --from harbor harbor download ${dataset.harbor} --export -o ${out}`
    }
    // Export mode nests the tasks as <out>/<dataset>/<task>; Harbor wants the directory holding them.
    const prepared = await prepare(out)
    const tasks = prepared.tasks
    // Only the tasks this run uses; the export holds the whole dataset.
    const names = dataset.tasks?.map((task) => task.split("/").pop()!)
    patched.push(...prepared.patched.filter((task) => !names || names.includes(task)))
    const roots = [...new Set(tasks.map((task) => path.dirname(task)))]
    if (roots.length !== 1) throw new Error(`eval: expected one task directory under ${out}, found ${roots.length}`)
    console.log(`${dataset.harbor}: ${tasks.length} tasks restamped`)
    // A local dataset names tasks by directory, without the registry's org prefix.
    datasets.push({ ...dataset, harbor: roots[0], tasks: names })
  }
  return { datasets, patched }
}
