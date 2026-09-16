# Installs the Python-based native host (no .NET SDK required).
# Run: powershell -ExecutionPolicy Bypass -File install-python-host.ps1
param(
  [string]$ExtensionId = "lgdfehfacdnpknkphkfmmollklciaaal",
  [string]$PublishDir = (Join-Path (Split-Path $PSScriptRoot -Parent) "publish"),
  [string]$YtDlpPath = ""
)

$ErrorActionPreference = "Stop"

$pythonHostDir = $PSScriptRoot
$repoRoot = Split-Path $pythonHostDir -Parent
if (-not (Test-Path -LiteralPath $PublishDir)) {
  New-Item -ItemType Directory -Path $PublishDir -Force | Out-Null
}

# 1. host.py next to the launcher exe
Copy-Item -LiteralPath (Join-Path $pythonHostDir "host.py") `
  -Destination (Join-Path $PublishDir "host.py") -Force

# 2. build launcher if missing
$exe = Join-Path $PublishDir "YouTubeYtDlpHost.exe"
if (-not (Test-Path -LiteralPath $exe)) {
  $csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  if (-not (Test-Path -LiteralPath $csc)) { throw "csc.exe not found: $csc" }
  & $csc /nologo /target:winexe /out:$exe (Join-Path $pythonHostDir "Launcher.cs")
  if ($LASTEXITCODE -ne 0) { throw "csc build failed." }
}

# 3. locate yt-dlp
if ([string]::IsNullOrWhiteSpace($YtDlpPath)) {
  $envYt = [Environment]::GetEnvironmentVariable("YTDLP_PATH", "User")
  if (-not [string]::IsNullOrWhiteSpace($envYt) -and (Test-Path -LiteralPath $envYt)) {
    $YtDlpPath = $envYt
  } else {
    $cmd = Get-Command yt-dlp -ErrorAction SilentlyContinue
    if ($cmd) { $YtDlpPath = $cmd.Source }
  }
}

# 3b. the launcher runs host.py via pythonw.exe/python.exe on PATH at runtime
if (-not (Get-Command pythonw.exe -ErrorAction SilentlyContinue) -and -not (Get-Command python.exe -ErrorAction SilentlyContinue)) {
  Write-Warning "Neither pythonw.exe nor python.exe was found in PATH. The host will fail at runtime. Install Python 3.8+ (tick 'Add python.exe to PATH') or set the YTDLP_HOST_PYTHON environment variable to python.exe."
}

# 4. manifest
$manifestPath = Join-Path $PublishDir "com.fengj.youtube_ytdlp.json"
$manifest = @{
  name = "com.fengj.youtube_ytdlp"
  description = "Native host for downloading YouTube videos with yt-dlp"
  path = (Get-Item -LiteralPath $exe).FullName
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8

# 5. register for Chrome, Edge, Brave, Vivaldi, Opera, Yandex and Chromium fallback
# (HKCU, no admin needed). Vivaldi key verified against prior working setup;
# Opera also reads the Chrome key, its own keys are added as well;
# Yandex uses both variants since its exact lookup is undocumented;
# Chromium/Chrome keys serve as fallback for all Chromium forks.
$hosts = @(
  "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Vivaldi\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Opera Software\Opera Stable\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Opera Software\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Chromium\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Yandex\YandexBrowser\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Yandex\NativeMessagingHosts\com.fengj.youtube_ytdlp"
)
foreach ($key in $hosts) {
  & reg.exe add $key /ve /t REG_SZ /d "$manifestPath" /f | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to register native host: $key" }
}

# 6. persist YTDLP_PATH
if (-not [string]::IsNullOrWhiteSpace($YtDlpPath)) {
  [Environment]::SetEnvironmentVariable("YTDLP_PATH", $YtDlpPath, "User")
}

Write-Host "Installed native host manifest:"
Write-Host $manifestPath
Write-Host "Extension ID:"
Write-Host $ExtensionId
if (-not [string]::IsNullOrWhiteSpace($YtDlpPath)) {
  Write-Host "yt-dlp path:"
  Write-Host $YtDlpPath
}
Write-Host "Load the unpacked extension from the repository root, then restart the browser."
