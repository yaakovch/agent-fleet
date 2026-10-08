param([string]$Executable = (Join-Path $PSScriptRoot '..\dist\win-unpacked\Agent Fleet.exe'))

if (-not (Test-Path -LiteralPath $Executable)) { throw "Packaged executable not found: $Executable" }
$updateConfig = Join-Path (Split-Path -Parent $Executable) 'resources\app-update.yml'
if (-not (Test-Path -LiteralPath $updateConfig)) { throw 'Packaged app update configuration is missing.' }
$updateConfigText = Get-Content -LiteralPath $updateConfig -Raw
if ($updateConfigText -notmatch '(?m)^provider: github\r?$' -or
  $updateConfigText -notmatch '(?m)^repo: agent-fleet\r?$' -or
  $updateConfigText -notmatch '(?m)^  - SignPath Foundation\r?$') {
  throw 'Packaged app update configuration is invalid.'
}
$root = Join-Path ([System.IO.Path]::GetTempPath()) "ai-limits-smoke-$PID"
$previousDataDir = $env:AI_LIMITS_DATA_DIR
$process = $null
$terminalProcess = $null
function Get-FleetStartupSnapshot {
  $run = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
  $entries = @($run.PSObject.Properties | Where-Object {
    $_.Name -notlike 'PS*' -and ($_.Name -match 'Fleet|Limits' -or [string]$_.Value -match 'Fleet|Limits')
  } | Sort-Object Name | ForEach-Object { @{name=$_.Name; value=[string]$_.Value} })
  $shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\AI Limits Widget.lnk'
  $shortcutHash = if (Test-Path -LiteralPath $shortcut) { (Get-FileHash -LiteralPath $shortcut -Algorithm SHA256).Hash } else { $null }
  @{entries=$entries; shortcutHash=$shortcutHash} | ConvertTo-Json -Depth 4 -Compress
}
$startupBefore = Get-FleetStartupSnapshot
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
  # Tray-only startup must not acquire a Linux backend. Explicit terminal smoke below may do so.
  Start-Sleep -Seconds 5
  if ($process.HasExited) { throw "Packaged app exited with code $($process.ExitCode)" }
  if (-not (Test-Path -LiteralPath $logPath)) { throw 'Packaged app did not initialize its isolated data directory.' }
  if (Select-String -LiteralPath $logPath -Quiet -Pattern 'Embedded workspace restored|Fleet bridge exited') {
    throw 'Tray-only startup unexpectedly started the Linux bridge.'
  }
  $linuxChildren = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $process.Id -and $_.Name -eq 'wsl.exe' })
  if ($linuxChildren.Count) { throw 'Tray-only startup retained a WSL child.' }
  $renderer = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $process.Id -and $_.CommandLine -match '--type=renderer' }
  if (-not $renderer -or $renderer.CommandLine -notmatch '--enable-sandbox') { throw 'Packaged renderer sandbox was not enabled.' }
  $terminalResult = Join-Path $root 'terminal-smoke.json'
  $env:AGENT_FLEET_ENABLE_TERMINAL_SMOKE = '1'
  $terminalProcess = Start-Process -FilePath $Executable -ArgumentList "--agent-fleet-terminal-smoke=$terminalResult" -WindowStyle Hidden -Wait -PassThru
  if ($terminalProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $terminalResult)) {
    $detail = if (Test-Path -LiteralPath $terminalResult) { Get-Content -LiteralPath $terminalResult -Raw } else { 'no terminal receipt' }
    throw "Packaged terminal smoke failed with code $($terminalProcess.ExitCode): $detail"
  }
  $terminalStatus = Get-Content -LiteralPath $terminalResult -Raw | ConvertFrom-Json
  if ($terminalStatus.status -ne 'ok' -or -not $terminalStatus.marker -or $terminalStatus.backend -notin @('wsl', 'conpty')) {
    throw 'Packaged ConPTY terminal did not return the expected marker.'
  }
  if ($requireFleet -and
    (Select-String -LiteralPath $logPath -Quiet -Pattern 'Verified WSL runtime provisioning failed|WSL runtime provisioning failed after distribution change')) {
    throw 'Packaged app failed to provision its verified WSL runtime.'
  }
  $fleetStatus = 'tray-only Linux paused'
  if ((Get-FleetStartupSnapshot) -ne $startupBefore) { throw 'Isolated packaged smoke changed the installed Fleet startup configuration.' }
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
