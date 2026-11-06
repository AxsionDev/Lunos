import fs from "fs/promises"
import path from "path"

/**
 * A `podman` that isn't there, in `dir` (put first on PATH next to a fake `docker`). Sandbox tests
 * keep /usr/bin on PATH for sh, git and tar, and GitHub's ubuntu runners ship a working
 * /usr/bin/podman: without this, a "Docker is stopped" case quietly runs on the real Podman.
 */
export async function noPodman(dir: string) {
  const file = path.join(dir, "podman")
  await fs.writeFile(file, `#!/bin/sh\necho "sh: podman: not found" >&2\nexit 127\n`)
  await fs.chmod(file, 0o755)
}
