# XCOD-158: verify sandboxed runs on Windows, with Docker Desktop and its WSL2 backend.
# GitHub's hosted Windows runners can't run Linux containers, so this is run by hand.
#
# From the repository root, in PowerShell, with Docker Desktop running (Linux containers):
#
#   powershell -ExecutionPolicy Bypass -File packages/opencode/script/sandbox-e2e.ps1
#
# It builds the sandbox image, then runs script/sandbox-e2e.ts, which drives `lunos run --sandbox`
# against a scripted model on this machine: no API key, and nothing leaves the machine except the
# image build's package downloads. Send the whole output back; it ends with "all checks passed" or
# the number of failed checks.

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "== Environment"
Write-Host ("Windows " + [System.Environment]::OSVersion.Version)
bun --version
docker version --format "Docker client {{.Client.Version}}, server {{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})"
docker info --format "{{.OperatingSystem}}, kernel {{.KernelVersion}}"
git config --get core.autocrlf

Write-Host "== Dependencies"
Push-Location (Join-Path $PSScriptRoot "../../..")
bun install
Pop-Location

Write-Host "== Building the sandbox image (a few minutes)"
bun run script/sandbox-image.ts --tag lunos-sandbox:local
if ($LASTEXITCODE -ne 0) { throw "image build failed" }

Write-Host "== Sandboxed runs end to end"
$env:SANDBOX_E2E_VERBOSE = "1"
bun run script/sandbox-e2e.ts --runtime docker --image lunos-sandbox:local
exit $LASTEXITCODE
