using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

var tasks = new ConcurrentDictionary<string, DownloadTask>();
var input = Console.OpenStandardInput();
var output = Console.OpenStandardOutput();
var outputLock = new object();

while (true)
{
  var message = ReadMessage(input);
  if (message is null)
  {
    break;
  }

  try
  {
    var root = JsonDocument.Parse(message).RootElement;
    var action = root.GetProperty("action").GetString() ?? "";
    var requestId = root.TryGetProperty("requestId", out var requestIdProp) ? requestIdProp.GetString() : null;

    switch (action)
    {
      case "resolve":
        WriteResponse(output, outputLock, WithRequestId(requestId, ResolveVideos(root)));
        break;
      case "start":
        WriteResponse(output, outputLock, WithRequestId(requestId, StartDownload(root, tasks)));
        break;
      case "list":
        WriteResponse(output, outputLock, WithRequestId(requestId, new { ok = true, tasks = tasks.Values.OrderByDescending(t => t.StartedAt).ToArray() }));
        break;
      case "cancel":
        WriteResponse(output, outputLock, WithRequestId(requestId, CancelDownload(root, tasks)));
        break;
      case "clear":
        WriteResponse(output, outputLock, WithRequestId(requestId, ClearDownloads(tasks)));
        break;
      default:
        WriteResponse(output, outputLock, WithRequestId(requestId, new { ok = false, error = "Unknown action." }));
        break;
    }
  }
  catch (Exception ex)
  {
    WriteResponse(output, outputLock, new { ok = false, error = ex.Message });
  }
}

static object StartDownload(JsonElement root, ConcurrentDictionary<string, DownloadTask> tasks)
{
  var url = root.GetProperty("url").GetString() ?? "";
  if (!IsYouTubeUrl(url))
  {
    return new { ok = false, error = "Only YouTube URLs are supported." };
  }

  var downloadDir = root.TryGetProperty("downloadDir", out var dirProp) ? dirProp.GetString() : null;
  var playlistMode = root.TryGetProperty("playlistMode", out var playlistProp) ? playlistProp.GetString() : "single";
  var quality = NormalizeQuality(root.TryGetProperty("quality", out var qualityProp) ? qualityProp.GetString() : "best-mp4");
  var vcodec = NormalizeVcodec(root.TryGetProperty("vcodec", out var vcodecProp) ? vcodecProp.GetString() : "auto");
  var abitrate = NormalizeAbitrate(root.TryGetProperty("abitrate", out var abitrateProp) ? abitrateProp.GetString() : "0");
  var trackMode = NormalizeTrackMode(root.TryGetProperty("trackMode", out var trackModeProp) ? trackModeProp.GetString() : "orig");
  var dubLang = NormalizeLang(root.TryGetProperty("dubLang", out var dubLangProp) ? dubLangProp.GetString() : "");
  var origLang = NormalizeLang(root.TryGetProperty("origLang", out var origLangProp) ? origLangProp.GetString() : "");
  var targetDir = ResolveDownloadDir(downloadDir);
  var logDir = Path.Combine(targetDir, "yt-dlp-logs");
  Directory.CreateDirectory(logDir);

  var id = DateTimeOffset.Now.ToUnixTimeMilliseconds().ToString();
  var logFile = Path.Combine(logDir, $"download-{id}.log");
  var outputTemplate = Path.Combine(targetDir, "%(playlist_index&{} - |)s%(title).120B [%(id)s].%(ext)s");
  var task = new DownloadTask
  {
    Id = id,
    Url = url,
    DownloadDir = targetDir,
    Quality = quality,
    Vcodec = vcodec,
    Abitrate = abitrate,
    TrackMode = trackMode,
    DubLang = dubLang,
    PlaylistMode = playlistMode ?? "single",
    LogFile = logFile,
    Status = "starting",
    StartedAt = DateTimeOffset.Now
  };
  tasks[id] = task;

  var args = BuildYtDlpArgs(url, outputTemplate, task.Quality, task.PlaylistMode, task.Vcodec,
    task.Abitrate, task.TrackMode, task.DubLang, origLang);
  var psi = new ProcessStartInfo
  {
    FileName = ResolveYtDlpPath(),
    WorkingDirectory = targetDir,
    UseShellExecute = false,
    RedirectStandardOutput = true,
    RedirectStandardError = true,
    CreateNoWindow = true
  };
  foreach (var arg in args)
  {
    psi.ArgumentList.Add(arg);
  }

