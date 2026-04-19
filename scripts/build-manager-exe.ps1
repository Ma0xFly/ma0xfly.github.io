$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherScript = Join-Path $PSScriptRoot "launch-manager.ps1"
$cnName = "{0}{1}{2}.exe" -f [char]0x53D1, [char]0x5E03, [char]0x53F0
$cnExe = Join-Path $projectRoot $cnName

if (!(Get-Command Invoke-PS2EXE -ErrorAction SilentlyContinue)) {
  Write-Host "Installing ps2exe module..."
  Install-Module ps2exe -Scope CurrentUser -Force -AllowClobber
}

Invoke-PS2EXE `
  -inputFile $launcherScript `
  -outputFile $cnExe `
  -noConsole

Write-Host "Created:" $cnExe
