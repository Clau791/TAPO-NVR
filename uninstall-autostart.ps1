# Opreste si sterge sarcina programata Tapo NVR (ruleaza ca Administrator).
Stop-ScheduledTask -TaskName 'TapoNVR' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'TapoNVR' -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.CommandLine -like '*TapoNVR*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process go2rtc -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$PSScriptRoot*" } | Stop-Process -Force
Remove-NetFirewallRule -DisplayName 'Tapo NVR web' -ErrorAction SilentlyContinue
Write-Host 'Sarcina TapoNVR a fost eliminata. Inregistrarile raman in dataDir.'
