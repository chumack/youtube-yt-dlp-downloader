#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ID="${EXTENSION_ID:-lgdfehfacdnpknkphkfmmollklciaaal}"
PUBLISH_DIR="${PUBLISH_DIR:-"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/publish"}"
HOST_NAME="com.fengj.youtube_ytdlp"
HOST_EXE="$PUBLISH_DIR/YouTubeYtDlpHost"

if [[ ! -x "$HOST_EXE" ]]; then
  echo "Native host executable not found: $HOST_EXE"
  echo "Run ./native-host/build-host.sh first."
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    CONFIG_BASES=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
      "$HOME/Library/Application Support/Opera Software/Opera Stable/NativeMessagingHosts"
      "$HOME/Library/Application Support/Yandex/NativeMessagingHosts"
    )
    ;;
  Linux)
    CONFIG_BASES=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/.config/vivaldi/NativeMessagingHosts"
      "$HOME/.config/opera/NativeMessagingHosts"
      "$HOME/.config/yandex-browser/NativeMessagingHosts"
    )
    ;;
  *)
    echo "Unsupported OS: $(uname -s)"
    exit 1
    ;;
esac

for MANIFEST_DIR in "${CONFIG_BASES[@]}"; do
  mkdir -p "$MANIFEST_DIR"
  MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"

  cat > "$MANIFEST_PATH" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Native host for downloading YouTube videos with yt-dlp",
  "path": "$HOST_EXE",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
JSON

  echo "Installed native host manifest:"
  echo "$MANIFEST_PATH"
done

echo "Extension ID:"
echo "$EXTENSION_ID"
echo "Restart the browser, then reload the extension."
