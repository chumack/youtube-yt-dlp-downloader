#!/usr/bin/env python3
"""Python port of the fengjunda888/youtube-download-extension native host (Program.cs).

Same Chrome Native Messaging protocol (u32 LE length prefix + UTF-8 JSON):
  actions: resolve | start | list | cancel

Runs with stdlib only (Python 3.8+). Launched via YouTubeYtDlpHost.exe which
forwards Chrome's stdio pipes to this script.

Differences vs the C# host (all intentional):
  * resolve -> videos use lowercase keys (id/url/title/uploader/duration/index)
    because extension/popup.js renderVideos() reads lowercase fields.
    The C# host sends PascalCase here, so the video list renders "undefined".
  * default download dir: "%USERPROFILE%\\Desktop\\youtube videos" sent by the
    popup is resolved to the real localized Desktop instead of creating a
    bogus relative folder.
  * cookies: the popup reads YouTube cookies via the chrome.cookies API and
    sends them as Netscape cookies.txt (cookiesTxt), because browser cookie
    databases are locked while the browser runs. The host writes them to a
    temp file and passes --cookies to yt-dlp. If useBrowserCookies is set but
    no cookiesTxt arrived, falls back to --cookies-from-browser autodetect.
  * hardening: --impersonate chrome is added whenever curl_cffi is importable;
    YouTube anti-bot errors get a Russian hint appended (BOT_HINT).
"""

import ctypes
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime, timezone
from urllib.parse import urlparse

HOST_NAME = "com.fengj.youtube_ytdlp"
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
RESOLVE_TIMEOUT = 60
OUTPUT_TEMPLATE = "%(playlist_index&{} - |)s%(title).120B [%(id)s].%(ext)s"

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

tasks = {}
tasks_lock = threading.Lock()
stdout_lock = threading.Lock()

STDIN = sys.stdin.buffer
STDOUT = sys.stdout.buffer


def log_error(text):
    try:
        log_path = os.path.join(
            os.environ.get("TEMP", os.path.expanduser("~")), "yt_dlp_host_py.log"
        )
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(time.strftime("[%Y-%m-%d %H:%M:%S] ") + text + "\n")
    except Exception:
        pass


def diag(msg):
    try:
        log_path = os.path.join(
            os.environ.get("TEMP", tempfile.gettempdir()), "yt_dlp_host_py.log"
        )
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(
                "%s pid=%d %s\n"
                % (datetime.now().isoformat(timespec="seconds"), os.getpid(), msg)
            )
    except Exception:
        pass


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat()


# ---------------------------------------------------------------- protocol

def read_message():
    raw_len = STDIN.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    data = b""
    while len(data) < length:
        chunk = STDIN.read(length - len(data))
        if not chunk:
            break
        data += chunk
    return data.decode("utf-8", errors="replace")


def write_response(payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    with stdout_lock:
        STDOUT.write(struct.pack("<I", len(data)))
        STDOUT.write(data)
        STDOUT.flush()


def with_request_id(request_id, payload):
    out = {"requestId": request_id}
    out.update(payload)
    return out


# ---------------------------------------------------------------- helpers

def is_youtube_url(value):
    try:
        host = (urlparse(value).hostname or "").lower()
        return host in YOUTUBE_HOSTS
    except Exception:
        return False


def desktop_dir():
    try:
        buf = ctypes.create_unicode_buffer(260)
        # CSIDL_DESKTOPDIRECTORY = 0x0000
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0x0000, None, 0, buf) == 0:
            if buf.value:
                return buf.value
    except Exception:
        pass
    return os.path.join(os.path.expanduser("~"), "Desktop")


def resolve_download_dir(requested):
    default = os.path.join(desktop_dir(), "youtube videos")
    if not requested or not str(requested).strip():
        os.makedirs(default, exist_ok=True)
        return default
    path = os.path.expandvars(str(requested).strip())
    if not os.path.isabs(path):
        path = os.path.join(desktop_dir(), path)
    try:
        os.makedirs(path, exist_ok=True)
        return path
    except Exception:
        os.makedirs(default, exist_ok=True)
        return default


