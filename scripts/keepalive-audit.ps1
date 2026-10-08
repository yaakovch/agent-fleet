$ProgressPreference='SilentlyContinue'
$ErrorActionPreference = 'Stop'
$backup = Join-Path $env:LOCALAPPDATA ('AgentFleet\keepalive-rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$task = Get-ScheduledTask -TaskName 'Tailscale-WSL-KeepAlive' -ErrorAction SilentlyContinue
if (!$task) { [pscustomobject]@{host=$env:COMPUTERNAME; task='absent'; backup=$backup} | ConvertTo-Json; exit 0 }
$xml = Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath
$xml | Set-Content -Encoding UTF8 (Join-Path $backup 'task.xml')
$files = @()
foreach ($action in $task.Actions) {
  $exe = [Environment]::ExpandEnvironmentVariables($action.Execute)
  if (Test-Path -LiteralPath $exe -PathType Leaf) {
    $dir = Split-Path $exe
    $base = [IO.Path]::GetFileNameWithoutExtension($exe)
    foreach ($file in (Get-ChildItem -LiteralPath $dir -File | Where-Object { $_.BaseName -eq $base -and $_.Extension -in '.xml','.json','.yml','.yaml','.ini','.ps1','.cmd','.bat' })) {
      Copy-Item -LiteralPath $file.FullName -Destination $backup
      $content = Get-Content -Raw -LiteralPath $file.FullName
      $summary = if ($file.Extension -eq '.xml') {
        try { $doc = [xml]$content; @{root=$doc.DocumentElement.Name; executable=$doc.service.executable; arguments=$doc.service.arguments; nodes=@($doc.DocumentElement.ChildNodes | ForEach-Object {$_.Name})} } catch { @{parse='failed'} }
      } else { @{type=$file.Extension; hasKeepAlive=($content -match 'KeepAlive|sleep.*infinity')} }
      $files += @{path=$file.FullName; sha256=(Get-FileHash -LiteralPath $file.FullName).Hash; summary=$summary}
    }
  }
}
$creators = @(Get-ScheduledTask | Where-Object {$_.TaskName -ne $task.TaskName -and (($_.Actions | ConvertTo-Json -Compress) -match 'Tailscale-WSL-KeepAlive|wsl.keepalive') } | Select-Object TaskName,TaskPath,State,Actions)
$startup = @(Get-CimInstance Win32_StartupCommand | Where-Object {$_.Command -match 'Tailscale-WSL-KeepAlive|wsl.keepalive'} | Select-Object Name,Command,Location)
$processes = @(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -match 'wsl.keepalive|sleep infinity|sleep_infinity' -and $_.Name -notmatch 'powershell|ssh'} | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate)
[pscustomobject]@{host=$env:COMPUTERNAME; backup=$backup; task=$task.TaskName; state=[string]$task.State; actions=@($task.Actions | Select-Object Execute,Arguments,WorkingDirectory); files=$files; creators=$creators; startup=$startup; processes=$processes} | ConvertTo-Json -Depth 10