  try
  {
    var process = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start yt-dlp.");
    task.ProcessId = process.Id;
    task.Status = "running";
    _ = PumpProcessAsync(process, task);
    return new { ok = true, task };
  }
  catch (Exception ex)
  {
    task.Status = "error";
    task.Message = ex.Message;
    return new { ok = false, error = ex.Message, task };
  }
}

static JsonDocument DumpInfoJson(string url, bool flat)
{
  var psi = new ProcessStartInfo
  {
    FileName = ResolveYtDlpPath(),
    UseShellExecute = false,
    RedirectStandardOutput = true,
    RedirectStandardError = true,
    CreateNoWindow = true
  };

  psi.ArgumentList.Add("--ignore-config");
  psi.ArgumentList.Add("--dump-single-json");
  if (flat)
  {
    psi.ArgumentList.Add("--flat-playlist");
  }
  psi.ArgumentList.Add("--skip-download");
  psi.ArgumentList.Add("--no-warnings");
  psi.ArgumentList.Add(url);

  using var process = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start yt-dlp.");
  var stdoutTask = process.StandardOutput.ReadToEndAsync();
  var stderrTask = process.StandardError.ReadToEndAsync();
  if (!process.WaitForExit(60000))
  {
    process.Kill(entireProcessTree: true);
    throw new TimeoutException("Timed out while resolving the URL.");
  }

  var stdout = stdoutTask.GetAwaiter().GetResult();
  var stderr = stderrTask.GetAwaiter().GetResult();
  if (process.ExitCode != 0)
  {
    throw new InvalidOperationException(string.IsNullOrWhiteSpace(stderr) ? $"yt-dlp exited with code {process.ExitCode}" : stderr.Trim());
  }

  return JsonDocument.Parse(stdout);
}

static (List<AudioTrack> Tracks, string OrigLang) ExtractAudioTracks(JsonElement info)
{
  var videoLang = NormalizeLang(GetString(info, "language"));
  var byLang = new Dictionary<string, (string Label, string Note)>(StringComparer.OrdinalIgnoreCase);
  if (info.TryGetProperty("formats", out var formats) && formats.ValueKind == JsonValueKind.Array)
  {
    foreach (var f in formats.EnumerateArray())
    {
      if (f.ValueKind != JsonValueKind.Object)
      {
        continue;
      }
      if (GetString(f, "vcodec") != "none" || GetString(f, "acodec") == "none")
      {
        continue;
      }
      var lang = NormalizeLang(GetString(f, "language"));
      if (string.IsNullOrEmpty(lang) || byLang.ContainsKey(lang))
      {
        continue;
      }
      var note = GetString(f, "format_note") ?? "";
      byLang[lang] = (string.IsNullOrWhiteSpace(note) ? lang : note, note);
    }
  }

  var tracks = new List<AudioTrack>();
  var origLang = "";
  foreach (var (lang, (label, note)) in byLang)
  {
    var isOrig = (!string.IsNullOrEmpty(videoLang) && lang.Equals(videoLang, StringComparison.OrdinalIgnoreCase))
      || note.Contains("original", StringComparison.OrdinalIgnoreCase);
    if (isOrig && string.IsNullOrEmpty(origLang))
    {
      origLang = lang;
    }
    tracks.Add(new AudioTrack { Lang = lang, Label = label, Original = isOrig });
  }
  tracks.Sort((a, b) =>
  {
    var c = b.Original.CompareTo(a.Original);
    return c != 0 ? c : string.Compare(a.Lang, b.Lang, StringComparison.OrdinalIgnoreCase);
  });
  return (tracks, origLang);
}

static object ResolveVideos(JsonElement root)
{
  var url = root.GetProperty("url").GetString() ?? "";
  if (!IsYouTubeUrl(url))
  {
    return new { ok = false, error = "Only YouTube URLs are supported." };
  }