def resolve_ytdlp_path():
    env_path = os.environ.get("YTDLP_PATH", "").strip()
    if env_path and os.path.isfile(env_path):
        return env_path
    found = shutil.which("yt-dlp")
    if found:
        return found
    return "yt-dlp"


_impersonate_cache = {}
_node_cache = {}


def impersonate_args():
    """['--impersonate', 'chrome'] when curl_cffi is available, else []."""
    if "ok" not in _impersonate_cache:
        try:
            __import__("curl_cffi")
            _impersonate_cache["ok"] = True
        except Exception:
            _impersonate_cache["ok"] = False
    return ["--impersonate", "chrome"] if _impersonate_cache["ok"] else []


def js_runtime_args():
    """['--js-runtimes', 'node'] when node is on PATH, else [].

    yt-dlp 2026 needs an explicit JS runtime for YouTube challenge solving;
    deno alone is default, node must be opted in.
    """
    if "ok" not in _node_cache:
        _node_cache["ok"] = bool(shutil.which("node"))
    return ["--js-runtimes", "node"] if _node_cache["ok"] else []


def base_args():
    return ["--ignore-config"] + impersonate_args() + js_runtime_args()


BOT_PATTERNS = (
    "sign in to confirm",
    "not a bot",
    "needs to be reloaded",
    "verify you are",
    "confirm you",
    "http error 429",
    "too many requests",
    "po token",
    "login required",
)

BOT_HINT = (
    "YouTube защищается от ботов: включи «Использовать вход в браузере», "
    "войди в аккаунт YouTube в этом браузере и повтори."
)


def with_bot_hint(text):
    if text and any(p in text.lower() for p in BOT_PATTERNS):
        return BOT_HINT + " " + text
    return text


def write_cookies_file(txt):
    path = os.path.join(
        os.environ.get("TEMP", tempfile.gettempdir()), "yt_dlp_host_cookies.txt"
    )
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(txt if txt.endswith("\n") else txt + "\n")
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass
    return path


def cookie_db_paths(user_data):
    cands = []
    for profile in ("Default", "Profile 1"):
        cands.append(os.path.join(user_data, profile, "Network", "Cookies"))
        cands.append(os.path.join(user_data, profile, "Cookies"))
    cands.append(os.path.join(user_data, "Network", "Cookies"))
    cands.append(os.path.join(user_data, "Cookies"))
    return cands


def find_cookie_source():
    """Pick a --cookies-from-browser spec by existing cookie DB. Returns
    (flag, spec, label) or (None, None, None)."""
    local = os.environ.get("LOCALAPPDATA", "")
    appdata = os.environ.get("APPDATA", "")
    cands = [
        ("vivaldi", os.path.join(local, "Vivaldi", "User Data")),
        ("edge", os.path.join(local, "Microsoft", "Edge", "User Data")),
        ("chrome", os.path.join(local, "Google", "Chrome", "User Data")),
        ("chromium", os.path.join(local, "Chromium", "User Data")),
        ("brave", os.path.join(local, "BraveSoftware", "Brave-Browser", "User Data")),
        ("opera", os.path.join(appdata, "Opera Software", "Opera Stable")),
    ]
    for key, base in cands:
        for db in cookie_db_paths(base):
            if os.path.isfile(db):
                return ("--cookies-from-browser", key, key)
    # Yandex has no native yt-dlp key: address its profile through chromium.
    yb = os.path.join(local, "Yandex", "YandexBrowser", "User Data")
    for db in cookie_db_paths(yb):
        if os.path.isfile(db):
            parent = os.path.dirname(db)
            profile_dir = (
                os.path.dirname(parent)
                if os.path.basename(parent).lower() == "network"
                else parent
            )
            return ("--cookies-from-browser", "chromium:" + profile_dir, "yandex")
    return (None, None, None)


def cookie_args(root):
    """Returns (extra_yt_dlp_args, cookies_from_label, cookies_sent_count)."""
    txt = root.get("cookiesTxt")
    if isinstance(txt, str) and txt.strip():
        count = sum(
            1
            for line in txt.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        )
        return (["--cookies", write_cookies_file(txt)], "extension", count)
    if root.get("useBrowserCookies"):
        flag, spec, label = find_cookie_source()
        if spec:
            return ([flag, spec], label, 0)
        return ([], "none-found", 0)
    return ([], None, 0)


