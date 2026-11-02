On npm 12, the "upgrade manually" hint Lunos prints gives a command that installs the `lunos-ai` package, but `lunos` then refuses to start with "lunos-ai's postinstall script was not run". npm 12 no longer runs install scripts by default, and `lunos-ai`'s postinstall is what fetches the binary.

Fix `manualInstallCommand` in `/app/install.ts` so the command it returns works on npm 12, and still works on npm 10.
