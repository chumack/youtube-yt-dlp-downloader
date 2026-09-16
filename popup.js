const defaultDownloadDir = "%USERPROFILE%\\Desktop\\youtube videos";
const downloadDirStorageKey = "ytDlpDownloadDir";

const urlInput = document.getElementById("url");
const downloadDirInput = document.getElementById("downloadDir");
const qualityInput = document.getElementById("quality");
const codecInput = document.getElementById("vcodec");
const useBrowserCookiesInput = document.getElementById("useBrowserCookies");
const useCurrentPageButton = document.getElementById("useCurrentPage");
const clearUrlButton = document.getElementById("clearUrl");
const qualityChips = [...document.querySelectorAll(".qualityPresets .qualityChip")];
const codecChips = [...document.querySelectorAll("#codecPresets .codecChip")];
const bitrateChips = [...document.querySelectorAll("#bitratePresets .codecChip")];
const trackChips = [...document.querySelectorAll("#trackPresets .codecChip")];
const abitrateInput = document.getElementById("abitrate");
const trackInput = document.getElementById("trackmode");
const dubLangInput = document.getElementById("dublang");
const dubLangRow = document.getElementById("dubLangRow");
const dubHint = document.getElementById("dubHint");
const cookiesStorageKey = "ytDlpUseCookies";
const codecStorageKey = "ytDlpVcodec";
const qualityStorageKey = "ytDlpQuality";
const abitrateStorageKey = "ytDlpAbitrate";
const trackStorageKey = "ytDlpTrackMode";
const dublangStorageKey = "ytDlpDubLang";
// Запасной список языков дубляжа (плейлисты и видео без дорожек).
const FALLBACK_DUB_LANGS = [
  ["ru", "Русский"], ["uk", "Украинский"], ["en", "English"], ["es", "Español"],
  ["pt", "Português"], ["de", "Deutsch"], ["fr", "Français"], ["it", "Italiano"],
  ["pl", "Polski"], ["tr", "Türkçe"], ["ar", "العربية"], ["hi", "हिन्दी"],
  ["ja", "日本語"], ["ko", "한국어"], ["zh-Hans", "中文 (упрощ.)"], ["zh-Hant", "中文 (трад.)"]
];
const statusText = document.getElementById("status");
const resolveButton = document.getElementById("resolve");
const downloadSelectedButton = document.getElementById("downloadSelected");
const refreshButton = document.getElementById("refresh");
const clearTasksButton = document.getElementById("clearTasks");
const detachWindowButton = document.getElementById("detachWindow");
const tasksList = document.getElementById("tasksList");
const taskSummary = document.getElementById("taskSummary");
const videoList = document.getElementById("videoList");
const resolveSummary = document.getElementById("resolveSummary");
const resolveChips = document.getElementById("resolveChips");
const selectAllInput = document.getElementById("selectAll");
const versionText = document.getElementById("version");
const loginAccountButton = document.getElementById("loginAccount");
const logoutAccountButton = document.getElementById("logoutAccount");
const loadAccountButton = document.getElementById("loadAccount");
const accountStatus = document.getElementById("accountStatus");
const accountSummary = document.getElementById("accountSummary");
const recentList = document.getElementById("recentList");
const likedList = document.getElementById("likedList");
const playlistList = document.getElementById("playlistList");
const views = {
  resolve: document.getElementById("resolveView"),
  tasks: document.getElementById("tasksView"),
  account: document.getElementById("accountView")
};
const tabs = [...document.querySelectorAll(".tab")];

const previewVideos = [
  {
    id: "dQw4w9WgXcQ",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Пример: готовится к загрузке",
    uploader: "Пример канала",
    duration: "3:33",
    index: 1
  },
  {
    id: "KpcaZCkYFv4",
    url: "https://www.youtube.com/watch?v=KpcaZCkYFv4",
    title: "Видео из подборки: доступно 1080p",
    uploader: "Пример канала",
    duration: "8:14",
    index: 2
  }
];
const previewTasks = [
  {
    id: "demo-running",
    status: "running",
    percent: 64.3,
    quality: "1080",
    vcodec: "avc",
    playlistMode: "single",
    speed: "5.2MiB/s",
    eta: "00:18",
    lastLine: "[download] 64.3% of 152.34MiB at 5.2MiB/s ETA 00:18"
  },
  {
    id: "demo-done",
    status: "done",
    percent: 100,
    quality: "audio-mp3",
    vcodec: "auto",
    abitrate: "192K",
    trackMode: "orig",
    dubLang: "",
    playlistMode: "single",
    speed: "",
    eta: "",
    lastLine: "[ExtractAudio] Destination: sample-track.mp3"
  }
];
const previewAccount = {
  channel: {
    title: "fengjunda888",
    thumbnail: "icons/icon-48.png"
  },
  recentHistory: previewVideos.map(video => ({
    url: video.url,
    title: video.title,
    lastVisitTime: Date.now(),
    visitCount: 3
  })),
  likedVideos: previewVideos,
  playlists: [
    { id: "PLdemo", title: "Сохранённая подборка уроков", count: 18, thumbnail: "icons/icon-48.png" }
  ]
};

