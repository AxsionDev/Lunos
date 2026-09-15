# deploy.ps1 — run ON the IIS box, as Administrator, against a build.ps1 artifact zip
param(
    [Parameter(Mandatory = $true)][string]$ArtifactZip,
    [string]$WebSitePath = "C:\inetpub\lunos-web",
    [string]$ApiSitePath = "C:\inetpub\lunos-api",
    [string]$WebAppPool  = "Lunos.Web",
    [string]$ApiAppPool  = "Lunos.Api",
    [string]$BackupRoot  = "C:\inetpub\_backups",
    [int]$KeepBackups    = 5
)

Import-Module WebAdministration
$ErrorActionPreference = "Stop"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$extractPath = Join-Path $env:TEMP "lunos-deploy-$stamp"
Expand-Archive -Path $ArtifactZip -DestinationPath $extractPath -Force

# Sanity check before touching any live app pool: fail fast if build.ps1's flatten step didn't run.
$indexPath = Join-Path (Join-Path $extractPath "web") "index.html"
if (-not (Test-Path $indexPath)) {
    throw "Expected $indexPath to exist — check build.ps1's browser/ flatten step before deploying."
}

New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null

Write-Host "Stopping app pools..."
Stop-WebAppPool -Name $WebAppPool
Stop-WebAppPool -Name $ApiAppPool

function Backup-AndReplace($source, $target, $label, $excludeDirs = @()) {
    $backupDir = Join-Path $BackupRoot "$label-$stamp"
    if (Test-Path $target) {
        Write-Host "Backing up $label to $backupDir"
        Copy-Item -Path $target -Destination $backupDir -Recurse -Force
    }
    Write-Host "Deploying $label..."
    $robocopyArgs = @($source, $target, "/MIR", "/R:3", "/W:5")
    if ($excludeDirs.Count -gt 0) {
        $robocopyArgs += "/XD"
        $robocopyArgs += $excludeDirs
    }
    robocopy @robocopyArgs | Out-Null
    # robocopy exit codes are a bitmask, not a boolean: 0-3 are success (0 = no changes,
    # 1 = files copied, 2 = extra files removed, 3 = both); >=8 means real failure. Native
    # exit codes don't honor $ErrorActionPreference, so this must be checked explicitly.
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed deploying $label (exit code $LASTEXITCODE) — app pools are stopped, investigate before restarting them."
    }
}

Backup-AndReplace (Join-Path $extractPath "web") $WebSitePath "web"
# Exclude Logs\ from the mirror: it lives under the API's own site path (unlike the SQLite file,
# which is deliberately outside it — see §7), and Task 4's rolling file sink writes there. An /MIR
# without this exclusion would delete accumulated log files on every deploy.
Backup-AndReplace (Join-Path $extractPath "api") $ApiSitePath "api" -excludeDirs @("Logs")

foreach ($label in @("web", "api")) {
    Get-ChildItem $BackupRoot -Directory -Filter "$label-*" |
        Sort-Object CreationTime -Descending |
        Select-Object -Skip $KeepBackups |
        Remove-Item -Recurse -Force
}

Write-Host "Starting app pools..."
Start-WebAppPool -Name $WebAppPool
Start-WebAppPool -Name $ApiAppPool

Start-Sleep -Seconds 5
try {
    $response = Invoke-WebRequest -Uri "https://api.lunos.tech/health" -TimeoutSec 15 -UseBasicParsing
    if ($response.StatusCode -ne 200) {
        Write-Warning "API health check returned status $($response.StatusCode) after deploy — investigate before announcing this release."
    } else {
        Write-Host "API health check OK: $($response.Content)"
    }
} catch {
    Write-Warning "API health check FAILED after deploy — investigate before announcing this release."
}

Remove-Item $extractPath -Recurse -Force
Write-Host "Deploy complete."
