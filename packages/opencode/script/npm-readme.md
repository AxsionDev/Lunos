# Lunos

**EU-sovereign, open-source AI coding agent for the terminal.**

```sh
npm i -g lunos-ai --allow-scripts=lunos-ai
lunos
```

- Website: <https://lunos.tech>
- Source and issues: <https://github.com/AxsionDev/Lunos>
- Self-hosted deployment guide, covering data flows and EU data-residency controls:
  <https://github.com/AxsionDev/Lunos/blob/dev/docs/deployment/self-hosted.md>

Lunos is a fork of [opencode](https://github.com/sst/opencode). It adds EU data-residency
controls and self-hosted deployment, and it tracks upstream releases. `lunos debug info` shows
which upstream release your build is based on.

Published by ITService EOOD (Axsion), Sofia, Bulgaria. MIT licensed.

This package installs the `lunos` command. The binary itself comes from one of the
platform-specific `lunos-<os>-<arch>` packages, which npm selects automatically.