let pollTimer;
let resolvedVideos = [];
let resolvedMeta = { tracks: [], origLang: "" };
let previewMode = "";
let oauthConfigured = true;
// Версия протокола хоста. При расхождении новые функции молча не работают,
// поэтому один раз за сессию показываем просьбу переустановить хост.
const EXPECTED_HOST_VERSION = "0.4.6";
let hostVersionWarned = false;

function checkHostVersion(response) {
  if (hostVersionWarned) {
    return;
  }
  const v = response?.hostVersion || "";
  if (v === EXPECTED_HOST_VERSION) {
    return;
  }
  hostVersionWarned = true;
  setStatus(`Native-host устарел (${v || "версия неизвестна"}): переустановите хост запуском Install-NativeHost, иначе новые функции не работают.`, "error");
}

function setStatus(message, state = "") {
  statusText.textContent = message;
  statusText.dataset.state = state;
}

function setView(name) {
  for (const [viewName, element] of Object.entries(views)) {
    const active = viewName === name;
    element.classList.toggle("active", active);
    // styles.css forces [hidden]{display:none!important}, so the attribute
    // must be synced too — otherwise tasks/account views never become visible.
    element.hidden = !active;
  }
  tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.view === name));
  if (name === "tasks") {
    refreshTasks();
    startPolling();
  }
}

async function sendNative(payload) {
  const result = await chrome.runtime.sendMessage({
    type: "native-request",
    payload
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Native host did not respond.");
  }
  if (result.response?.ok === false) {
    throw new Error(result.response.error || "Native host rejected the request.");
  }
  return result.response;
}

async function sendAccount(payload) {
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: "account-request",
      payload
    });
  } catch (error) {
    throw new Error(error.message || "Background service worker did not respond.");
  }

  if (!result?.ok) {
    throw new Error(result?.error || chrome.runtime.lastError?.message || "Account request failed.");
  }
  if (result.response?.ok === false) {
    throw new Error(result.response.error || "Account request was rejected.");
  }
  return result.response;
}

async function getActiveTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";
    // В отдельном окне текущая вкладка — сам попап (chrome-extension://...).
    // Тогда ищем YouTube-вкладку в обычных окнах браузера.
    if (!url.startsWith("chrome-extension://")) {
      return url;
    }
    const tabs = await chrome.tabs.query({});
    const yt = (tabs || []).filter(t => t?.url && isYouTubeUrl(t.url));
    const active = yt.find(t => t.active);
    return (active || yt[0])?.url || "";
  } catch {
    return "";
  }
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname);
  } catch {
    return false;
  }
}

function getDownloadDir() {
  return downloadDirInput.value.trim() || defaultDownloadDir;
}

function updateResolveButton() {
  resolveButton.disabled = !urlInput.value.trim();
}

function normalizeQuality(value) {
  // Backward compat: старый пресет "audio" = MP3.
  if (value === "audio") return "audio-mp3";
  return value || "best-mp4";
}

function isAudioQuality(value) {
  return normalizeQuality(value).startsWith("audio-");
}

function syncQualityChips() {
  qualityInput.value = normalizeQuality(qualityInput.value);
  qualityChips.forEach(chip => {
    const active = chip.dataset.quality === qualityInput.value;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
  });
  syncCodecChips();
  syncBitrateChips();
  syncTrackChips();
}

function audioFormatOf(value) {
  const q = normalizeQuality(value);
  return q.startsWith("audio-") ? q.split("-")[1] : "";
}

function isLossyAudio(value) {
  return ["mp3", "m4a", "opus"].includes(audioFormatOf(value));
}

function normalizeAbitrate(value) {
  const v = String(value ?? "0").trim().toUpperCase();
  const norm = /^\d+$/.test(v) && v !== "0" ? `${v}K` : v;
  return ["0", "64K", "96K", "128K", "192K", "256K", "320K"].includes(norm) ? norm : "0";
}

function normalizeTrackMode(value) {
  const v = String(value ?? "orig").trim().toLowerCase();
  return ["orig", "dub", "dual"].includes(v) ? v : "orig";
}

function syncBitrateChips() {
  if (abitrateInput) {
    abitrateInput.value = normalizeAbitrate(abitrateInput.value);
  }
  const enabled = isLossyAudio(qualityInput.value);
  bitrateChips.forEach(chip => {
    const active = chip.dataset.bitrate === (abitrateInput?.value || "0");
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
    chip.disabled = !enabled;
    chip.title = enabled ? "" : "Битрейт доступен для MP3/M4A/Opus";
  });
  if (abitrateInput) {
    abitrateInput.disabled = !enabled;
  }
}

