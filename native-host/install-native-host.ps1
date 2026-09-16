param(
  [string]$ExtensionId = "lgdfehfacdnpknkphkfmmollklciaaal",
  [string]$PublishDir = (Join-Path $PSScriptRoot "publish"),
  [string]$YtDlpPath = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $PublishDir)) {
  throw "Publish directory not found: $PublishDir. Run build-host.ps1 first."
}

$exe = Get-ChildItem -LiteralPath $PublishDir -Filter "YouTubeYtDlpHost.exe" | Select-Object -First 1
if (-not $exe) {
  throw "YouTubeYtDlpHost.exe not found in $PublishDir. Build the host first."
}

if ([string]::IsNullOrWhiteSpace($YtDlpPath)) {
  $cmd = Get-Command yt-dlp -ErrorAction SilentlyContinue
  if ($cmd) {
    $YtDlpPath = $cmd.Source
  }
}

$manifestPath = Join-Path $PublishDir "com.fengj.youtube_ytdlp.json"
$manifest = @{
  name = "com.fengj.youtube_ytdlp"
  description = "Native host for downloading YouTube videos with yt-dlp"
  path = $exe.FullName
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4

Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8

# Register for all major Chromium browsers (HKCU, no admin needed).
# Opera also reads the Chrome key; Yandex uses both variants since its
# exact lookup is undocumented; the rest use their vendor keys.
$hosts = @(
  "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Chromium\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Vivaldi\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Opera Software\Opera Stable\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Opera Software\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Yandex\YandexBrowser\NativeMessagingHosts\com.fengj.youtube_ytdlp",
  "HKCU\Software\Yandex\NativeMessagingHosts\com.fengj.youtube_ytdlp"
)
foreach ($key in $hosts) {
  & reg.exe add $key /ve /t REG_SZ /d "$manifestPath" /f | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to register native host: $key" }
}

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
Write-Host "Restart the browser, then reload the extension."
