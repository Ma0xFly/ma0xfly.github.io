Add-Type -AssemblyName System.Windows.Forms

$projectRoot = [System.AppDomain]::CurrentDomain.BaseDirectory.TrimEnd('\')
$managerUrl = "http://127.0.0.1:3210/"
$metaUrl = "http://127.0.0.1:3210/api/meta"
$logDir = Join-Path $projectRoot ".run"
$stdout = Join-Path $logDir "manager-launch.out.log"
$stderr = Join-Path $logDir "manager-launch.err.log"
$pidFile = Join-Path $logDir "manager.pid"
$requiredApiVersion = 3
$requiredCapabilities = @(
  "build",
  "check",
  "deploy",
  "publish-and-deploy",
  "update-published",
  "sync-status",
  "live-check",
  "auth-token"
)

function Show-Error($message) {
  [System.Windows.Forms.MessageBox]::Show(
    $message,
    "Publishing Desk Launch Error",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

function Rotate-Logs($dir, $keep = 6) {
  if (!(Test-Path -LiteralPath $dir)) { return }
  $files = Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  if ($files.Count -le $keep) { return }
  $files | Select-Object -Skip $keep | ForEach-Object {
    try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch {}
  }
}

function Stop-RecordedManager() {
  if (!(Test-Path -LiteralPath $pidFile)) { return }

  try {
    $pidText = Get-Content -LiteralPath $pidFile -Raw
    $managerPid = [int]$pidText.Trim()
    $process = Get-Process -Id $managerPid -ErrorAction SilentlyContinue
    if ($process) {
      $procMeta = Get-CimInstance Win32_Process -Filter "ProcessId = $managerPid" -ErrorAction SilentlyContinue
      $processName = ""
      if ($procMeta -and $procMeta.Name) {
        $processName = [string]$procMeta.Name
      }
      $processName = $processName.ToLowerInvariant()

      $cmdline = ""
      if ($procMeta -and $procMeta.CommandLine) {
        $cmdline = [string]$procMeta.CommandLine
      }
      $cmdline = $cmdline.ToLowerInvariant()
      $looksLikeManager =
        ($processName -eq "node.exe" -and ($cmdline.Contains("publish-manager.mjs") -or $cmdline.Contains("npm run manager"))) -or
        ($processName -eq "cmd.exe" -and $cmdline.Contains("npm run manager"))

      if ($looksLikeManager) {
        try { Stop-Process -Id $managerPid -Force -ErrorAction Stop } catch {}
      }
    }
  } catch {}

  try { Remove-Item -LiteralPath $pidFile -Force -ErrorAction Stop } catch {}
}

function Get-ManagerListenerPid() {
  try {
    $conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3210 -State Listen -ErrorAction Stop |
      Select-Object -First 1
    if ($conn -and $conn.OwningProcess) {
      return [int]$conn.OwningProcess
    }
  } catch {}

  return $null
}

if (!(Test-Path -LiteralPath (Join-Path $projectRoot "package.json"))) {
  Show-Error "package.json was not found next to the executable. Place the EXE in the blog project root before launching it."
  exit 1
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Rotate-Logs $logDir

try {
  $meta = Invoke-RestMethod -Uri $metaUrl -UseBasicParsing -TimeoutSec 2
  $capabilitySet = @($meta.capabilities)
  $hasAllCapabilities = $true
  foreach ($capability in $requiredCapabilities) {
    if ($capabilitySet -notcontains $capability) {
      $hasAllCapabilities = $false
      break
    }
  }

  if ($meta.apiVersion -ge $requiredApiVersion -and $hasAllCapabilities) {
    Start-Process $managerUrl
    exit 0
  }
} catch {}

Stop-RecordedManager

try {
  cmd /c npm -v | Out-Null
} catch {
  Show-Error "npm is not available on this machine. Please make sure Node.js and npm are installed."
  exit 1
}

if (Test-Path -LiteralPath $stdout) { Remove-Item -LiteralPath $stdout -Force }
if (Test-Path -LiteralPath $stderr) { Remove-Item -LiteralPath $stderr -Force }

$process = Start-Process `
  -FilePath "cmd.exe" `
  -ArgumentList "/c","npm run manager" `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -Uri $managerUrl -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $listenerPid = Get-ManagerListenerPid
      if ($listenerPid) {
        Set-Content -LiteralPath $pidFile -Value $listenerPid -Encoding ascii
      }
      Start-Process $managerUrl
      exit 0
    }
  } catch {}
}

$stderrText = ""
if (Test-Path -LiteralPath $stderr) {
  $stderrText = Get-Content -LiteralPath $stderr -Raw
}

if (!$process.HasExited) {
  try { Stop-Process -Id $process.Id -Force } catch {}
}

try { Remove-Item -LiteralPath $pidFile -Force -ErrorAction Stop } catch {}

Show-Error ("The publishing desk did not start in time." + [Environment]::NewLine + [Environment]::NewLine + $stderrText)
exit 1
