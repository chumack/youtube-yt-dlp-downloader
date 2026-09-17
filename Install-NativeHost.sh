#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Like Install-NativeHost.bat: prefer the C# host when the .NET 8 SDK is
# present, otherwise fall back to the Python host (no compilation needed).
if command -v dotnet >/dev/null 2>&1; then
  echo "Found .NET SDK - building the C# host."
  "$ROOT_DIR/native-host/build-host.sh"
  "$ROOT_DIR/native-host/install-native-host.sh"
elif command -v python3 >/dev/null 2>&1; then
  echo ".NET SDK (dotnet) not found - using the Python host instead."
  "$ROOT_DIR/native-host/python-host/install-python-host.sh"
else
  echo "ERROR: neither 'dotnet' nor 'python3' was found in PATH." >&2
  echo "Install Python 3.8+ with your package manager, then run this file again." >&2
  exit 1
fi
