@echo off
setlocal

set "NODE=%LOCALAPPDATA%\OpenAI\Codex\bin\node.exe"
set "SCRIPT=%~dp0src\weekly.js"

if not exist "%NODE%" (
  echo Could not find Codex's bundled Node at "%NODE%".
  echo Install Node.js or run from Codex.
  exit /b 1
)

"%NODE%" "%SCRIPT%"
