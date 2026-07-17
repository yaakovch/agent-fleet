param(
  [string]$Executable = (Join-Path $PSScriptRoot '..\dist\win-unpacked\Agent Fleet.exe'),
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\dist\power-policy-report.json'),
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Executable `"$Executable`" -OutputPath `"$OutputPath`" -Elevated"
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Elevated power verification failed with exit code $($process.ExitCode)." }
  Get-Content -LiteralPath $OutputPath -Raw
  exit 0
}
if (-not (Test-Path -LiteralPath $Executable)) { throw "Packaged executable not found: $Executable" }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AgentFleetLastInput {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO value);
  public static double Seconds() {
    var value = new LASTINPUTINFO(); value.cbSize = (uint)Marshal.SizeOf(value);
    var now = unchecked((uint)Environment.TickCount);
    return GetLastInputInfo(ref value) ? unchecked(now - value.dwTime) / 1000.0 : -1;
  }
}
'@

function Get-PowerSnapshot([string]$Phase) {
  $text = (& powercfg.exe /requests | Out-String)
  $display = [regex]::Match($text, '(?ms)^DISPLAY:\s*(.*?)(?=^[A-Z]+:)').Groups[1].Value
  $system = [regex]::Match($text, '(?ms)^SYSTEM:\s*(.*?)(?=^[A-Z]+:)').Groups[1].Value
  $execution = [regex]::Match($text, '(?ms)^EXECUTION:\s*(.*?)(?=^[A-Z]+:)').Groups[1].Value
  return [ordered]@{
    phase = $Phase
    at = (Get-Date).ToUniversalTime().ToString('o')
    lastInputSeconds = [Math]::Round([AgentFleetLastInput]::Seconds(), 2)
    agentFleetDisplayRequest = $display -match 'Agent Fleet'
    agentFleetSystemRequest = $system -match 'Agent Fleet'
    agentFleetExecutionRequest = $execution -match 'Agent Fleet'
    raw = $text.Trim()
  }
}

function Wait-Phase([string]$Path, [string]$Expected, [int]$TimeoutSeconds = 15) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-Path -LiteralPath $Path) {
      try {
        $phase = (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json).phase
        if ($phase -eq $Expected) { return }
      } catch { }
    }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw "Agent Fleet did not reach power smoke phase $Expected."
}

$root = Join-Path ([System.IO.Path]::GetTempPath()) "agent-fleet-power-$PID"
$state = Join-Path $root 'power-smoke.json'
$previousData = $env:AI_LIMITS_DATA_DIR
$previousEnable = $env:AGENT_FLEET_ENABLE_POWER_SMOKE
$process = $null
try {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $env:AI_LIMITS_DATA_DIR = $root
  $env:AGENT_FLEET_ENABLE_POWER_SMOKE = '1'
  $process = Start-Process -FilePath $Executable -ArgumentList "--agent-fleet-power-smoke=$state" -WindowStyle Hidden -PassThru
  Wait-Phase $state 'idle'
  $idle = Get-PowerSnapshot 'idle'
  Wait-Phase $state 'active-download'
  $active = Get-PowerSnapshot 'active-download'
  Wait-Phase $state 'released'
  $released = Get-PowerSnapshot 'released'
  $process.WaitForExit(10000) | Out-Null

  $passed = -not $idle.agentFleetDisplayRequest -and -not $active.agentFleetDisplayRequest -and -not $released.agentFleetDisplayRequest `
    -and -not $idle.agentFleetSystemRequest -and -not $active.agentFleetSystemRequest -and -not $released.agentFleetSystemRequest `
    -and -not $idle.agentFleetExecutionRequest -and $active.agentFleetExecutionRequest -and -not $released.agentFleetExecutionRequest `
    -and $active.lastInputSeconds -gt $idle.lastInputSeconds
  $report = [ordered]@{ passed = $passed; idle = $idle; activeDownload = $active; released = $released }
  New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  if (-not $passed) { throw "Power policy verification failed. See $OutputPath" }
  Write-Output "Power policy verification passed: $OutputPath"
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  $env:AI_LIMITS_DATA_DIR = $previousData
  $env:AGENT_FLEET_ENABLE_POWER_SMOKE = $previousEnable
}