function getAbitrate() {
  return isLossyAudio(qualityInput.value) ? normalizeAbitrate(abitrateInput?.value) : "0";
}

function syncTrackChips() {
  if (trackInput) {
    trackInput.value = normalizeTrackMode(trackInput.value);
  }
  // best-mp4 — всегда оригинал.
  const forcedOrig = normalizeQuality(qualityInput.value) === "best-mp4";
  const mode = forcedOrig ? "orig" : (trackInput?.value || "orig");
  trackChips.forEach(chip => {
    const active = chip.dataset.trackmode === mode;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
    chip.disabled = forcedOrig;
    chip.title = forcedOrig ? "«Лучший MP4» — всегда оригинал" : "";
  });
  if (trackInput) {
    trackInput.disabled = forcedOrig;
  }
  updateDubLangRow();
}

function getTrackMode() {
  if (normalizeQuality(qualityInput.value) === "best-mp4") return "orig";
  return normalizeTrackMode(trackInput?.value);
}

function getDubLang() {
  return getTrackMode() === "orig" ? "" : (dubLangInput?.value || "").trim();
}

function updateDubLangRow() {
  if (!dubLangRow) return;
  const show = getTrackMode() !== "orig";
  dubLangRow.hidden = !show;
}

function populateDubLangs(tracks, origLang) {
  if (!dubLangInput) return;
  const prev = dubLangInput.value;
  dubLangInput.innerHTML = "";
  const dubs = (tracks || []).filter(t => !t.original);
  const mkOption = (value, text) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    return o;
  };
  if (dubs.length) {
    dubs.forEach(t => dubLangInput.appendChild(
      mkOption(t.lang, `${t.label || t.lang} (${t.lang})`)));
    if (dubHint) {
      const orig = (tracks || []).find(t => t.original);
      dubHint.textContent = orig
        ? `Оригинал: ${orig.label || origLang || orig.lang}. Две дорожки соберутся в один MKV, дубляж — первой.`
        : "Найденные языки дубляжа. Две дорожки соберутся в один MKV, дубляж — первой.";
    }
  } else {
    FALLBACK_DUB_LANGS.forEach(([code, name]) => dubLangInput.appendChild(
      mkOption(code, `${name} (${code})`)));
    if (dubHint) {
      dubHint.textContent = tracks && tracks.length
        ? "В этом видео дубляжа нет — только оригинал."
        : "После поиска здесь появятся найденные в видео языки дубляжа.";
    }
  }
  const values = [...dubLangInput.options].map(o => o.value);
  const saved = localStorage.getItem(dublangStorageKey) || "";
  if (values.includes(prev)) {
    dubLangInput.value = prev;
  } else if (values.includes(saved)) {
    dubLangInput.value = saved;
  } else if (values.includes("ru")) {
    dubLangInput.value = "ru";
  }
}

function syncCodecChips() {
  if (codecInput) {
    codecInput.value = codecInput.value || "auto";
  }
  const audio = isAudioQuality(qualityInput.value);
  codecChips.forEach(chip => {
    const active = chip.dataset.codec === (codecInput?.value || "auto");
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
    chip.disabled = audio;
    chip.title = audio ? "Кодек применяется только к видео" : "";
  });
  if (codecInput) {
    codecInput.disabled = audio;
  }
}

function getVcodec() {
  const v = codecInput?.value || "auto";
  return isAudioQuality(qualityInput.value) ? "auto" : v;
}

function cleanCookieField(value) {
  return String(value ?? "").replace(/[\t\r\n]/g, "");
}

