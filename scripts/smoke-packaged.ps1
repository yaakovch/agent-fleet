param([string]$Executable = (Join-Path $PSScriptRoot '..\dist\win-unpacked\Agent Fleet.exe'))

if (-not (Test-Path -LiteralPath $Executable)) { throw "Packaged executable not found: $Executable" }
$root = Join-Path ([System.IO.Path]::GetTempPath()) "ai-limits-smoke-$PID"
$previousDataDir = $env:AI_LIMITS_DATA_DIR
$process = $null
$terminalProcess = $null
try {
  $requireFleet = $false
  $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
  if ($wsl) {
    $distributions = (& $wsl.Source --list --quiet 2>$null) -join "`n"
    $requireFleet = $LASTEXITCODE -eq 0 -and
      (($distributions -replace "`0", '') -split "`r?`n" | Where-Object { $_.Trim() -eq 'Ubuntu' }).Count -gt 0
  }
  $env:AI_LIMITS_DATA_DIR = $root
  $process = Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
  $logPath = Join-Path $root 'logs\main.log'
  $fleetReady = $false
  $startupAttempts = if ($requireFleet) { 40 } else { 5 }
  for ($attempt = 0; $attempt -lt $startupAttempts; $attempt += 1) {
    Start-Sleep -Seconds 1
    if ($process.HasExited) { throw "Packaged app exited with code $($process.ExitCode)" }
    if ((Test-Path -LiteralPath $logPath) -and
      (Select-String -LiteralPath $logPath -Quiet -Pattern 'Embedded workspace restored')) {
      $fleetReady = $true
      break
    }
  }
  if (-not (Test-Path -LiteralPath $logPath)) { throw 'Packaged app did not initialize its isolated data directory.' }
  if ($requireFleet -and -not $fleetReady) {
    throw 'Packaged app did not receive a real fleet snapshot from the embedded runtime.'
  }
  $renderer = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $process.Id -and $_.CommandLine -match '--type=renderer' }
  if (-not $renderer -or $renderer.CommandLine -notmatch '--enable-sandbox') { throw 'Packaged renderer sandbox was not enabled.' }
  $terminalResult = Join-Path $root 'terminal-smoke.json'
  $env:AGENT_FLEET_ENABLE_TERMINAL_SMOKE = '1'
  $terminalProcess = Start-Process -FilePath $Executable -ArgumentList "--agent-fleet-terminal-smoke=$terminalResult" -WindowStyle Hidden -Wait -PassThru
  if ($terminalProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $terminalResult)) {
    throw "Packaged terminal smoke failed with code $($terminalProcess.ExitCode)"
  }
  $terminalStatus = Get-Content -LiteralPath $terminalResult -Raw | ConvertFrom-Json
  if ($terminalStatus.status -ne 'ok' -or -not $terminalStatus.marker -or $terminalStatus.backend -notin @('wsl', 'conpty')) {
    throw 'Packaged ConPTY terminal did not return the expected marker.'
  }
  if ($requireFleet -and
    (Select-String -LiteralPath $logPath -Quiet -Pattern 'Verified WSL runtime provisioning failed|WSL runtime provisioning failed after distribution change')) {
    throw 'Packaged app failed to provision its verified WSL runtime.'
  }
  $fleetStatus = if ($requireFleet) { 'fleet live' } else { 'fleet skipped (Ubuntu unavailable)' }
  Write-Output "Packaged smoke test passed: PID $($process.Id), terminal $($terminalStatus.backend), $fleetStatus"
} finally {
  Remove-Item Env:AGENT_FLEET_ENABLE_TERMINAL_SMOKE -ErrorAction SilentlyContinue
  if ($process) {
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$root*" } | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    & taskkill.exe /PID $process.Id /T /F *> $null
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  $env:AI_LIMITS_DATA_DIR = $previousDataDir
}
