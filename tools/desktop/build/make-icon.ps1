# Compatibility entry: one canonical renderer and icon encoder in C#.
param(
    [string]$OutIco = (Join-Path $PSScriptRoot "../assets/superstring.ico"),
    [string]$OutPng = (Join-Path $PSScriptRoot "../assets/superstring-preview.png"),
    [string]$LogFile = (Join-Path $PSScriptRoot "../../../artifacts/desktop/icon-build.log")
)
$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../.."))
$builder = Join-Path $root "artifacts/build/desktop/IconBuilder.exe"
if (-not (Test-Path $builder)) { throw "Run node tools/desktop/build/build.mjs first." }
& $builder $OutIco
if ($LASTEXITCODE -ne 0) { throw "Icon build failed." }