async function getYouTubeCookiesTxt() {
  if (!chrome?.cookies?.getAll) {
    throw new Error("Нет доступа к кукам: обновите расширение на странице браузера.");
  }
  const seen = new Set();
  const all = [];
  for (const domain of [".youtube.com", "youtube.com", ".youtu.be"]) {
    const list = await chrome.cookies.getAll({ domain });
    for (const c of list) {
      const key = `${c.name}${c.domain}${c.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(c);
      }
    }
  }
  if (!all.length) {
    throw new Error("В браузере нет кук YouTube: войдите в аккаунт YouTube и попробуйте снова.");
  }
  const lines = ["# Netscape HTTP Cookie File", "# Generated by YouTube yt-dlp Downloader"];
  for (const c of all) {
    const expiry = c.session || !c.expirationDate ? 0 : Math.floor(c.expirationDate);
    lines.push([
      cleanCookieField(c.domain),
      c.hostOnly ? "FALSE" : "TRUE",
      cleanCookieField(c.path),
      c.secure ? "TRUE" : "FALSE",
      String(expiry),
      cleanCookieField(c.name),
      cleanCookieField(c.value)
    ].join("\t"));
  }
  return lines.join("\n") + "\n";
}

async function resolveCurrentUrl() {
  const url = urlInput.value.trim();
  if (!isYouTubeUrl(url)) {
    setStatus("Это не ссылка YouTube.", "error");
    return;
  }

  localStorage.setItem(downloadDirStorageKey, getDownloadDir());
  localStorage.setItem(cookiesStorageKey, useBrowserCookiesInput.checked ? "1" : "0");
  localStorage.setItem(qualityStorageKey, normalizeQuality(qualityInput.value));
  localStorage.setItem(codecStorageKey, codecInput?.value || "auto");
  localStorage.setItem(abitrateStorageKey, normalizeAbitrate(abitrateInput?.value));
  localStorage.setItem(trackStorageKey, normalizeTrackMode(trackInput?.value));
  localStorage.setItem(dublangStorageKey, (dubLangInput?.value || "").trim());
  resolveButton.disabled = true;
  setStatus("Разбираю ссылку…", "busy");
  renderVideos([]);

  try {
    const payload = { action: "resolve", url };
    if (useBrowserCookiesInput.checked) {
      payload.useBrowserCookies = true;
      payload.cookiesTxt = await getYouTubeCookiesTxt();
    }
    const response = await sendNative(payload);
    resolvedVideos = response.videos || [];
    resolvedMeta = { tracks: response.audioTracks || [], origLang: response.origLang || "" };
    populateDubLangs(resolvedMeta.tracks, resolvedMeta.origLang);
    renderVideos(resolvedVideos);
    const cookiesNote = response.cookiesSent
      ? ` Куки: ${response.cookiesSent} (${response.cookiesFrom || "браузер"}).`
      : "";
    setStatus(`Готово: найдено видео: ${resolvedVideos.length}.${cookiesNote}`, "success");
    checkHostVersion(response);
  } catch (error) {
    resolvedVideos = [];
    resolvedMeta = { tracks: [], origLang: "" };
    populateDubLangs([], "");
    renderVideos([]);
    setStatus(`Ошибка разбора: ${error.message}`, "error");
  } finally {
    resolveButton.disabled = false;
  }
}

async function downloadSelectedVideos() {
  const selected = getSelectedVideos();
  const downloadDir = getDownloadDir();
  if (!selected.length) {
    setStatus("Сначала выберите видео для загрузки.", "error");
    return;
  }

  const quality = normalizeQuality(qualityInput.value);
  const vcodec = getVcodec();
  const abitrate = getAbitrate();
  const trackMode = getTrackMode();
  const dubLang = getDubLang();
  const origLang = resolvedMeta.origLang || "";
  // Если resolve уже показал дорожки и нужного дубляжа среди них нет —
  // сразу говорим об этом, не дёргая хост.
  if ((trackMode === "dub" || trackMode === "dual") && resolvedMeta.tracks.length > 0 &&
      !resolvedMeta.tracks.some(t => String(t.lang || "").toLowerCase() === dubLang.toLowerCase())) {
    const dubs = resolvedMeta.tracks.filter(t => !t.original).map(t => t.lang.toUpperCase()).join(", ");
    setStatus(dubs
      ? `В этом видео нет дубляжа ${dubLang.toUpperCase()} — доступны: ${dubs}.`
      : "В этом видео нет дубляжа — только оригинал.", "error");
    return;
  }
  localStorage.setItem(downloadDirStorageKey, downloadDir);
  localStorage.setItem(cookiesStorageKey, useBrowserCookiesInput.checked ? "1" : "0");
  localStorage.setItem(qualityStorageKey, quality);
  localStorage.setItem(codecStorageKey, vcodec);
  localStorage.setItem(abitrateStorageKey, abitrate);
  localStorage.setItem(trackStorageKey, trackMode);
  localStorage.setItem(dublangStorageKey, dubLang);
  downloadSelectedButton.disabled = true;
  setStatus(`Добавляю задач: ${selected.length}…`, "busy");

  let cookiesTxt = null;
  if (useBrowserCookiesInput.checked) {
    try {
      cookiesTxt = await getYouTubeCookiesTxt();
    } catch (error) {
      setStatus(error.message, "error");
      downloadSelectedButton.disabled = false;
      return;
    }
  }

  let successCount = 0;
  let lastError = "";
  for (const video of selected) {
    try {
      await sendNative({
        action: "start",
        url: video.url,
        downloadDir,
        quality,
        vcodec,
        abitrate,
        trackMode,
        dubLang,
        origLang,
        playlistMode: "single",
        ...(cookiesTxt ? { useBrowserCookies: true, cookiesTxt } : {})
      });
      successCount += 1;
    } catch (error) {
      lastError = error.message;
    }
  }

  setStatus(lastError ? `Добавлено задач: ${successCount}, часть с ошибкой: ${lastError}` : `Добавлено задач: ${successCount}.`, lastError ? "error" : "success");
  downloadSelectedButton.disabled = false;
  await refreshTasks();
  setView("tasks");
}

async function refreshTasks() {
  if (previewMode) {
    renderTasks(previewMode === "tasks" ? previewTasks : []);
    return;
  }

  try {
    const response = await sendNative({ action: "list" });
    renderTasks(response.tasks || []);
    checkHostVersion(response);
  } catch (error) {
    tasksList.innerHTML = emptyState("Не могу прочитать задачи", error.message, "error");
  }
}

async function cancelTask(id) {
  try {
    await sendNative({ action: "cancel", id });
    await refreshTasks();
  } catch (error) {
    setStatus(`Не удалось отменить: ${error.message}`, "error");
  }
}

function updateClearButton(tasks) {
  if (!clearTasksButton) {
    return;
  }
  clearTasksButton.disabled = !tasks.some(task =>
    ["done", "error", "canceled"].includes(task.Status || task.status));
}

async function clearFinishedTasks() {
  if (clearTasksButton) {
    clearTasksButton.disabled = true;
  }
  try {
    const ok = typeof confirm === "function"
      ? confirm("Удалить завершённые загрузки из списка? Скачанные файлы на диске останутся.")
      : true;
    if (!ok) {
      return;
    }
    await sendNative({ action: "clear" });
    await refreshTasks();
  } catch (error) {
    tasksList.innerHTML = emptyState("Не удалось очистить", error.message, "error");
  }
}

async function openDetachedWindow() {
  try {
    if (!chrome.windows?.create || !chrome.runtime?.getURL) {
      throw new Error("unsupported");
    }
    await chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup",
      width: 520,
      height: 720,
      focused: true
    });
  } catch (error) {
    setStatus("Отдельное окно не поддерживается этим браузером.", "error");
  }
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  pollTimer = setInterval(refreshTasks, 1500);
}

async function loadAccountData() {
  if (!oauthConfigured && !previewMode) {
    // No OAuth: playlists/likes are unavailable, but recent history
    // needs no login — show at least that so the tab is not empty.
    accountStatus.textContent = "Вход через Google не настроен: плейлисты и понравившиеся недоступны. Ниже — недавние видео из истории браузера.";
    try {
      const data = await sendAccount({ action: "recent" });
      renderAccount(data);
    } catch (error) {
      accountStatus.textContent = `Недавние недоступны: ${error.message}`;
      renderAccount({});
    }
    return;
  }

  loginAccountButton.disabled = true;
  loadAccountButton.disabled = true;
  accountStatus.textContent = "Читаю данные аккаунта YouTube…";

  try {
    const data = previewMode ? previewAccount : await sendAccount({ action: "load" });
    renderAccount(data);
    accountStatus.textContent = "Данные аккаунта получены.";
  } catch (error) {
    accountStatus.textContent = `Ошибка чтения: ${error.message}`;
    renderAccount({});
  } finally {
    loginAccountButton.disabled = false;
    loadAccountButton.disabled = false;
  }
}

async function logoutAccount() {
  try {
    if (!previewMode) {
      await sendAccount({ action: "logout" });
    }
    accountStatus.textContent = "Вышли из аккаунта.";
    renderAccount({});
  } catch (error) {
    accountStatus.textContent = `Ошибка выхода: ${error.message}`;
  }
}

function renderVideos(videos) {
  selectAllInput.checked = false;
  selectAllInput.indeterminate = false;
  if (!videos.length) {
    resolveSummary.textContent = "Видео пока не найдены.";
    resolveChips.innerHTML = "";
    videoList.innerHTML = emptyState("Ожидание", "Вставьте ссылку на видео или плейлист YouTube и нажмите «Найти».");
    updateSelectionState();
    return;
  }

  resolveSummary.textContent = `Всего видео: ${videos.length}. Можно выбрать одно или несколько.`;
  resolveChips.innerHTML = `
    <span>Видео: ${videos.length}</span>
    <span>${escapeHtml(fullFormatText(qualityInput.value, getVcodec(), getAbitrate(), getTrackMode(), getDubLang()))}</span>
    <span>Папка задана</span>
  `;
  videoList.innerHTML = videos.map((video, index) => `
    <label class="videoItem">
      <input type="checkbox" data-video-index="${index}" checked>
      <span class="videoThumb" aria-hidden="true"></span>
      <span class="videoBody">
        <strong>${escapeHtml(video.index ? `${video.index}. ${video.title}` : video.title)}</strong>
        <span>${escapeHtml([video.uploader, video.duration].filter(Boolean).join(" · ") || video.url)}</span>
      </span>
    </label>
  `).join("");

  videoList.querySelectorAll("input[type='checkbox']").forEach(input => {
    input.addEventListener("change", updateSelectionState);
  });
  updateSelectionState();
}

function renderTasks(tasks) {
  updateClearButton(tasks);
  if (!tasks.length) {
    taskSummary.innerHTML = "";
    tasksList.innerHTML = emptyState("Нет загрузок", "Найдите видео и добавьте выбранное — оно появится здесь.");
    return;
  }

  const runningCount = tasks.filter(task => ["running", "starting"].includes(task.Status || task.status)).length;
  const doneCount = tasks.filter(task => (task.Status || task.status) === "done").length;
  taskSummary.innerHTML = `
    <span>Задач: ${tasks.length}</span>
    <span>Активно: ${runningCount}</span>
    <span>Готово: ${doneCount}</span>
  `;

  tasksList.innerHTML = tasks.map(task => {
    const percent = Math.max(0, Math.min(100, Number(task.Percent || task.percent || 0)));
    const status = task.Status || task.status || "unknown";
    const id = task.Id || task.id;
    const line = task.LastLine || task.lastLine || task.Message || task.message || "";
    const eta = task.Eta || task.eta || "";
    const speed = task.Speed || task.speed || "";
    const quality = task.Quality || task.quality || "";
    const vcodec = task.Vcodec || task.vcodec || "auto";
    const abitrate = task.Abitrate || task.abitrate || "0";
    const trackMode = task.TrackMode || task.trackMode || task.trackmode || "orig";
    const dubLang = task.DubLang || task.dubLang || task.dublang || "";
    const canCancel = status === "running" || status === "starting";

    return `
      <article class="task">
        <div class="taskTop">
          <strong><span class="statusPill ${escapeHtml(status)}">${escapeHtml(statusTextFor(status))}</span></strong>
          <span>${percent.toFixed(percent ? 1 : 0)}%</span>
        </div>
        <div class="bar"><span style="width:${percent}%"></span></div>
        <div class="meta">${escapeHtml(fullFormatText(quality, vcodec, abitrate, trackMode, dubLang))}${speed ? ` · ${escapeHtml(speed)}` : ""}${eta ? ` · ETA ${escapeHtml(eta)}` : ""}</div>
        <div class="line">${escapeHtml(line)}</div>
        <div class="taskActions">
          <button class="ghost small" data-cancel="${escapeHtml(id)}" ${canCancel ? "" : "disabled"}>Отмена</button>
        </div>
      </article>
    `;
  }).join("");

  tasksList.querySelectorAll("[data-cancel]").forEach(button => {
    button.addEventListener("click", () => cancelTask(button.dataset.cancel));
  });
}

function renderAccount(data) {
  const channel = data.channel;
  if (channel?.title) {
    accountSummary.innerHTML = `
      <div class="accountCard">
        ${channel.thumbnail ? `<img src="${escapeHtml(channel.thumbnail)}" alt="">` : ""}
        <div>
          <strong>${escapeHtml(channel.title)}</strong>
          <span>Аккаунт YouTube подключён</span>
        </div>
      </div>
    `;
  } else {
    accountSummary.innerHTML = emptyState("Нет входа", "Войдите, чтобы читать плейлисты, понравившиеся и недавние видео.");
  }

  renderLinkList(recentList, data.recentHistory || [], item => ({
    title: item.title,
    subtitle: item.lastVisitTime ? `Открыто: ${new Date(item.lastVisitTime).toLocaleString()}` : item.url,
    url: item.url
  }));
  renderLinkList(likedList, data.likedVideos || [], item => ({
    title: item.title,
    subtitle: item.channelTitle || item.uploader || item.url,
    url: item.url
  }));
  renderLinkList(playlistList, data.playlists || [], item => ({
    title: item.title,
    subtitle: `Видео: ${item.count || 0}`,
    url: `https://www.youtube.com/playlist?list=${item.id}`
  }));
}

