// Published npm metadata for lunos-ai and its platform packages (XCOD-92). One place, so the
// entry package and the 12 platform packages can't drift apart. Without these fields the npm
// page for lunos-ai showed no description, homepage or repository: a supply-chain yellow flag
// for exactly the reviewers the deployment guide is written for, and easy to confuse with the
// unrelated lunos.ai.

export const REPOSITORY_URL = "https://github.com/AxsionDev/Lunos"

const shared = {
  homepage: "https://lunos.tech",
  repository: { type: "git", url: `git+${REPOSITORY_URL}.git` },
  bugs: { url: `${REPOSITORY_URL}/issues` },
  author: "ITService EOOD (Axsion)",
  license: "MIT",
}

export const DESCRIPTION = "Lunos — EU-sovereign, open-source AI coding agent for the terminal"

export function entryMeta() {
  return {
    description: DESCRIPTION,
    ...shared,
    keywords: ["ai", "coding-agent", "cli", "eu", "sovereign", "lunos"],
  }
}

export function platformMeta(platform: string) {
  return {
    description: `${DESCRIPTION} (${platform} binary; install lunos-ai instead)`,
    ...shared,
  }
}
