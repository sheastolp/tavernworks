@echo off
rem AI Pool worker - one-step setup (Windows).
rem
rem Downloads the pool worker from the pool's own downloads shelf
rem and starts it. First run enrolls this machine (name = this
rem PC's name, offered memory = a conservative auto-size) and
rem waits for the operator's approval; once approved it prints
rem a personal link that ties the machine to your pool account.
rem Any extra arguments are passed through to the worker, e.g.:
rem   install-worker.bat --offered-mb 4096
setlocal
set "SHELF=https://pool.tavernworks.dev/downloads"
set "DIR=%USERPROFILE%\pool-worker"

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  set "PY=py"
) else (
  where python >nul 2>nul
  if %ERRORLEVEL%==0 (
    set "PY=python"
  ) else (
    echo Python 3 is required. Install it from https://www.python.org/downloads/
    echo ^(tick "Add python.exe to PATH" in the installer^), then run this again.
    pause
    exit /b 1
  )
)

if not exist "%DIR%" mkdir "%DIR%"
echo Downloading the pool worker from %SHELF% ...
curl -fsSL "%SHELF%/pool-worker.py" -o "%DIR%\pool-worker.py"
if %ERRORLEVEL% neq 0 (
  echo Download failed - check your connection and try again.
  pause
  exit /b 1
)
echo Starting the worker - leave this window open; it enrolls
echo this machine and waits for the operator's approval.
%PY% "%DIR%\pool-worker.py" %*
pause