  try
  {
    using var doc = DumpInfoJson(url, flat: true);
    var rootJson = doc.RootElement;
    var title = GetString(rootJson, "title");
    var sourceType = rootJson.TryGetProperty("entries", out var entries) && entries.ValueKind == JsonValueKind.Array ? "playlist" : "video";
    var videos = new List<ResolvedVideo>();

    if (sourceType == "playlist")
    {
      foreach (var entry in entries.EnumerateArray())
      {
        if (entry.ValueKind != JsonValueKind.Object)
        {
          continue;
        }
        var videoUrl = ResolveEntryUrl(entry);
        if (string.IsNullOrWhiteSpace(videoUrl))
        {
          continue;
        }
        videos.Add(new ResolvedVideo
        {
          Id = GetString(entry, "id") ?? "",
          Url = videoUrl,
          Title = GetString(entry, "title") ?? videoUrl,
          Uploader = GetString(entry, "uploader") ?? GetString(entry, "channel") ?? "",
          Duration = GetDuration(entry),
          Index = GetInt(entry, "playlist_index") ?? videos.Count + 1
        });
      }
    }
    else
    {
      videos.Add(new ResolvedVideo
      {
        Id = GetString(rootJson, "id") ?? "",
        Url = GetString(rootJson, "webpage_url") ?? url,
        Title = title ?? url,
        Uploader = GetString(rootJson, "uploader") ?? GetString(rootJson, "channel") ?? "",
        Duration = GetDuration(rootJson),
        Index = 1
      });
    }

    // Single video: second pass reads full formats for audio tracks (dub languages).
    // A failure here must not fail the whole resolve.
    var tracks = new List<AudioTrack>();
    var origLang = "";
    if (sourceType == "video")
    {
      try
      {
        using var full = DumpInfoJson(url, flat: false);
        (tracks, origLang) = ExtractAudioTracks(full.RootElement);
      }
      catch
      {
      }
    }

    return new { ok = true, title = title ?? url, sourceType, count = videos.Count, videos, audioTracks = tracks, origLang };
  }
  catch (Exception ex)
  {
    return new { ok = false, error = ex.Message };
  }
}

static string? ResolveEntryUrl(JsonElement entry)
{
  var webpageUrl = GetString(entry, "webpage_url");
  if (!string.IsNullOrWhiteSpace(webpageUrl))
  {
    return webpageUrl;
  }

  var url = GetString(entry, "url");
  if (!string.IsNullOrWhiteSpace(url) && IsYouTubeUrl(url))
  {
    return url;
  }

  var id = GetString(entry, "id") ?? url;
  return string.IsNullOrWhiteSpace(id) ? null : $"https://www.youtube.com/watch?v={id}";
}

static string? GetString(JsonElement element, string name)
{
  return element.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.String ? prop.GetString() : null;
}

static int? GetInt(JsonElement element, string name)
{
  return element.TryGetProperty(name, out var prop) && prop.TryGetInt32(out var value) ? value : null;
}

static string GetDuration(JsonElement element)
{
  if (!element.TryGetProperty("duration", out var prop))
  {
    return "";
  }

  double seconds;
  if (prop.ValueKind == JsonValueKind.Number && prop.TryGetDouble(out var number))
  {
    seconds = number;
  }
  else if (prop.ValueKind == JsonValueKind.String && double.TryParse(prop.GetString(), out var parsed))
  {
    seconds = parsed;
  }
  else
  {
    return "";
  }

  var time = TimeSpan.FromSeconds(seconds);
  return time.TotalHours >= 1 ? time.ToString(@"h\:mm\:ss") : time.ToString(@"m\:ss");
}

static object WithRequestId(string? requestId, object payload)
{
  var json = JsonSerializer.SerializeToElement(payload);
  using var doc = JsonDocument.Parse(json.GetRawText());
  var map = new Dictionary<string, object?> { ["requestId"] = requestId };
  foreach (var prop in doc.RootElement.EnumerateObject())
  {
    map[prop.Name] = prop.Value.Clone();
  }
  return map;
}

static object CancelDownload(JsonElement root, ConcurrentDictionary<string, DownloadTask> tasks)
{
  var id = root.TryGetProperty("id", out var idProp) ? idProp.GetString() : null;
  if (string.IsNullOrWhiteSpace(id) || !tasks.TryGetValue(id, out var task))
  {
    return new { ok = false, error = "Task not found." };
  }

  try
  {
    if (task.ProcessId is int pid)
    {
      Process.GetProcessById(pid).Kill(entireProcessTree: true);
    }
    task.Status = "canceled";
    task.Message = "Canceled";
    return new { ok = true, task };
  }
  catch (Exception ex)
  {
    return new { ok = false, error = ex.Message, task };
  }
}

