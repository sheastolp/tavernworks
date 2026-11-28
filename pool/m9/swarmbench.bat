@echo off
rem SwarmBench for Windows: double-click to test the model server on this PC,
rem or run  swarmbench.bat http://host:port  for another one.
set SB=%~dp0swarmbench.py
if not exist "%SB%" (
  echo Downloading swarmbench.py ...
  powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing https://pool.tavernworks.dev/downloads/swarmbench.py -OutFile '%SB%'"
)
where py >nul 2>nul
if %errorlevel%==0 (py -3 "%SB%" %*) else (python "%SB%" %*)
if errorlevel 9009 echo Python 3 is needed: get it from python.org, then run this again.
pause
