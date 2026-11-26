@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.bun\bin;%ProgramFiles%\Tailscale;%ProgramFiles%\cloudflared;%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"

where bun >nul 2>&1
if errorlevel 1 (
  set "INSTALL_BUN=Y"
  set /p "INSTALL_BUN=Bun 런타임이 설치되어 있지 않습니다. 지금 자동으로 설치할까요? [Y/n]: "
  if /i "!INSTALL_BUN!"=="" set "INSTALL_BUN=Y"
  if /i "!INSTALL_BUN!"=="Y" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
    set "PATH=%USERPROFILE%\.bun\bin;!PATH!"
  )
)

where bun >nul 2>&1
if errorlevel 1 (
  echo [오류] Bun 런타임이 필요합니다.
  echo 설치 명령 ^(PowerShell^): powershell -c "irm bun.sh/install.ps1 | iex"
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/2] 의존성 설치 중 ^(bun install^)...
  if exist "bun.lock" (
    call bun install --frozen-lockfile
  ) else (
    call bun install
  )
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

call bun run src/cli.ts up %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo 오류가 발생해 종료되었습니다 ^(코드 %EXIT_CODE%^).
  pause
)
exit /b %EXIT_CODE%
