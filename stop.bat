@echo off
title Stopping LaneWatch AI
color 04

echo.
echo  Stopping LaneWatch AI...
echo.

REM Kill by port 8001 (backend)
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8001 " ^| findstr "LISTENING"') do (
    echo  Stopping backend (PID %%a)...
    taskkill /F /PID %%a >nul 2>&1
)

REM Kill by port 5173 (frontend)
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":5173 " ^| findstr "LISTENING"') do (
    echo  Stopping frontend (PID %%a)...
    taskkill /F /PID %%a >nul 2>&1
)

REM Also close the terminal windows by title
taskkill /FI "WINDOWTITLE eq CA - Backend" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq CA - Frontend" /F >nul 2>&1

echo.
echo  Done. Both servers stopped.
echo.
timeout /t 2 /nobreak >nul