def fmt_duration(value):
    try:
        seconds = int(float(value))
    except (TypeError, ValueError):
        return ""
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return "%d:%02d:%02d" % (h, m, s)
    return "%d:%02d" % (m, s)


def get_str(obj, name):
    if isinstance(obj, dict):
        val = obj.get(name)
        return val if isinstance(val, str) else None
    return None


def get_int(obj, name):
    if isinstance(obj, dict):
        val = obj.get(name)
        if isinstance(val, bool):
            return None
        if isinstance(val, int):
            return val
        if isinstance(val, float) and val.is_integer():
            return int(val)
    return None


def snapshot(task):
    with tasks_lock:
        return dict(task)


# ---------------------------------------------------------------- resolve

def resolve_entry_url(entry):
    webpage_url = get_str(entry, "webpage_url")
    if webpage_url:
        return webpage_url
    url = get_str(entry, "url")
    if url and is_youtube_url(url):
        return url
    vid = get_str(entry, "id") or url
    if not vid:
        return None
    return "https://www.youtube.com/watch?v=%s" % vid


def action_resolve(root):
    url = root.get("url") or ""
    if not is_youtube_url(url):
        return {"ok": False, "error": "Only YouTube URLs are supported."}
    cookie_extra, cookies_from, cookies_sent = cookie_args(root)
    try:
        info = dump_info_json(url, cookie_extra, flat=True)
    except FileNotFoundError:
        return {"ok": False, "error": "yt-dlp not found. Install yt-dlp or set YTDLP_PATH."}
    except RuntimeError as ex:
        return {"ok": False, "error": with_bot_hint(str(ex)), "cookiesFrom": cookies_from}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}

    title = get_str(info, "title")
    entries = info.get("entries")
    videos = []
    if isinstance(entries, list):
        source_type = "playlist"
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            video_url = resolve_entry_url(entry)
            if not video_url:
                continue
            videos.append(
                {
                    "id": get_str(entry, "id") or "",
                    "url": video_url,
                    "title": get_str(entry, "title") or video_url,
                    "uploader": get_str(entry, "uploader")
                    or get_str(entry, "channel")
                    or "",
                    "duration": fmt_duration(entry.get("duration")),
                    "index": get_int(entry, "playlist_index") or (len(videos) + 1),
                }
            )
    else:
        source_type = "video"
        videos.append(
            {
                "id": get_str(info, "id") or "",
                "url": get_str(info, "webpage_url") or url,
                "title": title or url,
                "uploader": get_str(info, "uploader") or get_str(info, "channel") or "",
                "duration": fmt_duration(info.get("duration")),
                "index": 1,
            }
        )
    # Для одиночного видео вторым проходом читаем полные форматы,
    # чтобы показать доступные аудиодорожки (языки дубляжа).
    # Ошибка второго прохода не роняет resolve.
    audio_tracks = []
    orig_lang = ""
    if source_type == "video":
        try:
            full = dump_info_json(url, cookie_extra, flat=False)
            audio_tracks, orig_lang = extract_audio_tracks(full)
        except Exception as ex:
            diag("tracks failed: %s" % ex)
    return {
        "ok": True,
        "title": title or url,
        "sourceType": source_type,
        "count": len(videos),
        "videos": videos,
        "audioTracks": audio_tracks,
        "origLang": orig_lang,
        "cookiesFrom": cookies_from,
        "cookiesSent": cookies_sent,
    }


# ---------------------------------------------------------------- download

def normalize_quality(value):
    if value == "audio":
        return "audio-mp3"
    return value or "best-mp4"


def normalize_vcodec(value):
    v = str(value or "auto").lower()
    if v in ("av1", "av01"):
        return "av1"
    if v in ("vp9", "vp09"):
        return "vp9"
    if v in ("avc", "avc1", "h264"):
        return "avc"
    return "auto"