function renderLinkList(container, items, mapItem) {
  if (!items.length) {
    container.innerHTML = emptyState("Пусто", "Войдите или обновите — здесь появятся видео для поиска.");
    return;
  }

  container.innerHTML = items.map(item => {
    const mapped = mapItem(item);
    return `
      <article class="compactItem">
        <span class="miniThumb" aria-hidden="true"></span>
        <div>
          <strong>${escapeHtml(mapped.title || mapped.url)}</strong>
          <span>${escapeHtml(mapped.subtitle || "")}</span>
        </div>
        <button class="ghost small" data-use-url="${escapeHtml(mapped.url)}">Найти</button>
      </article>
    `;
  }).join("");

  container.querySelectorAll("[data-use-url]").forEach(button => {
    button.addEventListener("click", () => {
      urlInput.value = button.dataset.useUrl;
      setView("resolve");
      setStatus("Ссылка подставлена, можно искать.", "success");
    });
  });
}

function updateSelectionState() {
  const checkboxes = [...videoList.querySelectorAll("input[type='checkbox']")];
  const selectedCount = checkboxes.filter(input => input.checked).length;
  downloadSelectedButton.disabled = selectedCount === 0;
  downloadSelectedButton.textContent = selectedCount ? `Скачать выбранное (${selectedCount})` : "Скачать выбранное";
  selectAllInput.disabled = checkboxes.length === 0;
  selectAllInput.checked = checkboxes.length > 0 && selectedCount === checkboxes.length;
  selectAllInput.indeterminate = selectedCount > 0 && selectedCount < checkboxes.length;
}

