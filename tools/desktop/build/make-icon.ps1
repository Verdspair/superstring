# Compatibility entry: embedded frames come from the shared SVG during the desktop build.
param(
    [string]$OutIco = (Join-Path $PSScriptRoot "../../../artifacts/build/desktop/superstring.ico"),
    [string]$OutPng = (Join-Path $PSScriptRoot "../../../artifacts/build/desktop/superstring-preview.png"),
    [string]$LogFile = (Join-Path $PSScriptRoot "../../../artifacts/desktop/icon-build.log")
)
$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../.."))
$builder = Join-Path $root "artifacts/build/desktop/IconBuilder.exe"
if (-not (Test-Path $builder)) { throw "Run node tools/desktop/build/build.mjs first." }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutIco))) | Out-Null
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LogFile))) | Out-Null
& $builder $OutIco 2>&1 | Tee-Object -FilePath $LogFile
if ($LASTEXITCODE -ne 0) { throw "Icon build failed." }
$preview = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutIco))) "superstring-preview.png"
if ([IO.Path]::GetFullPath($preview) -ne [IO.Path]::GetFullPath($OutPng)) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutPng))) | Out-Null
    Copy-Item $preview $OutPng -Force
}
