const defaultDownloadDir = "%USERPROFILE%\\Desktop\\youtube videos";
const downloadDirStorageKey = "ytDlpDownloadDir";

const urlInput = document.getElementById("url");
const downloadDirInput = document.getElementById("downloadDir");
const qualityInput = document.getElementById("quality");
const useBrowserCookiesInput = document.getElementById("useBrowserCookies");
const useCurrentPageButton = document.getElementById("useCurrentPage");
const clearUrlButton = document.getElementById("clearUrl");
const qualityChips = [...document.querySelectorAll(".qualityChip")];
const cookiesStorageKey = "ytDlpUseCookies";
const statusText = document.getElementById("status");
const resolveButton = document.getElementById("resolve");
const downloadSelectedButton = document.getElementById("downloadSelected");
const refreshButton = document.getElementById("refresh");
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
    playlistMode: "single",
    speed: "5.2MiB/s",
    eta: "00:18",
    lastLine: "[download] 64.3% of 152.34MiB at 5.2MiB/s ETA 00:18"
  },
  {
    id: "demo-done",
    status: "done",
    percent: 100,
    quality: "audio",
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
let previewMode = "";
let oauthConfigured = true;

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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || "";
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

function syncQualityChips() {
  qualityChips.forEach(chip => {
    const active = chip.dataset.quality === qualityInput.value;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
  });
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
    renderVideos(resolvedVideos);
    const cookiesNote = response.cookiesSent
      ? ` Куки: ${response.cookiesSent} (${response.cookiesFrom || "браузер"}).`
      : "";
    setStatus(`Готово: найдено видео: ${resolvedVideos.length}.${cookiesNote}`, "success");
  } catch (error) {
    resolvedVideos = [];
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

  localStorage.setItem(downloadDirStorageKey, downloadDir);
  localStorage.setItem(cookiesStorageKey, useBrowserCookiesInput.checked ? "1" : "0");
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
        quality: qualityInput.value,
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
    <span>${escapeHtml(qualityText(qualityInput.value))}</span>
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
    const canCancel = status === "running" || status === "starting";

    return `
      <article class="task">
        <div class="taskTop">
          <strong><span class="statusPill ${escapeHtml(status)}">${escapeHtml(statusTextFor(status))}</span></strong>
          <span>${percent.toFixed(percent ? 1 : 0)}%</span>
        </div>
        <div class="bar"><span style="width:${percent}%"></span></div>
        <div class="meta">${escapeHtml(qualityText(quality))}${speed ? ` · ${escapeHtml(speed)}` : ""}${eta ? ` · ETA ${escapeHtml(eta)}` : ""}</div>
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
    "best-mp4": "Лучший MP4 одним файлом",
    "1080": "До 1080p",
    "720": "До 720p",
    "480": "До 480p",
    audio: "Только аудио MP3"
  }[value] || value;
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
  syncQualityChips();
}));
qualityInput.addEventListener("change", syncQualityChips);
useBrowserCookiesInput.addEventListener("change", () => {
  localStorage.setItem(cookiesStorageKey, useBrowserCookiesInput.checked ? "1" : "0");
});
downloadSelectedButton.addEventListener("click", downloadSelectedVideos);
refreshButton.addEventListener("click", refreshTasks);
loginAccountButton.addEventListener("click", loadAccountData);
loadAccountButton.addEventListener("click", loadAccountData);
logoutAccountButton.addEventListener("click", logoutAccount);