def vcodec_filter(vcodec):
    if vcodec == "av1":
        return "[vcodec^=av01]"
    if vcodec == "vp9":
        return "[vcodec^=vp09]"
    if vcodec == "avc":
        return "[vcodec^=avc1]"
    return ""


VIDEO_HEIGHTS = {
    "4320": 4320,
    "2160": 2160,
    "1440": 1440,
    "1080": 1080,
    "720": 720,
    "480": 480,
    "360": 360,
    "240": 240,
    "144": 144,
}

AUDIO_FORMATS = {"mp3", "m4a", "opus", "wav", "best"}

# Допустимые значения битрейта для lossy-аудио (ffmpeg --audio-quality).
# "0" = лучшее качество (VBR), остальные — фиксированный битрейт.
AUDIO_BITRATES = {"0", "64K", "96K", "128K", "192K", "256K", "320K"}

# Аудиоформаты, для которых битрейт имеет смысл (lossy с энкодером).
BITRATE_FORMATS = {"mp3", "m4a", "opus"}

TRACK_MODES = {"orig", "dub", "dual"}

LANG_RE = re.compile(r"^[a-z]{2,3}(?:-[A-Za-z]+)*$")


def normalize_abitrate(value):
    v = str(value or "0").strip().upper()
    if v.endswith("K") and v[:-1].isdigit():
        v = v
    elif v.isdigit():
        v = v + "K" if v != "0" else "0"
    return v if v in AUDIO_BITRATES else "0"


def normalize_track_mode(value):
    v = str(value or "orig").strip().lower()
    return v if v in TRACK_MODES else "orig"


def normalize_lang(value):
    v = str(value or "").strip()
    if not v or not LANG_RE.match(v):
        return ""
    # Сохраняем регистр субтега (zh-Hans), основной код — строчными.
    parts = v.split("-")
    return "-".join([parts[0].lower()] + parts[1:])


def extract_audio_tracks(info):
    """Дорожки из полного -J: [{'lang','label','original'}], orig_lang.

    Оригиналом считается дорожка на языке видео (info.language)
    либо с пометкой 'original' в format_note.
    """
    video_lang = normalize_lang(info.get("language"))
    by_lang = {}
    for f in info.get("formats") or []:
        if not isinstance(f, dict):
            continue
        if f.get("vcodec") != "none" or f.get("acodec") == "none":
            continue
        lang = normalize_lang(f.get("language"))
        if not lang:
            continue
        note = str(f.get("format_note") or "")
        if lang not in by_lang:
            by_lang[lang] = {"lang": lang, "label": note or lang,
                             "original": False, "_note": note}
    tracks = []
    orig_lang = ""
    for lang, t in by_lang.items():
        is_orig = bool(
            (video_lang and lang.lower() == video_lang.lower())
            or "original" in t["_note"].lower()
        )
        if is_orig and not orig_lang:
            orig_lang = lang
        t = {"lang": t["lang"], "label": t["label"], "original": is_orig}
        tracks.append(t)
    tracks.sort(key=lambda t: (not t["original"], t["lang"]))
    if not orig_lang and tracks:
        # Хотя бы язык видео обычно первый; иначе оригинал неизвестен.
        pass
    return tracks, orig_lang


