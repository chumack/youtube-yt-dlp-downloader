#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISH_DIR="${PUBLISH_DIR:-"$SCRIPT_DIR/publish"}"

if ! command -v dotnet >/dev/null 2>&1; then
  echo "ERROR: dotnet (.NET 8 SDK) not found in PATH." >&2
  echo "Install it from https://dotnet.microsoft.com/download and retry." >&2
  exit 1
fi

dotnet publish "$SCRIPT_DIR/native-host.csproj" -c Release -o "$PUBLISH_DIR"
chmod +x "$PUBLISH_DIR/YouTubeYtDlpHost"

echo "Published host to $PUBLISH_DIR"
