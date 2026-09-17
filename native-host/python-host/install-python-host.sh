#!/usr/bin/env bash
# Installs the Python-based native host on Linux/macOS (no .NET SDK required).
# Run: ./native-host/python-host/install-python-host.sh
# Env: EXTENSION_ID, PUBLISH_DIR, YTDLP_HOST_PYTHON
set -euo pipefail

EXTENSION_ID="${EXTENSION_ID:-lgdfehfacdnpknkphkfmmollklciaaal}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISH_DIR="${PUBLISH_DIR:-"$(cd "$SCRIPT_DIR/.." && pwd)/publish"}"
HOST_NAME="com.fengj.youtube_ytdlp"

PYTHON_BIN="${YTDLP_HOST_PYTHON:-$(command -v python3 || true)}"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "ERROR: python3 not found in PATH. Install Python 3.8+ and retry." >&2
  exit 1
fi

mkdir -p "$PUBLISH_DIR"
cp -f "$SCRIPT_DIR/host.py" "$PUBLISH_DIR/host.py"
chmod +x "$PUBLISH_DIR/host.py"

HOST_EXE="$PUBLISH_DIR/YouTubeYtDlpHost"
cat > "$HOST_EXE" <<WRAPPER
#!/usr/bin/env bash
exec "$PYTHON_BIN" "$PUBLISH_DIR/host.py"
WRAPPER
chmod +x "$HOST_EXE"

if command -v yt-dlp >/dev/null 2>&1; then
  echo "yt-dlp: $(command -v yt-dlp) ($(yt-dlp --version 2>/dev/null || echo unknown))"
elif [[ -n "${YTDLP_PATH:-}" && -f "${YTDLP_PATH:-}" ]]; then
  echo "yt-dlp: $YTDLP_PATH (via YTDLP_PATH)"
else
  echo "WARNING: yt-dlp not found in PATH and YTDLP_PATH is not set." >&2
  echo "Install yt-dlp (e.g. 'sudo pacman -S yt-dlp') or set YTDLP_PATH." >&2
fi

if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg: $(command -v ffmpeg)"
elif [[ -n "${FFMPEG_PATH:-}" && -f "${FFMPEG_PATH:-}" ]]; then
  echo "ffmpeg: $FFMPEG_PATH (via FFMPEG_PATH)"
else
  echo "WARNING: ffmpeg not found in PATH and FFMPEG_PATH is not set." >&2
  echo "Merging video+audio will fail. Install ffmpeg with your package" >&2
  echo "manager (e.g. 'sudo pacman -S ffmpeg') or set FFMPEG_PATH." >&2
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
    echo "Unsupported OS: $(uname -s)" >&2
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

echo "Host executable:"
echo "$HOST_EXE"
echo "Extension ID:"
echo "$EXTENSION_ID"
echo "Restart the browser, then reload the extension."
