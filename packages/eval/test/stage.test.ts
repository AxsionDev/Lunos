import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { patchDockerfile, prepare } from "../src/stage"

const java = [
  "RUN apt-get update && apt-get install -y openjdk-21-jdk",
  "ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64",
  "ENV PATH=$JAVA_HOME/bin:$PATH",
].join("\n")

describe("stage", () => {
  test("JAVA_HOME points at an arch-neutral symlink", () => {
    const patched = patchDockerfile(java)
    expect(patched).toContain(
      "RUN ln -sfn /usr/lib/jvm/java-21-openjdk-$(dpkg --print-architecture) /usr/lib/jvm/java-21",
    )
    expect(patched).toContain("ENV JAVA_HOME=/usr/lib/jvm/java-21\n")
    expect(patched).not.toContain("amd64")
  })

  test("a Dockerfile without the amd64 JDK is left alone", () => {
    expect(patchDockerfile("FROM buildpack-deps:jammy\n")).toBe("FROM buildpack-deps:jammy\n")
  })

  test("each task's same-size files get their own mtime, and Java Dockerfiles are patched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "eval-stage-"))
    for (const task of ["polyglot_go_a", "polyglot_java_b"]) {
      const env = path.join(root, "aider-polyglot", task, "environment")
      await fs.mkdir(path.join(env, "workspace", ".oracle"), { recursive: true })
      await Bun.write(path.join(root, "aider-polyglot", task, "task.toml"), "")
      await Bun.write(path.join(env, "workspace", ".oracle", "solution.enc"), task.padEnd(64))
      await Bun.write(path.join(env, "Dockerfile"), task.includes("java") ? java : "FROM x\n")
      const epoch = new Date(0)
      await fs.utimes(path.join(env, "workspace", ".oracle", "solution.enc"), epoch, epoch)
    }

    const { tasks, patched } = await prepare(root, Date.parse("2026-10-03T09:00:00Z"))

    expect(tasks.map((task) => path.basename(task))).toEqual(["polyglot_go_a", "polyglot_java_b"])
    const mtimes = await Promise.all(
      tasks.map(async (task) => (await fs.stat(path.join(task, "environment/workspace/.oracle/solution.enc"))).mtimeMs),
    )
    expect(mtimes[0]).not.toBe(0)
    expect(mtimes[0]).not.toBe(mtimes[1])
    expect(await Bun.file(path.join(tasks[1], "environment/Dockerfile")).text()).toContain(
      "ENV JAVA_HOME=/usr/lib/jvm/java-21\n",
    )
    expect(patched).toEqual(["polyglot_java_b"])
    // A second run finds the Dockerfile already patched and still reports it.
    expect((await prepare(root)).patched).toEqual(["polyglot_java_b"])
    await fs.rm(root, { recursive: true })
  })
})
