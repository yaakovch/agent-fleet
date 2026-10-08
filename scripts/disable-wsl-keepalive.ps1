param([switch]$InspectOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$name = 'Tailscale-WSL-KeepAlive'
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if (!$task) { @{host=$env:COMPUTERNAME; state='absent'} | ConvertTo-Json; exit 0 }
$backup = Join-Path $env:LOCALAPPDATA ('AgentFleet\keepalive-rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Export-ScheduledTask -TaskName $name -TaskPath $task.TaskPath | Set-Content -Encoding UTF8 (Join-Path $backup 'task.xml')
$actions = @($task.Actions | Select-Object Execute,Arguments,WorkingDirectory)
if ($actions.Count -ne 1) { throw 'Unexpected task actions; export retained, nothing disabled' }
$action = $actions[0]
$config = $action.Arguments.Trim('"')
$verifiedConfig = $false
if ($config -match '(wsl-keepalive\.xml|Tailscale-WSL-KeepAlive\.json)$' -and (Test-Path -LiteralPath $config -PathType Leaf)) {
  Copy-Item -LiteralPath $config -Destination $backup
  if ($config.EndsWith('.xml')) {
    $xml = [xml][string](Get-Content -Raw -LiteralPath $config)
    $verifiedConfig = $xml.Launch.Execute -match '\\wsl\.exe$' -and $xml.Launch.Arguments -match '^-d Ubuntu(?:-24\.04)? --exec /usr/bin/sleep infinity$'
  }
}
$service = New-Object -ComObject 'Schedule.Service'; $service.Connect()
$running = @($service.GetRunningTasks(0) | Where-Object {$_.Path -eq ($task.TaskPath + $name)})
$owned = @()
foreach ($instance in $running) {
  $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $instance.EnginePID)
  if (!$verifiedConfig -or $process.Name -ne 'wsl.exe' -or $process.CommandLine -notmatch ' -d Ubuntu(?:-24\.04)? --exec /usr/bin/sleep infinity$') {
    throw 'Live task ownership needs review; export retained, nothing disabled or stopped'
  }
  $owned += @{pid=[int]$process.ProcessId; parent=[int]$process.ParentProcessId; created=[string]$process.CreationDate; command=[string]$process.CommandLine; instance=[string]$instance.InstanceGuid}
}
$creators = @(Get-ScheduledTask | Where-Object {$_.TaskName -ne $name -and (($_.Actions | Select-Object Execute,Arguments | ConvertTo-Json -Compress) -match 'Tailscale-WSL-KeepAlive|wsl-keepalive')} | Select-Object TaskName,TaskPath)
$startup = @(Get-CimInstance Win32_StartupCommand | Where-Object {$_.Command -match 'Tailscale-WSL-KeepAlive|wsl-keepalive'} | Select-Object Name,Command,Location)
if ($creators.Count -or $startup.Count) { throw 'A startup recreator needs explicit inspection; export retained' }
if (!$InspectOnly) {
  Disable-ScheduledTask -TaskName $name -TaskPath $task.TaskPath | Out-Null
  if ($running.Count) { Stop-ScheduledTask -TaskName $name -TaskPath $task.TaskPath }
  Start-Sleep -Milliseconds 500
}
$result = @{host=$env:COMPUTERNAME; backup=$backup; state=[string](Get-ScheduledTask -TaskName $name).State; inspectOnly=[bool]$InspectOnly; actions=$actions; owned=$owned; creators=$creators; startup=$startup; retainedFiles=$true}
$result | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $backup 'receipt.json')
$result | ConvertTo-Json -Depth 5
