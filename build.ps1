# build.ps1 — run from the repo root; produces ./artifacts/<version>/{web,api} and ./artifacts/lunos-<version>.zip
param(
    [string]$Version = (Get-Date -Format "yyyyMMdd-HHmmss")
)

$ErrorActionPreference = "Stop"
$artifactsDir = Join-Path $PSScriptRoot "artifacts"
$artifactRoot = Join-Path $artifactsDir $Version
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

$webOutput = Join-Path $artifactRoot "web"
$apiOutput = Join-Path $artifactRoot "api"

Write-Host "Building Lunos.Web (Angular)..."
Push-Location (Join-Path $PSScriptRoot "Lunos.Web")
npm ci
npx ng build --configuration production --output-path $webOutput
Pop-Location

# The Angular application builder emits into a browser/ subfolder — flatten it here
# so deploy.ps1 can robocopy $webOutput straight to the IIS site root
# without needing to know about the builder's internal layout.
$browserOutput = Join-Path $webOutput "browser"
if (Test-Path $browserOutput) {
    Get-ChildItem $browserOutput | Move-Item -Destination $webOutput -Force
    Remove-Item $browserOutput -Recurse -Force
}

Write-Host "Publishing Lunos.Api (.NET)..."
$apiProject = Join-Path (Join-Path (Join-Path $PSScriptRoot "Lunos.Api") "Lunos.Api") "Lunos.Api.csproj"
dotnet publish $apiProject `
    -c Release `
    -o $apiOutput `
    --runtime win-x64 `
    --self-contained false

$Version | Out-File -Encoding utf8 (Join-Path $artifactRoot "version.txt")

Write-Host "Zipping artifact..."
$zipPath = Join-Path $artifactsDir "lunos-$Version.zip"
Compress-Archive -Path (Join-Path $artifactRoot "*") -DestinationPath $zipPath -Force

Write-Host "Done: $zipPath"
