param(
  [int]$RootProcessId = 0,
  [string]$Executable = '',
  [ValidateSet('visible', 'hidden')][string]$Mode = 'visible',
  [int]$SettleSeconds = 30,
  [int]$Samples = 60,
  [double]$TargetPercent = 2.0,
  [switch]$Enforce
)

$ErrorActionPreference = 'Stop'
if ($RootProcessId -le 0) {
  if (-not $Executable -or -not (Test-Path -LiteralPath $Executable)) {
    throw 'Pass a live -RootProcessId or an existing -Executable.'
  }
  $launched = Start-Process -FilePath $Executable -PassThru
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

Write-Output "Settling Agent Fleet ($Mode) for $SettleSeconds seconds..."
if ($SettleSeconds -gt 0) { Start-Sleep -Seconds $SettleSeconds }
$logicalProcessors = [Environment]::ProcessorCount
$previous = Get-CpuTotals (Get-ProcessTreeIds $RootProcessId)
$values = [System.Collections.Generic.List[double]]::new()
for ($sample = 0; $sample -lt $Samples; $sample++) {
  Start-Sleep -Seconds 1
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
  targetCpuPercent = $TargetPercent
  passed = $average -lt $TargetPercent
}
$result | ConvertTo-Json -Compress
if ($Enforce -and -not $result.passed) { exit 1 }
