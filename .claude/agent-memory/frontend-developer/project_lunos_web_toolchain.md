---
name: project-lunos-web-toolchain
description: Node/npm/Angular CLI version gotchas discovered scaffolding Lunos.Web (Task 5) — relevant to any later task running npm/ng in this worktree.
metadata:
  type: project
---

Working with `Lunos.Web/` (Angular 22 workspace) in this repo requires Node ≥v22.22.3, not the v22.22.0 that may be pre-installed — `@angular/cli@22.1.8` hard-refuses to run below that patch. Use `nvm install 22.22.3 && nvm use 22.22.3` (or newer) before any `ng`/`npm` command here; `.nvmrc` at repo root is intentionally just `"22"` per the plan brief, so don't assume it alone guarantees a compatible patch on a given machine.

**Why:** verified directly — `ng new --help` printed the version-check refusal before any workaround was applied.

Separately, npm 10.9.x crashes with `Cannot read properties of null (reading 'edgesOut')` inside its arborist dependency resolver when installing this workspace's `package.json` (triggered by Vitest's optional browser-mode peer-dependency graph, e.g. `@vitest/browser-playwright`). Upgrading to npm 12.0.2 (`npm install -g npm@latest`) fixes it. After `ng new` generates `package.json`, double check its `"packageManager"` field — it captures whatever npm was active at generation time, which may be the broken 10.9.x version; correct it to match whatever npm actually produced `package-lock.json`, or corepack/CI consumers of that field will reproduce the crash.

**How to apply:** before running `npm install`/`ng generate`/`ng build`/`ng test` anywhere under `Lunos.Web/` in later tasks (6, 7, 8), confirm `node --version` is ≥22.22.3 and `npm --version` is not 10.9.x. If a fresh clone reproduces either failure, this memory explains why and the fix.

Also: Angular CLI 22.1.8's `ng new` supports `--prefix`, `--zoneless`, and `--test-runner` as first-class flags (not just interactive prompts) — but `--zoneless` only suppresses zone.js/polyfills, it does NOT insert `provideZonelessChangeDetection()` into `app.config.ts`; that provider must still be added by hand. `--prefix` does correctly set `angular.json`'s `"prefix"` and the root component's selector.