static object ClearDownloads(ConcurrentDictionary<string, DownloadTask> tasks)
{
  var removed = 0;
  foreach (var (id, task) in tasks.ToArray())
  {
    if (task.Status is "done" or "error" or "canceled" && tasks.TryRemove(id, out _))
    {
      removed++;
    }
  }
  var left = tasks.Values.OrderByDescending(t => t.StartedAt).ToArray();
  return new { ok = true, removed, tasks = left };
}

static async Task PumpProcessAsync(Process process, DownloadTask task)
{
  await using var logStream = new FileStream(task.LogFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
  await using var writer = new StreamWriter(logStream, Encoding.UTF8) { AutoFlush = true };

  process.OutputDataReceived += (_, e) => HandleYtDlpLine(e.Data, task, writer);
  process.ErrorDataReceived += (_, e) => HandleYtDlpLine(e.Data, task, writer);
  process.BeginOutputReadLine();
  process.BeginErrorReadLine();
  await process.WaitForExitAsync();

  task.ExitCode = process.ExitCode;
  task.UpdatedAt = DateTimeOffset.Now;
  if (task.Status != "canceled")
  {
    task.Status = process.ExitCode == 0 ? "done" : "error";
    task.Message = process.ExitCode == 0 ? "Finished" : $"yt-dlp exited with code {process.ExitCode}";
  }
  await writer.WriteLineAsync($"exit_code={process.ExitCode}");
}

static void HandleYtDlpLine(string? line, DownloadTask task, StreamWriter writer)
{
  if (string.IsNullOrWhiteSpace(line))
  {
    return;
  }

  writer.WriteLine(line);
  task.LastLine = line;
  task.UpdatedAt = DateTimeOffset.Now;

  if (line.Contains("[download] Destination:", StringComparison.OrdinalIgnoreCase) ||
      line.Contains("[download] Resuming download", StringComparison.OrdinalIgnoreCase))
  {
    task.Status = "running";
    task.Message = line;
  }

  var percentMatch = Regex.Match(line, @"\[download\]\s+(?<pct>\d+(?:\.\d+)?)%");
  if (percentMatch.Success && double.TryParse(percentMatch.Groups["pct"].Value, out var percent))
  {
    task.Percent = percent;
    task.Status = "running";
  }

  var etaMatch = Regex.Match(line, @"ETA\s+(?<eta>[0-9:]+|Unknown)");
  if (etaMatch.Success)
  {
    task.Eta = etaMatch.Groups["eta"].Value;
  }

  var speedMatch = Regex.Match(line, @"at\s+(?<speed>\S+/s)");
  if (speedMatch.Success)
  {
    task.Speed = speedMatch.Groups["speed"].Value;
  }
}

static string NormalizeQuality(string? value)
{
  if (value == "audio") return "audio-mp3";
  return string.IsNullOrWhiteSpace(value) ? "best-mp4" : value;
}

static string NormalizeVcodec(string? value)
{
  var v = (value ?? "auto").ToLowerInvariant();
  if (v is "av1" or "av01") return "av1";
  if (v is "vp9" or "vp09") return "vp9";
  if (v is "avc" or "avc1" or "h264") return "avc";
  return "auto";
}

static string VcodecFilter(string vcodec) => vcodec switch
{
  "av1" => "[vcodec^=av01]",
  "vp9" => "[vcodec^=vp09]",
  "avc" => "[vcodec^=avc1]",
  _ => ""
};

static int? QualityHeight(string quality) => quality switch
{
  "4320" => 4320,
  "2160" => 2160,
  "1440" => 1440,
  "1080" => 1080,
  "720" => 720,
  "480" => 480,
  "360" => 360,
  "240" => 240,
  "144" => 144,
  _ => null
};

static string NormalizeAbitrate(string? value)
{
  var v = (value ?? "0").Trim().ToUpperInvariant();
  if (v.EndsWith("K") && v.Length > 1 && v[..^1].All(char.IsDigit))
  {
  }
  else if (v.All(char.IsDigit) && v != "0")
  {
    v += "K";
  }
  return v is "0" or "64K" or "96K" or "128K" or "192K" or "256K" or "320K" ? v : "0";
}

static string NormalizeTrackMode(string? value)
{
  var v = (value ?? "orig").Trim().ToLowerInvariant();
  return v is "orig" or "dub" or "dual" ? v : "orig";
}

static string NormalizeLang(string? value)
{
  var v = (value ?? "").Trim();
  if (string.IsNullOrEmpty(v))
  {
    return "";
  }
  var parts = v.Split('-');
  if (parts.Length == 0 || parts[0].Length < 2 || parts[0].Length > 3 || !parts[0].All(char.IsLetter))
  {
    return "";
  }
  for (var i = 1; i < parts.Length; i++)
  {
    if (parts[i].Length == 0 || !parts[i].All(char.IsLetter))
    {
      return "";
    }
  }
  return string.Join("-", new[] { parts[0].ToLowerInvariant() }.Concat(parts.Skip(1)));
}

static string[] BuildYtDlpArgs(string url, string outputTemplate, string quality, string playlistMode, string vcodec = "auto",
  string abitrate = "0", string trackMode = "orig", string dubLang = "", string origLang = "")
{
  quality = NormalizeQuality(quality);
  vcodec = NormalizeVcodec(vcodec);
  var isAudio = quality.StartsWith("audio-");
  if (isAudio) vcodec = "auto";
  var codec = VcodecFilter(vcodec);

  abitrate = NormalizeAbitrate(abitrate);
  trackMode = NormalizeTrackMode(trackMode);
  dubLang = NormalizeLang(dubLang);
  origLang = NormalizeLang(origLang);
  // "Лучший MP4 одним файлом" — всегда оригинал; dual для аудио
  // невозможен — скачиваем дубляж отдельно.
  if (quality == "best-mp4")
  {
    trackMode = "orig";
  }
  if (isAudio && trackMode == "dual")
  {
    trackMode = "dub";
  }
  if ((trackMode == "dub" || trackMode == "dual") && string.IsNullOrEmpty(dubLang))
  {
    trackMode = "orig";
  }

  var dubF = (trackMode == "dub" || trackMode == "dual") ? $"[language={dubLang}]" : "";
  var origF = (trackMode == "dual" && !string.IsNullOrEmpty(origLang)) ? $"[language={origLang}]" : "";

  string format;
  var mergeArgs = new List<string>();
  var streamArgs = new List<string>();
  var audioPost = new List<string>();

  var height = QualityHeight(quality);
  if (height is int h)
  {
    if (trackMode == "dual")
    {
      format = $"bestvideo[height<={h}]{codec}+bestaudio{origF}+bestaudio{dubF}/bestvideo{codec}+bestaudio{origF}+bestaudio{dubF}";
      mergeArgs.Add("--merge-output-format");
      mergeArgs.Add("mkv");
      streamArgs.Add("--audio-multistreams");
    }
    else if (trackMode == "dub")
    {
      format = $"bestvideo[height<={h}]{codec}+bestaudio{dubF}/bestvideo{codec}+bestaudio{dubF}";
      mergeArgs.Add("--merge-output-format");
      mergeArgs.Add("mp4");
    }
    else
    {
      format = string.IsNullOrEmpty(codec)
        ? $"bestvideo[height<={h}]+bestaudio/best[height<={h}]/best"
        : $"bestvideo[height<={h}]{codec}+bestaudio/bestvideo[height<={h}]{codec}/bestvideo[height<={h}]+bestaudio/best[height<={h}]/best";
      mergeArgs.Add("--merge-output-format");
      mergeArgs.Add("mp4");
    }
  }
  else if (quality == "best")
  {
    if (trackMode == "dual")
    {
      format = $"bestvideo{codec}+bestaudio{origF}+bestaudio{dubF}/bestvideo+bestaudio+bestaudio";
      mergeArgs.Add("--merge-output-format");
      mergeArgs.Add("mkv");
      streamArgs.Add("--audio-multistreams");
    }
    else if (trackMode == "dub")
    {
      format = $"bestvideo{codec}+bestaudio{dubF}/bestvideo+bestaudio";
      mergeArgs.Add("--merge-output-format");
      mergeArgs.Add("mp4");
    }
    else
    {
      format = string.IsNullOrEmpty(codec)
        ? "bestvideo+bestaudio/best"
        : $"bestvideo{codec}+bestaudio/bestvideo{codec}/bestvideo+bestaudio/best";
      mergeArgs.Add("--merge-output-format");
      mergeArgs.Add("mp4");
    }
  }
  else if (quality == "best-mp4")
  {
    format = string.IsNullOrEmpty(codec)
      ? "best[ext=mp4]/best"
      : $"best[ext=mp4]{codec}/best[ext=mp4]/best";
  }
  else if (isAudio)
  {
    var aformat = quality.Contains("-") ? quality.Split("-", 2)[1] : "mp3";
    if (aformat is not ("mp3" or "m4a" or "opus" or "wav" or "best")) aformat = "mp3";
    format = trackMode == "dub" ? $"bestaudio{dubF}" : "bestaudio/best";
    if (aformat != "best")
    {
      audioPost.Add("-x");
      audioPost.Add("--audio-format");
      audioPost.Add(aformat);
      if (aformat is "mp3" or "m4a" or "opus")
      {
        audioPost.Add("--audio-quality");
        audioPost.Add(abitrate);
      }
    }
  }
  else
  {
    format = "best[ext=mp4]/best";
  }

  var args = new List<string>
  {
    "--ignore-config",
    "--no-overwrites",
    "--newline",
    "--progress",
    "-f",
    format,
    "-o",
    outputTemplate
  };
  args.AddRange(mergeArgs);
  args.AddRange(streamArgs);

  if (playlistMode != "playlist")
  {
    args.Add("--no-playlist");
  }
  else
  {
    args.Add("--yes-playlist");
  }

  args.AddRange(audioPost);

  args.Add(url);
  return args.ToArray();
}

static bool IsYouTubeUrl(string value)
{
  try
  {
    var uri = new Uri(value);
    return uri.Host is "youtube.com" or "www.youtube.com" or "m.youtube.com" or "youtu.be";
  }
  catch
  {
    return false;
  }
}

static string ResolveDownloadDir(string? requestedDir)
{
  var defaultDownloadDir = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
    "youtube videos"
  );
  var dir = string.IsNullOrWhiteSpace(requestedDir) ? defaultDownloadDir : requestedDir!;
  Directory.CreateDirectory(dir);
  return dir;
}

