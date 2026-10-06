param(
    [Parameter(Mandatory = $true)][string]$CompanionPath,
    [string]$Report = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Report) { $Report = Join-Path $PSScriptRoot '..\build\reports\vscode-hostfiles' }
$Report = [System.IO.Path]::GetFullPath($Report)
$code = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'
if (-not (Test-Path -LiteralPath $code)) { throw 'VS Code was not found.' }
New-Item -ItemType Directory -Force -Path $Report | Out-Null
$stage = Join-Path $Report 'companion'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
foreach ($name in @('src', 'media', 'test', 'package.json')) {
    Copy-Item -LiteralPath (Join-Path $CompanionPath $name) -Destination $stage -Recurse
}
$env:WTMUX_FILE_PREVIEW_REVIEW = $Report
$arguments = @(
    '--new-window',
    '--user-data-dir', (Join-Path $Report 'user-data'),
    '--extensions-dir', (Join-Path $Report 'extensions'),
    "--extensionDevelopmentPath=$(Join-Path $stage 'test\host-files-isolated-driver')",
    "--extensionTestsPath=$(Join-Path $stage 'test\host-files-isolated.js')",
    '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates'
)
$process = Start-Process -FilePath $code -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "VS Code preview tests failed ($($process.ExitCode))." }
if (-not (Test-Path -LiteralPath (Join-Path $Report 'receipt.json'))) { throw 'VS Code preview receipt was not produced.' }
Get-Content -LiteralPath (Join-Path $Report 'receipt.json') -Raw