function emptyState(title, description, tone = "") {
  return `
    <div class="empty ${escapeHtml(tone)}">
      <span class="emptyIcon" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(description)}</span>
      </div>
    </div>
  `;
}

function getSelectedVideos() {
  return [...videoList.querySelectorAll("input[type='checkbox']:checked")]
    .map(input => resolvedVideos[Number(input.dataset.videoIndex)])
    .filter(Boolean);
}

function statusTextFor(status) {
  return {
    starting: "Запуск",
    running: "Загрузка",
    done: "Готово",
    error: "Ошибка",
    canceled: "Отменено"
  }[status] || status;
}

function qualityText(value) {
  return {
    "best": "Лучшее доступное",
    "best-mp4": "Лучший MP4 одним файлом",
    "4320": "Видео до 4320p 8K",
    "2160": "Видео до 2160p 4K",
    "1440": "Видео до 1440p 2K",
    "1080": "Видео до 1080p",
    "720": "Видео до 720p",
    "480": "Видео до 480p",
    "360": "Видео до 360p",
    "240": "Видео до 240p",
    "144": "Видео до 144p",
    "audio": "Только аудио MP3",
    "audio-mp3": "Только аудио MP3",
    "audio-m4a": "Только аудио M4A",
    "audio-opus": "Только аудио Opus",
    "audio-wav": "Только аудио WAV",
    "audio-best": "Аудио оригинал"
  }[normalizeQuality(value)] || value;
}

