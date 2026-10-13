# Long-term support releases and offline updates

For organisations that can't take a new Lunos release every few weeks: a release line that only
receives security fixes, for longer than the standard support period, and a way to update machines
that have no internet access.

**Status: Planned.** No LTS release exists yet, and the support period below is a proposal waiting
for ITService EOOD's decision. What exists today: the standard support period (each release gets
security fixes for 6 months from its release date, from v1.18.43; see
[CRA readiness](trust/cra-readiness.md#security-support-period)), offline bundles for every release,
the release mirror script, and `lunos update` from a private npm registry. Each is marked below.

## The LTS release line (Planned)

|                  | Standard releases                                          | LTS line (proposed)                                                                  |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Where            | `dev`, released as `X.Y.Z`                                 | A branch `lts/X.Y`, cut from a release                                               |
| What changes     | Features, fixes, upstream syncs                            | Security fixes, and fixes for regressions that lose data or block work. Nothing else |
| Security support | 6 months from each release's date                          | **Recommended: 24 months** from the line's first release (decision pending)          |
| npm dist-tag     | `latest`                                                   | `lts-X.Y`                                                                            |
| `lunos update`   | Moves to the newest release                                | Stays on the line: an LTS build checks its own dist-tag                              |
| GitHub release   | Marked "latest"                                            | Never marked "latest", so the installer's `releases/latest` never picks it           |
| Verifiable       | SBOM, signed `SHA256SUMS`, npm provenance, offline bundles | The same pipeline, so the same files                                                 |

**How a line starts.** When a minor version is chosen as LTS (for example `1.19`), the branch
`lts/1.19` is cut at its first release and `dev` moves on to `1.20`. One LTS line at a time is the
proposal; a new one starts when the previous one has at most 6 months left, so there is always an
overlap to migrate in.

**Backports.**

1. A security fix lands on `dev` first, through a pull request, as today.
2. The pull request gets the label `backport:lts-X.Y` (by the person who triages the advisory).
3. The fix is cherry-picked onto `lts/X.Y` with `git cherry-pick -x` (the original commit is named
   in the message), as a pull request against that branch, with the same review and CI.
4. An LTS release is published from the branch. Its GitHub Security Advisory names the affected
   LTS versions and the LTS release that fixes them, as [`SECURITY.md`](../SECURITY.md) does for
   standard releases. `CHANGELOG.md` on the branch lists only the backports.

When a fix can't be backported safely (it depends on a feature the line doesn't have), the advisory
says so and names the mitigation.

**What the release pipeline needs before the first LTS release** (not done yet):

- `packages/script` treats every channel other than `latest` as a preview (a `0.0.0-<channel>-…`
  version, and the release steps skipped). LTS channels (`lts-*`) must be real releases: the version
  from the branch, the npm dist-tag `lts-X.Y`, a GitHub release that isn't marked latest.
- The build bakes the channel into the binary (`OPENCODE_CHANNEL`), which is what keeps
  `lunos update` and the update notice on the line: an LTS build reads
  `<registry>/lunos-ai/lts-X.Y`, not `latest`.
- `publish.yml` runs from `lts/*` branches too, with the same signing, SBOM and offline bundles.

## Offline update mirror

Two ways to update machines in a network without internet access. Both are available now.

### A private npm registry (available)

`lunos update` (and the update notice) read Lunos's package from the npm registry **in npm's own
configuration**: the `registry` in the project's or the user's `.npmrc`, the global one, or
`npm_config_registry`. Point it at your mirror (Nexus, Artifactory, Verdaccio) and nothing else is
needed:

```ini
# ~/.npmrc, or /etc/npmrc for every user
registry=https://npm.mirror.example.eu/repository/npm/
```

The mirror proxies or imports the `lunos-ai` package and its platform packages (`lunos-ai-linux-x64`
and the others). Whether `npm audit signatures` can check their provenance inside the network
depends on your mirror serving npm's registry signatures; check it once. With an LTS line, mirror
its dist-tag as well.

With `LUNOS_OFFLINE=1`, Lunos doesn't check for updates on its own; run `lunos update` without it
to update from the mirror.

### A mirror of release files (available)

For machines installed from the release archives or offline bundles (no npm), copy the releases you
want into a directory your web server or file share serves, on a machine that has internet access:

```bash
bun packages/opencode/script/release-mirror.ts --out /srv/lunos-mirror \
  --pattern 'lunos-offline-*' --verify-signature v1.18.46
```

- Every file is checked against the release's `SHA256SUMS` before it is kept; with
  `--verify-signature` (cosign on PATH), `SHA256SUMS`'s Sigstore signature is checked first,
  against this repository's publish workflow.
- `--pattern` (repeatable) chooses files; `SHA256SUMS` and its signature always come along.
- Running it again downloads only what is missing, and `index.json` lists what is mirrored (tags,
  files, sizes, SHA-256).
- Inside the network, install from the mirror with the offline bundle's own instructions
  (`INSTALL-OFFLINE.md`: verify, then install), which work without any network.

## What this does and doesn't change

- No release is supported for longer than its stated period. A release older than its period gets
  no fixes, whether or not it is LTS.
- An LTS line is the same software as the release it was cut from, plus its backports. It doesn't
  have later features.
- Nothing here sends anything to Lunos: the registry and the mirror are yours.
