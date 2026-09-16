@echo off
setlocal
set ROOT=%~dp0

rem C# host needs the .NET 8 SDK. If it is missing, fall back to the
rem Python host (only needs Python + yt-dlp, no compilation).
where dotnet >nul 2>nul
if %errorlevel%==0 goto :csharp

echo .NET SDK (dotnet) not found - using the Python host instead.
where python >nul 2>nul
if %errorlevel%==0 goto :pythonhost
echo ERROR: neither 'dotnet' nor 'python' was found in PATH.
echo Install Python 3.8+ from https://www.python.org/downloads/
echo ^(tick "Add python.exe to PATH" during setup^), then run this file again.
pause & exit /b 1

:pythonhost
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%native-host\python-host\install-python-host.ps1"
if errorlevel 1 pause & exit /b 1
pause
exit /b 0

:csharp
echo Found .NET SDK - building the C# host.
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%native-host\build-host.ps1"
if errorlevel 1 pause & exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%native-host\install-native-host.ps1"
pause