def dump_info_json(url, cookie_extra, flat):
    """Запуск yt-dlp -J. Возвращает info dict, бросает RuntimeError/FileNotFoundError."""
    args = base_args()
    args += ["--dump-single-json", "--skip-download", "--no-warnings"]
    if flat:
        args.append("--flat-playlist")
    args += cookie_extra
    args.append(url)
    try:
        proc = subprocess.Popen(
            [resolve_ytdlp_path()] + args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=CREATE_NO_WINDOW,
        )
    except FileNotFoundError:
        raise
    try:
        stdout, stderr = proc.communicate(timeout=RESOLVE_TIMEOUT)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
        raise RuntimeError("Timed out while resolving the URL.")
    if proc.returncode != 0:
        err = (stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(err or "yt-dlp exited with code %d" % proc.returncode)
    return json.loads((stdout or b"").decode("utf-8", errors="replace"))


def build_ytdlp_args(url, output_template, quality, playlist_mode, vcodec="auto",
                     abitrate="0", track_mode="orig", dub_lang="", orig_lang=""):
    quality = normalize_quality(quality)
    vcodec = normalize_vcodec(vcodec)
    # Кодек применяется только к видео; для аудио игнорируется.
    if quality.startswith("audio-"):
        vcodec = "auto"
    codec = vcodec_filter(vcodec)

    abitrate = normalize_abitrate(abitrate)
    track_mode = normalize_track_mode(track_mode)
    dub_lang = normalize_lang(dub_lang)
    orig_lang = normalize_lang(orig_lang)
    # "Лучший MP4 одним файлом" — всегда оригинал; dual для аудио
    # невозможен (один аудиофайл) — скачиваем дубляж отдельно.
    is_audio = quality.startswith("audio-")
    if quality == "best-mp4":
        track_mode = "orig"
    if is_audio and track_mode == "dual":
        track_mode = "dub"
    if track_mode in ("dub", "dual") and not dub_lang:
        track_mode = "orig"

    dub_f = "[language=%s]" % dub_lang if track_mode in ("dub", "dual") else ""
    orig_f = "[language=%s]" % orig_lang if (track_mode == "dual" and orig_lang) else ""

    fmt = ""
    merge_args = []
    stream_args = []
    audio_post = []

    if quality in VIDEO_HEIGHTS:
        h = VIDEO_HEIGHTS[quality]
        if track_mode == "dual":
            fmt = (
                "bestvideo[height<=%d]%s+bestaudio%s+bestaudio%s/"
                "bestvideo%s+bestaudio%s+bestaudio%s"
                % (h, codec, orig_f, dub_f, codec, orig_f, dub_f)
            )
            merge_args = ["--merge-output-format", "mkv"]
            stream_args = ["--audio-multistreams"]
        elif track_mode == "dub":
            fmt = (
                "bestvideo[height<=%d]%s+bestaudio%s/"
                "bestvideo%s+bestaudio%s" % (h, codec, dub_f, codec, dub_f)
            )
            merge_args = ["--merge-output-format", "mp4"]
        elif codec:
            fmt = (
                "bestvideo[height<=%d]%s+bestaudio/"
                "bestvideo[height<=%d]%s/"
                "bestvideo[height<=%d]+bestaudio/"
                "best[height<=%d]/best" % (h, codec, h, codec, h, h)
            )
            merge_args = ["--merge-output-format", "mp4"]
        else:
            fmt = (
                "bestvideo[height<=%d]+bestaudio/"
                "best[height<=%d]/best" % (h, h)
            )
            merge_args = ["--merge-output-format", "mp4"]
    elif quality == "best":
        if track_mode == "dual":
            fmt = (
                "bestvideo%s+bestaudio%s+bestaudio%s/"
                "bestvideo+bestaudio+bestaudio" % (codec, orig_f, dub_f)
            )
            merge_args = ["--merge-output-format", "mkv"]
            stream_args = ["--audio-multistreams"]
        elif track_mode == "dub":
            fmt = "bestvideo%s+bestaudio%s/bestvideo+bestaudio" % (codec, dub_f)
            merge_args = ["--merge-output-format", "mp4"]
        elif codec:
            fmt = (
                "bestvideo%s+bestaudio/"
                "bestvideo%s/"
                "bestvideo+bestaudio/best" % (codec, codec)
            )
            merge_args = ["--merge-output-format", "mp4"]
        else:
            fmt = "bestvideo+bestaudio/best"
            merge_args = ["--merge-output-format", "mp4"]
    elif quality == "best-mp4":
        if codec:
            fmt = "best[ext=mp4]%s/best[ext=mp4]/best" % codec
        else:
            fmt = "best[ext=mp4]/best"
    elif is_audio:
        aformat = quality.split("-", 1)[1] if "-" in quality else "mp3"
        if aformat not in AUDIO_FORMATS:
            aformat = "mp3"
        if track_mode == "dub":
            fmt = "bestaudio%s" % dub_f
        else:
            fmt = "bestaudio/best"
        if aformat != "best":
            audio_post = ["-x", "--audio-format", aformat]
            if aformat in BITRATE_FORMATS:
                audio_post += ["--audio-quality", abitrate]
    else:
        fmt = "best[ext=mp4]/best"

    args = base_args()
    args += [
        "--no-overwrites",
        "--newline",
        "--progress",
        "-f",
        fmt,
        "-o",
        output_template,
    ]
    args += merge_args
    args += stream_args
    if playlist_mode == "playlist":
        args.append("--yes-playlist")
    else:
        args.append("--no-playlist")
    args += audio_post
    args.append(url)
    return args


PCT_RE = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")
ETA_RE = re.compile(r"ETA\s+([0-9:]+|Unknown)")
SPEED_RE = re.compile(r"at\s+(\S+/s)")


def handle_ytdlp_line(line, task_id, log_lock, log_file):
    if not line or not line.strip():
        return
    with log_lock:
        try:
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass
    with tasks_lock:
        task = tasks.get(task_id)
        if task is None:
            return
        task["LastLine"] = line
        task["UpdatedAt"] = now_iso()
        low = line.lower()
        if "[download] destination:" in low or "[download] resuming download" in low:
            task["Status"] = "running"
            task["Message"] = line
        m = PCT_RE.search(line)
        if m:
            try:
                task["Percent"] = float(m.group(1))
                task["Status"] = "running"
            except ValueError:
                pass
        m = ETA_RE.search(line)
        if m:
            task["Eta"] = m.group(1)
        m = SPEED_RE.search(line)
        if m:
            task["Speed"] = m.group(1)


def pump_process(proc, task_id, log_file):
    log_lock = threading.Lock()

    def reader(stream):
        try:
            for line in iter(stream.readline, ""):
                handle_ytdlp_line(line.rstrip("\r\n"), task_id, log_lock, log_file)
        except Exception:
            pass
        finally:
            try:
                stream.close()
            except Exception:
                pass

    threads = [
        threading.Thread(target=reader, args=(proc.stdout,), daemon=True),
        threading.Thread(target=reader, args=(proc.stderr,), daemon=True),
    ]
    for t in threads:
        t.start()
    code = proc.wait()
    for t in threads:
        t.join(timeout=5)
    with log_lock:
        try:
            with open(log_file, "a", encoding="utf-8") as f:
                f.write("exit_code=%s\n" % code)
        except Exception:
            pass
    with tasks_lock:
        task = tasks.get(task_id)
        if task is None:
            return
        task["ExitCode"] = code
        task["UpdatedAt"] = now_iso()
        if task.get("Status") != "canceled":
            if code == 0:
                task["Status"] = "done"
                task["Message"] = "Finished"
            else:
                task["Status"] = "error"
                raw = task.get("LastLine") or "yt-dlp exited with code %s" % code
                task["Message"] = with_bot_hint(raw)
                # popup prefers LastLine: put the hint where it is visible
                task["LastLine"] = task["Message"]
        diag("final id=%s status=%s code=%s" % (task_id, task.get("Status"), code))


def action_start(root):
    url = root.get("url") or ""
    if not is_youtube_url(url):
        return {"ok": False, "error": "Only YouTube URLs are supported."}
    download_dir = root.get("downloadDir")
    playlist_mode = root.get("playlistMode") or "single"
    quality = normalize_quality(root.get("quality") or "best-mp4")
    vcodec = normalize_vcodec(root.get("vcodec") or "auto")
    abitrate = normalize_abitrate(root.get("abitrate") or "0")
    track_mode = normalize_track_mode(root.get("trackMode") or "orig")
    dub_lang = normalize_lang(root.get("dubLang") or "")
    orig_lang = normalize_lang(root.get("origLang") or "")
    target_dir = resolve_download_dir(download_dir)
    log_dir = os.path.join(target_dir, "yt-dlp-logs")
    os.makedirs(log_dir, exist_ok=True)

    task_id = str(int(time.time() * 1000))
    log_file = os.path.join(log_dir, "download-%s.log" % task_id)
    output_template = os.path.join(
        target_dir, "%(playlist_index&{} - |)s%(title).120B [%(id)s].%(ext)s"
    )
    cookie_extra, cookies_from, cookies_sent = cookie_args(root)
    task = {
        "Id": task_id,
        "Url": url,
        "DownloadDir": target_dir,
        "Quality": quality,
        "Vcodec": vcodec,
        "Abitrate": abitrate,
        "TrackMode": track_mode,
        "DubLang": dub_lang,
        "PlaylistMode": playlist_mode,
        "LogFile": log_file,
        "Status": "starting",
        "Message": "",
        "LastLine": "",
        "Eta": "",
        "Speed": "",
        "Percent": 0.0,
        "CookiesFrom": cookies_from or "",
        "CookiesSent": cookies_sent,
        "ProcessId": None,
        "ExitCode": None,
        "StartedAt": now_iso(),
        "UpdatedAt": now_iso(),
    }
    with tasks_lock:
        tasks[task_id] = task

    args = build_ytdlp_args(url, output_template, quality, playlist_mode, vcodec,
                            abitrate, track_mode, dub_lang, orig_lang)
    # --cookies* must come before the URL (order is free, keep them grouped)
    args = args[:-1] + cookie_extra + args[-1:]
    try:
        proc = subprocess.Popen(
            [resolve_ytdlp_path()] + args,
            cwd=target_dir,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=CREATE_NO_WINDOW,
        )
    except FileNotFoundError:
        with tasks_lock:
            task["Status"] = "error"
            task["Message"] = "yt-dlp not found. Install yt-dlp or set YTDLP_PATH."
        return {
            "ok": False,
            "error": "yt-dlp not found. Install yt-dlp or set YTDLP_PATH.",
            "task": snapshot(task),
        }
    except Exception as ex:
        with tasks_lock:
            task["Status"] = "error"
            task["Message"] = str(ex)
        return {"ok": False, "error": str(ex), "task": snapshot(task)}

    with tasks_lock:
        task["ProcessId"] = proc.pid
        task["Status"] = "running"
    diag("start id=%s pid=%s quality=%s vcodec=%s abitrate=%s track=%s dub=%s cookiesFrom=%s" % (task_id, proc.pid, quality, vcodec, abitrate, track_mode, dub_lang, cookies_from))
    t = threading.Thread(target=pump_process, args=(proc, task_id, log_file), daemon=True)
    t.start()
    return {"ok": True, "task": snapshot(task)}


def action_list():
    with tasks_lock:
        ordered = sorted(
            (dict(t) for t in tasks.values()),
            key=lambda t: t.get("StartedAt", ""),
            reverse=True,
        )
    diag("list count=%d" % len(ordered))
    return {"ok": True, "tasks": ordered}


def action_cancel(root):
    task_id = root.get("id")
    with tasks_lock:
        task = tasks.get(task_id)
    if not task_id or task is None:
        return {"ok": False, "error": "Task not found."}
    pid = task.get("ProcessId")
    if pid:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW,
            )
        except Exception:
            pass
    with tasks_lock:
        task["Status"] = "canceled"
        task["Message"] = "Canceled"
        task["UpdatedAt"] = now_iso()
        return {"ok": True, "task": dict(task)}


# ---------------------------------------------------------------- main loop

def main():
    while True:
        message = read_message()
        if message is None:
            break
        try:
            root = json.loads(message)
            if not isinstance(root, dict):
                raise ValueError("Invalid request.")
            action = root.get("action") or ""
            request_id = root.get("requestId")
            diag("req action=%s requestId=%s" % (action, request_id))
            if action == "resolve":
                payload = action_resolve(root)
            elif action == "start":
                payload = action_start(root)
            elif action == "list":
                payload = action_list()
            elif action == "cancel":
                payload = action_cancel(root)
            else:
                payload = {"ok": False, "error": "Unknown action."}
            write_response(with_request_id(request_id, payload))
        except Exception as ex:
            log_error(traceback.format_exc())
            try:
                write_response({"ok": False, "error": str(ex)})
            except Exception:
                break


if __name__ == "__main__":
    main()
