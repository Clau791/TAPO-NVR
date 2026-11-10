# Inregistreaza Tapo NVR ca sarcina programata care porneste la boot (fara logare),
# ruleaza ca SYSTEM si este repornita automat daca se opreste.
# Rulare: click dreapta pe PowerShell -> "Run as administrator", apoi:
#   powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
# Optional: -NoSleep dezactiveaza sleep/hibernare cand PC-ul e pe priza.
param([switch]$NoSleep)

$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    # Se reporneste singur cu drepturi de administrator (apare promptul Windows UAC)
    Write-Host 'Cer drepturi de administrator...'
    $argsList = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($NoSleep) { $argsList += '-NoSleep' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argsList
    exit
}

$appDir = $PSScriptRoot

# Opreste eventuale instante pornite manual (start.cmd), ca sa nu se dubleze conexiunea si portul
$webPort = (Get-Content "$appDir\config.json" -Raw | ConvertFrom-Json).web.port
if (-not $webPort) { $webPort = 8080 }
Get-NetTCPConnection -LocalPort $webPort -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { Write-Host "Opresc instanta existenta (PID $($p.Id))"; Stop-Process -Id $p.Id -Force }
}
Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.CommandLine -like '*TapoNVR*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process go2rtc -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" } | Stop-Process -Force
$node = (Get-Command node).Source
$taskName = 'TapoNVR'

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$appDir\server.js`"" -WorkingDirectory $appDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 9999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable -MultipleInstances IgnoreNew
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $taskPrincipal -Description 'Inregistrare non-stop camera Tapo C230 + client web' -Force | Out-Null

# Permite accesul din reteaua locala la clientul web
$port = (Get-Content "$appDir\config.json" -Raw | ConvertFrom-Json).web.port
if (-not $port) { $port = 8080 }
if (-not (Get-NetFirewallRule -DisplayName 'Tapo NVR web' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Tapo NVR web' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
}

if ($NoSleep) {
    powercfg /change standby-timeout-ac 0
    powercfg /change hibernate-timeout-ac 0
    Write-Host 'Sleep/hibernare dezactivate pe priza.'
}

Start-ScheduledTask -TaskName $taskName
Write-Host "Gata. Sarcina '$taskName' instalata si pornita. Client web: https://localhost:$port (din internet: Tailscale Funnel)"
