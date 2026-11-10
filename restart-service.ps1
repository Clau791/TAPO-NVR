# Reporneste serviciul TapoNVR (dupa modificari in config.json sau in cod).
# Rulare: powershell -ExecutionPolicy Bypass -File .\restart-service.ps1   (cere singur drepturi de administrator)
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    exit
}
$appDir = $PSScriptRoot
Write-Host 'Opresc serviciul TapoNVR...'
Stop-ScheduledTask -TaskName 'TapoNVR' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
# procese ramase (ffmpeg/go2rtc pornite de instanta oprita)
Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.CommandLine -like '*TapoNVR*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process go2rtc -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$appDir*" } | Stop-Process -Force
Start-ScheduledTask -TaskName 'TapoNVR'
Start-Sleep -Seconds 4
$state = (Get-ScheduledTask -TaskName 'TapoNVR').State
Write-Host "Serviciul TapoNVR: $state"
