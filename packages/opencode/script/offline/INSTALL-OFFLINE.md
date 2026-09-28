# Installing Lunos **VERSION** without internet access

An offline bundle (`lunos-offline-<os>-<arch>.tar.gz`) has everything needed to install Lunos
**VERSION** on a machine with no internet access (XCOD-121):

| File                                            | What it is                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `lunos-<os>-<arch>.tar.gz` or `.zip`            | The `lunos` binary for that platform                                         |
| `lunos-models-snapshot.json`                    | The model catalogue built into this release, for `OPENCODE_MODELS_PATH`      |
| `lunos-sbom-__VERSION__.cdx.json`               | The software bill of materials (CycloneDX)                                   |
| `SHA256SUMS`, `SHA256SUMS.sigstore.json`        | Checksums of every release file, and their Sigstore signature                |
| `lunos-sbom-__VERSION__.cdx.json.sigstore.json` | The SBOM's Sigstore signature                                                |
| `trusted_root.json`                             | Sigstore's public trust root, for verifying the signatures without a network |
| `tools/rg`, `tools/cosign` (`.exe` on Windows)  | ripgrep, which Lunos's search tools need, and cosign, for step 2             |
| `TOOLS.txt`                                     | Where each tool came from, its version and its pinned checksum               |
| `INSTALL-OFFLINE.md`                            | This file                                                                    |

## 1. Verify before you transfer it (recommended)

A trust root shipped inside the bundle can't vouch for the bundle. So check the bundle itself on a
machine with internet access, before moving it into the restricted network:

```bash
# with the GitHub CLI
gh release download v__VERSION__ --repo AxsionDev/Lunos --pattern 'SHA256SUMS-offline*'
cosign verify-blob --bundle SHA256SUMS-offline.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/AxsionDev/Lunos/\.github/workflows/publish\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS-offline
grep -F 'lunos-offline-linux-x64.tar.gz' SHA256SUMS-offline | sha256sum -c -   # your bundle's name
# macOS: shasum -a 256 -c -    Windows: Get-FileHash, compared with the line in SHA256SUMS-offline
```

## 2. Verify again on the offline machine (optional)

The bundle includes cosign. Unpack the bundle and run, inside it:

```bash
tools/cosign verify-blob --bundle SHA256SUMS.sigstore.json --trusted-root trusted_root.json \
  --certificate-identity-regexp '^https://github\.com/AxsionDev/Lunos/\.github/workflows/publish\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
grep -F 'lunos-linux-x64.tar.gz' SHA256SUMS | sha256sum -c -        # your archive's name
grep -F 'lunos-models-snapshot.json' SHA256SUMS | sha256sum -c -
grep -F 'INSTALL-OFFLINE.md' SHA256SUMS | sha256sum -c -
```

Each check prints `OK` or `Verified OK`. Stop if one doesn't. On Windows, run `tools\cosign.exe`
and compare `Get-FileHash` output with the lines in `SHA256SUMS`.

The tools aren't listed in `SHA256SUMS`: they're third-party builds, checked against pinned
checksums (see `TOOLS.txt`) when the bundle was made, and covered by the step 1 check of the whole
bundle.

## 3. Install

The binary in each archive is named `opencode` (its internal build name). Install it as `lunos`,
as the online installer does.

**Linux:**

```bash
sudo mkdir -p /opt/lunos && sudo tar -xzf lunos-linux-x64.tar.gz -C /opt/lunos
sudo install -m 755 /opt/lunos/opencode /usr/local/bin/lunos
sudo install -m 755 tools/rg /usr/local/bin/rg
```

**macOS:**

```bash
sudo mkdir -p /opt/lunos && sudo unzip -o lunos-darwin-arm64.zip -d /opt/lunos
sudo install -m 755 /opt/lunos/opencode /usr/local/bin/lunos
sudo install -m 755 tools/rg /usr/local/bin/rg
```

The binary isn't code-signed yet, so macOS Gatekeeper may block it. Allow it in
System Settings → Privacy & Security.

**Windows (PowerShell):**

```powershell
Expand-Archive lunos-windows-x64.zip -DestinationPath C:\Lunos
Rename-Item C:\Lunos\opencode.exe lunos.exe
Copy-Item tools\rg.exe C:\Lunos\
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\Lunos", "Machine")
```

Then check it runs: `lunos --version` should print `__VERSION__`.

## 4. Run offline

Set `LUNOS_OFFLINE=1` for everyone who uses Lunos on this machine. For example, put it in
`/etc/environment` or the user's shell profile. Lunos then makes no outbound calls of its own: no
update checks, no model-catalogue refresh, no downloads of LSP servers, formatters or ripgrep, and
no web tools. It talks only to the endpoints you configure, such as your self-hosted model.

- **ripgrep:** Lunos's search tools need `rg` on the `PATH`; step 3 installs the bundled one.
  Lunos can't download it offline. The `linux-arm64-musl` bundle has none (there's no ripgrep
  build for it): install it from your OS packages, for example `apk add ripgrep`.
- **The model catalogue** is built into the binary. To pin it explicitly:
  `export OPENCODE_MODELS_PATH=/opt/lunos/lunos-models-snapshot.json`
- **Your model:** point Lunos at your self-hosted endpoint in `opencode.json`. See "Air-gapped
  deployment" in the self-hosted deployment guide:
  https://github.com/AxsionDev/Lunos/blob/v__VERSION__/docs/deployment/self-hosted.md
