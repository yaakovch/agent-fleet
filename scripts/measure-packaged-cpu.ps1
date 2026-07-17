param(
  [int]$RootProcessId = 0,
  [string]$Executable = '',
  [ValidateSet('visible', 'hidden')][string]$Mode = 'visible',
  [int]$StartupTimeoutSeconds = 120,
  [int]$SettleSeconds = 30,
  [int]$Samples = 60,
  [double]$TargetPercent = 2.0,
  [string]$WorkspaceFixture = '',
  [int]$ExpectedEmbeddedTerminals = 0,
  [switch]$Enforce
)

$ErrorActionPreference = 'Stop'
$launched = $null
$testDataRoot = $null
$previousDataDir = $env:AI_LIMITS_DATA_DIR
$previousCpuSmoke = $env:AGENT_FLEET_ENABLE_CPU_SMOKE
if ($RootProcessId -le 0) {
  if (-not $Executable -or -not (Test-Path -LiteralPath $Executable)) {
    throw 'Pass a live -RootProcessId or an existing -Executable.'
  }
  $testDataRoot = Join-Path ([System.IO.Path]::GetTempPath()) "agent-fleet-cpu-$PID"
  New-Item -ItemType Directory -Path $testDataRoot -Force | Out-Null
  $currentSettings = Join-Path $env:APPDATA 'AI Limits Widget\settings.json'
  if (Test-Path -LiteralPath $currentSettings) {
    $testSettings = Join-Path $testDataRoot 'settings.json'
    Copy-Item -LiteralPath $currentSettings -Destination $testSettings
    $settings = Get-Content -LiteralPath $testSettings -Raw | ConvertFrom-Json
    $settings.automaticUpdates = $false
    $settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $testSettings -Encoding UTF8
  }
  if ($WorkspaceFixture) {
    if (-not (Test-Path -LiteralPath $WorkspaceFixture)) { throw "Workspace fixture not found: $WorkspaceFixture" }
    Copy-Item -LiteralPath $WorkspaceFixture -Destination (Join-Path $testDataRoot 'terminal-workspace-v2.json')
  }
  $env:AI_LIMITS_DATA_DIR = $testDataRoot
  $env:AGENT_FLEET_ENABLE_CPU_SMOKE = '1'
  $startArguments = @{ FilePath = $Executable; ArgumentList = '--agent-fleet-cpu-smoke'; PassThru = $true }
  if ($Mode -eq 'hidden') { $startArguments.WindowStyle = 'Hidden' }
  $launched = Start-Process @startArguments
  $RootProcessId = $launched.Id
}
if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) {
  throw "Agent Fleet process $RootProcessId is not running."
}
if ($SettleSeconds -lt 0 -or $Samples -lt 1) { throw 'SettleSeconds must be non-negative and Samples must be positive.' }

function Get-ProcessTreeIds([int]$RootId) {
  $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $found = [System.Collections.Generic.HashSet[int]]::new()
  $pending = [System.Collections.Generic.Queue[int]]::new()
  [void]$found.Add($RootId)
  $pending.Enqueue($RootId)
  while ($pending.Count -gt 0) {
    $parent = $pending.Dequeue()
    foreach ($row in $rows) {
      $id = [int]$row.ProcessId
      if ([int]$row.ParentProcessId -eq $parent -and $found.Add($id)) { $pending.Enqueue($id) }
    }
  }
  return @($found)
}

function Get-CpuTotals([int[]]$Ids) {
  $totals = @{}
  foreach ($id in $Ids) {
    $item = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($item) { $totals[$id] = $item.TotalProcessorTime.TotalSeconds }
  }
  return $totals
}

$embeddedTerminals = 0
if ($ExpectedEmbeddedTerminals -gt 0) {
  Write-Output "Waiting up to $StartupTimeoutSeconds seconds for $ExpectedEmbeddedTerminals embedded terminals..."
  $logPath = Join-Path $testDataRoot 'logs\main.log'
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  do {
    if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) {
      throw "Agent Fleet process $RootProcessId exited while connecting terminals."
    }
    if (Test-Path -LiteralPath $logPath) {
      $embeddedTerminals = @(Select-String -LiteralPath $logPath -Pattern 'Embedded terminal connected').Count
    }
    if ($embeddedTerminals -ge $ExpectedEmbeddedTerminals) { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  if ($embeddedTerminals -lt $ExpectedEmbeddedTerminals) {
    throw "Expected $ExpectedEmbeddedTerminals embedded terminals, observed $embeddedTerminals."
  }
}
Write-Output "Settling Agent Fleet ($Mode) for $SettleSeconds seconds..."
if ($SettleSeconds -gt 0) { Start-Sleep -Seconds $SettleSeconds }
if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) {
  throw "Agent Fleet process $RootProcessId exited while settling."
}
$logicalProcessors = [Environment]::ProcessorCount
$previous = Get-CpuTotals (Get-ProcessTreeIds $RootProcessId)
$values = [System.Collections.Generic.List[double]]::new()
for ($sample = 0; $sample -lt $Samples; $sample++) {
  Start-Sleep -Seconds 1
  if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) {
    throw "Agent Fleet process $RootProcessId exited during CPU sampling."
  }
  $currentIds = Get-ProcessTreeIds $RootProcessId
  $current = Get-CpuTotals $currentIds
  $seconds = 0.0
  foreach ($id in $current.Keys) {
    if ($previous.ContainsKey($id)) { $seconds += [Math]::Max(0, $current[$id] - $previous[$id]) }
  }
  $values.Add(($seconds / $logicalProcessors) * 100)
  $previous = $current
}

$average = ($values | Measure-Object -Average).Average
$maximum = ($values | Measure-Object -Maximum).Maximum
$result = [ordered]@{
  rootProcessId = $RootProcessId
  mode = $Mode
  settleSeconds = $SettleSeconds
  samples = $Samples
  logicalProcessors = $logicalProcessors
  averageCpuPercent = [Math]::Round($average, 3)
  maximumCpuPercent = [Math]::Round($maximum, 3)
  embeddedTerminals = $embeddedTerminals
  targetCpuPercent = $TargetPercent
  passed = $average -lt $TargetPercent
}
$result | ConvertTo-Json -Compress
if ($launched) {
  if (Get-Process -Id $launched.Id -ErrorAction SilentlyContinue) {
    & taskkill.exe /PID $launched.Id /T /F 2>$null | Out-Null
    Stop-Process -Id $launched.Id -Force -ErrorAction SilentlyContinue
  }
}
$env:AI_LIMITS_DATA_DIR = $previousDataDir
$env:AGENT_FLEET_ENABLE_CPU_SMOKE = $previousCpuSmoke
if ($testDataRoot) { Remove-Item -LiteralPath $testDataRoot -Recurse -Force -ErrorAction SilentlyContinue }
if ($Enforce -and -not $result.passed) { exit 1 }
