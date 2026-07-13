param([string]$Executable = (Join-Path $PSScriptRoot '..\dist\win-unpacked\Agent Fleet.exe'))

if (-not (Test-Path -LiteralPath $Executable)) { throw "Packaged executable not found: $Executable" }
$root = Join-Path ([System.IO.Path]::GetTempPath()) "ai-limits-smoke-$PID"
$previousDataDir = $env:AI_LIMITS_DATA_DIR
$process = $null
try {
  $env:AI_LIMITS_DATA_DIR = $root
  $process = Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 5
  if ($process.HasExited) { throw "Packaged app exited with code $($process.ExitCode)" }
  $logPath = Join-Path $root 'logs\main.log'
  if (-not (Test-Path -LiteralPath $logPath)) { throw 'Packaged app did not initialize its isolated data directory.' }
  $renderer = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $process.Id -and $_.CommandLine -match '--type=renderer' }
  if (-not $renderer -or $renderer.CommandLine -notmatch '--enable-sandbox') { throw 'Packaged renderer sandbox was not enabled.' }
  Write-Output "Packaged smoke test passed: PID $($process.Id)"
} finally {
  if ($process) {
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$root*" } | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  $env:AI_LIMITS_DATA_DIR = $previousDataDir
}
