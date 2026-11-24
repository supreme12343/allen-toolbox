@echo off
setlocal
rem Downloading this bundle does not run or approve its installer.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy AllSigned -File "%~dp0updater\install.ps1" %*
set "ALLEN_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %ALLEN_EXIT%