static string ResolveYtDlpPath()
{
  var envPath = Environment.GetEnvironmentVariable("YTDLP_PATH");
  if (!string.IsNullOrWhiteSpace(envPath) && File.Exists(envPath))
  {
    return envPath;
  }

  return "yt-dlp";
}

static string? ReadMessage(Stream stream)
{
  var lengthBytes = new byte[4];
  if (stream.Read(lengthBytes, 0, 4) != 4)
  {
    return null;
  }

  var length = BitConverter.ToInt32(lengthBytes, 0);
  var buffer = new byte[length];
  var read = 0;
  while (read < length)
  {
    var chunk = stream.Read(buffer, read, length - read);
    if (chunk <= 0)
    {
      break;
    }
    read += chunk;
  }
  return Encoding.UTF8.GetString(buffer, 0, read);
}

static void WriteResponse(Stream stream, object syncRoot, object payload)
{
  var json = JsonSerializer.Serialize(payload);
  var bytes = Encoding.UTF8.GetBytes(json);
  var lengthBytes = BitConverter.GetBytes(bytes.Length);
  lock (syncRoot)
  {
    stream.Write(lengthBytes, 0, lengthBytes.Length);
    stream.Write(bytes, 0, bytes.Length);
    stream.Flush();
  }
}

sealed class DownloadTask
{
  public string Id { get; set; } = "";
  public string Url { get; set; } = "";
  public string DownloadDir { get; set; } = "";
  public string Quality { get; set; } = "";
  public string Vcodec { get; set; } = "auto";
  public string Abitrate { get; set; } = "0";
  public string TrackMode { get; set; } = "orig";
  public string DubLang { get; set; } = "";
  public string PlaylistMode { get; set; } = "";
  public string LogFile { get; set; } = "";
  public string Status { get; set; } = "";
  public string Message { get; set; } = "";
  public string LastLine { get; set; } = "";
  public string Eta { get; set; } = "";
  public string Speed { get; set; } = "";
  public double Percent { get; set; }
  public int? ProcessId { get; set; }
  public int? ExitCode { get; set; }
  public DateTimeOffset StartedAt { get; set; }
  public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.Now;
}

sealed class ResolvedVideo
{
  public string Id { get; set; } = "";
  public string Url { get; set; } = "";
  public string Title { get; set; } = "";
  public string Uploader { get; set; } = "";
  public string Duration { get; set; } = "";
  public int Index { get; set; }
}

sealed class AudioTrack
{
  public string Lang { get; set; } = "";
  public string Label { get; set; } = "";
  public bool Original { get; set; }
}
