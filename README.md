# YouTube yt-dlp Downloader

Расширение для Chromium-браузеров: отправляет видео и плейлисты YouTube в локальный `yt-dlp`
через Chrome Native Messaging. Работает в Chrome, Edge, Brave, Vivaldi, Opera и Яндекс Браузере.

Корень репозитория — это само расширение (загрузка unpacked). `native-host/` — обязательный
локальный компонент: без него кнопки «Найти» и «Скачать» не работают.

## Требования

- Любой Chromium-браузер с поддержкой Manifest V3
- `yt-dlp` в `PATH` (или переменная `YTDLP_PATH`)
- `ffmpeg` в `PATH` (слияние видео+аудио, извлечение MP3/M4A/Opus/WAV)
- Для Python-хоста (рекомендуется): Python 3.8+
- Для C#-хоста: .NET 8 SDK

## 1. Установка расширения

Включите режим разработчика и выберите «Загрузить распакованное», указав корень репозитория.

| Браузер | Страница расширений |
|---|---|
| Chrome | `chrome://extensions` |
| Edge | `edge://extensions` |
| Brave | `brave://extensions` |
| Vivaldi | `vivaldi://extensions` |
| Opera | `opera://extensions` |
| Яндекс Браузер | `browser://extensions` |

Благодаря встроенному `key` в `manifest.json` расширение получает одинаковый ID
`lgdfehfacdnpknkphkfmmollklciaaal` во всех браузерах — переустанавливать хост
при смене браузера не нужно.

## 2. Установка native-хоста (Windows)

Вариант Python — без компиляции, регистрирует хост сразу во всех браузерах:

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\python-host\install-python-host.ps1
```

Вариант C# (нужен .NET 8 SDK):

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\build-host.ps1
powershell -ExecutionPolicy Bypass -File .\native-host\install-native-host.ps1
```

Оба скрипта пишут манифест хоста и регистрируют его в `HKCU\...\NativeMessagingHosts`
для Chrome, Chromium, Edge, Brave, Vivaldi, Opera и Яндекс Браузера.
После установки перезапустите браузер.

## 3. Установка native-хоста (macOS / Linux)

```bash
./native-host/build-host.sh
EXTENSION_ID=lgdfehfacdnpknkphkfmmollklciaaal ./native-host/install-native-host.sh
```

Манифест ставится во все найденные каталоги `NativeMessagingHosts`
(Chrome, Chromium, Edge, Brave, Vivaldi, Opera, Yandex).

## Форматы (v0.3.0)

- Видео: лучший MP4 одним файлом, лучшее доступное, 144p–4320p (8K)
- Кодек видео: авто, AV1, VP9, AVC/H.264
- Аудио: MP3, M4A, OPUS, WAV, оригинал без конвертации

## Ограничения

- Вкладка «Аккаунт» (вход через Google OAuth) полноценно работает только в Chrome
  с настроенным Client ID в `manifest.json`. В остальных браузерах поиск, загрузка,
  куки и недавние видео из истории работают без входа.
- Качайте только контент, на который у вас есть права.
