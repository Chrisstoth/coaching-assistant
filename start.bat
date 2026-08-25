@echo off
title LaneWatch AI
color 0A

echo.
echo  ==========================================
echo   LANEWATCH AI
echo  ==========================================
echo.

REM Kill anything already on the ports
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8001 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":5173 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

REM Start backend
start "CA - Backend" cmd /k "cd /d "%~dp0" && echo [Backend starting...] && python -m uvicorn backend.main:app --host 0.0.0.0 --port 8001 --reload"

REM Wait for backend
timeout /t 3 /nobreak >nul

REM Start frontend
start "CA - Frontend" cmd /k "cd /d "%~dp0frontend" && echo [Frontend starting...] && npm run dev -- --host"

echo  Backend:   http://localhost:8001
echo  Frontend:  http://localhost:5173
echo  API docs:  http://localhost:8001/docs
echo.

REM Get local IP for phone access
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /R "IPv4.*192\."') do (
    set IP=%%a
    set IP=!IP: =!
)
setlocal enabledelayedexpansion
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /R "IPv4.*192\."') do (
    set LOCALIP=%%a
)
set LOCALIP=%LOCALIP: =%

echo  On your phone: http://%LOCALIP%:5173
echo.
echo  Close this window or run stop.bat to shut down.
echo.
pause
