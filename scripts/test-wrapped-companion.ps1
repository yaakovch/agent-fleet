param([Parameter(Mandatory=$true)][string]$Stage,[Parameter(Mandatory=$true)][string]$Report)
$ErrorActionPreference='Stop'
if(Get-NetTCPConnection -LocalPort 9857 -ErrorAction SilentlyContinue){throw 'Reserved review port 9857 is already in use.'}
$code=Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'
if(-not(Test-Path -LiteralPath $code)){throw 'VS Code was not found.'}
$env:WTMUX_WRAPPED_REVIEW=$Report
$arguments=@('--new-window','--remote-debugging-port=9857','--remote-debugging-address=127.0.0.1',
    '--user-data-dir', (Join-Path $Report 'user-data'),'--extensions-dir',(Join-Path $Report 'extensions'),
    "--extensionDevelopmentPath=$(Join-Path $Stage 'test\wrapped-link-driver')",
    "--extensionTestsPath=$(Join-Path $Stage 'test\wrapped-links-isolated.js')",
    '--skip-welcome','--skip-release-notes','--disable-workspace-trust','--disable-updates')
$process=Start-Process -FilePath $code -ArgumentList $arguments -PassThru
@{pid=$process.Id;startedAt=(Get-Date).ToUniversalTime().ToString('o');port=9857}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $Report 'launch.json')
$process.WaitForExit()
exit $process.ExitCode