function codecText(value) {
  return {
    auto: "Авто кодек",
    av1: "AV1",
    vp9: "VP9",
    avc: "AVC/H.264"
  }[value || "auto"] || value;
}

function abitrateText(value) {
  const v = normalizeAbitrate(value);
  return v === "0" ? "" : ` · ${v.replace("K", "")} кбит/с`;
}

function trackText(mode, dubLang) {
  const m = normalizeTrackMode(mode);
  if (m === "dub") return ` · дубляж ${String(dubLang || "").toUpperCase()}`;
  if (m === "dual") return ` · дубляж ${String(dubLang || "").toUpperCase()} + оригинал`;
  return "";
}

function fullFormatText(quality, vcodec, abitrate, trackMode, dubLang) {
  const q = normalizeQuality(quality);
  const tm = normalizeTrackMode(trackMode);
  const dl = (dubLang || "").trim();
  if (isAudioQuality(q)) {
    if (tm !== "orig" && dl) {
      return `${qualityText(q)}${abitrateText(abitrate)} · дубляж ${dl.toUpperCase()}`;
    }
    return `${qualityText(q)}${abitrateText(abitrate)}`;
  }
  const vc = vcodec && vcodec !== "auto" ? ` · ${codecText(vcodec)}` : "";
  return `${qualityText(q)}${vc}${trackText(tm, dl)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

document.addEventListener("DOMContentLoaded", async () => {
  previewMode = new URLSearchParams(window.location.search).get("preview") || "";
  const manifest = chrome?.runtime?.getManifest?.();
  versionText.textContent = `v${manifest?.version || "0.2.0"}`;
  oauthConfigured = !manifest?.oauth2?.client_id?.startsWith("REPLACE_WITH_");
  if (!oauthConfigured && !previewMode) {
    accountStatus.textContent = "Аккаунт необязателен: после настройки Google OAuth Client ID можно читать избранное и плейлисты YouTube.";
  }

  const savedDir = localStorage.getItem(downloadDirStorageKey);
  downloadDirInput.value = savedDir || defaultDownloadDir;
  useBrowserCookiesInput.checked = localStorage.getItem(cookiesStorageKey) === "1";
  const savedQuality = normalizeQuality(localStorage.getItem(qualityStorageKey) || qualityInput.value);
  if ([...qualityInput.options].some(o => o.value === savedQuality)) {
    qualityInput.value = savedQuality;
  }
  if (codecInput) {
    const savedCodec = localStorage.getItem(codecStorageKey) || "auto";
    if ([...codecInput.options].some(o => o.value === savedCodec)) {
      codecInput.value = savedCodec;
    }
  }
  if (abitrateInput) {
    const savedBitrate = normalizeAbitrate(localStorage.getItem(abitrateStorageKey));
    if ([...abitrateInput.options].some(o => o.value === savedBitrate)) {
      abitrateInput.value = savedBitrate;
    }
  }
  if (trackInput) {
    const savedTrack = normalizeTrackMode(localStorage.getItem(trackStorageKey));
    if ([...trackInput.options].some(o => o.value === savedTrack)) {
      trackInput.value = savedTrack;
    }
  }
  populateDubLangs([], "");
  const savedDub = (localStorage.getItem(dublangStorageKey) || "").trim();
  if (savedDub && [...dubLangInput.options].some(o => o.value === savedDub)) {
    dubLangInput.value = savedDub;
  }
  syncQualityChips();

  if (previewMode) {
    urlInput.value = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLdemo";
    resolvedVideos = previewVideos;
    renderVideos(previewMode === "tasks" ? [] : previewVideos);
    renderTasks(previewMode === "tasks" ? previewTasks : []);
    renderAccount(previewMode === "account" ? previewAccount : {});
    setStatus("Готово.", "success");
    setView(["tasks", "account"].includes(previewMode) ? previewMode : "resolve");
    return;
  }

  const currentUrl = await getActiveTabUrl();
  urlInput.value = currentUrl;
  updateResolveButton();
  setStatus(isYouTubeUrl(currentUrl) ? "Готово." : "Откройте страницу видео YouTube.");
  renderVideos([]);
  await refreshTasks();
});

tabs.forEach(tab => tab.addEventListener("click", () => setView(tab.dataset.view)));
selectAllInput.addEventListener("change", () => {
  videoList.querySelectorAll("input[type='checkbox']").forEach(input => {
    input.checked = selectAllInput.checked;
  });
  updateSelectionState();
});
resolveButton.addEventListener("click", resolveCurrentUrl);
urlInput.addEventListener("input", updateResolveButton);
useCurrentPageButton.addEventListener("click", async () => {
  urlInput.value = await getActiveTabUrl();
  updateResolveButton();
  urlInput.focus();
});
clearUrlButton.addEventListener("click", () => {
  urlInput.value = "";
  updateResolveButton();
  urlInput.focus();
});
qualityChips.forEach(chip => chip.addEventListener("click", () => {
  qualityInput.value = chip.dataset.quality;
  localStorage.setItem(qualityStorageKey, normalizeQuality(qualityInput.value));
  syncQualityChips();
}));
qualityInput.addEventListener("change", () => {
  localStorage.setItem(qualityStorageKey, normalizeQuality(qualityInput.value));
  syncQualityChips();
});
codecChips.forEach(chip => chip.addEventListener("click", () => {
  if (chip.disabled) return;
  if (codecInput) codecInput.value = chip.dataset.codec;
  localStorage.setItem(codecStorageKey, chip.dataset.codec);
  syncCodecChips();
}));
codecInput?.addEventListener("change", () => {
  localStorage.setItem(codecStorageKey, codecInput.value);
  syncCodecChips();
});
bitrateChips.forEach(chip => chip.addEventListener("click", () => {
  if (chip.disabled) return;
  if (abitrateInput) abitrateInput.value = chip.dataset.bitrate;
  localStorage.setItem(abitrateStorageKey, chip.dataset.bitrate);
  syncBitrateChips();
}));
abitrateInput?.addEventListener("change", () => {
  localStorage.setItem(abitrateStorageKey, abitrateInput.value);
  syncBitrateChips();
});
trackChips.forEach(chip => chip.addEventListener("click", () => {
  if (chip.disabled) return;
  if (trackInput) trackInput.value = chip.dataset.trackmode;
  localStorage.setItem(trackStorageKey, chip.dataset.trackmode);
  syncTrackChips();
}));
trackInput?.addEventListener("change", () => {
  localStorage.setItem(trackStorageKey, trackInput.value);
  syncTrackChips();
});
dubLangInput?.addEventListener("change", () => {
  localStorage.setItem(dublangStorageKey, (dubLangInput.value || "").trim());
});
useBrowserCookiesInput.addEventListener("change", () => {
  localStorage.setItem(cookiesStorageKey, useBrowserCookiesInput.checked ? "1" : "0");
});
downloadSelectedButton.addEventListener("click", downloadSelectedVideos);
refreshButton.addEventListener("click", refreshTasks);
clearTasksButton?.addEventListener("click", clearFinishedTasks);
detachWindowButton?.addEventListener("click", openDetachedWindow);
loginAccountButton.addEventListener("click", loadAccountData);
loadAccountButton.addEventListener("click", loadAccountData);
logoutAccountButton.addEventListener("click", logoutAccount);
