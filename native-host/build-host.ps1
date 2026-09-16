param(
  [string]$PublishDir = (Join-Path $PSScriptRoot "publish")
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw "dotnet (.NET 8 SDK) not found in PATH. Install it from https://dotnet.microsoft.com/download, or use the Python host instead: powershell -ExecutionPolicy Bypass -File .\native-host\python-host\install-python-host.ps1"
}

dotnet publish (Join-Path $PSScriptRoot "native-host.csproj") -c Release -o $PublishDir

Write-Host "Published host to $PublishDir"
