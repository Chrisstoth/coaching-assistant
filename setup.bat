@echo off
echo Setting up LaneWatch AI...
echo.

REM Check Python
python --version 2>nul || (echo ERROR: Python not found. Install Python 3.11+ from python.org && pause && exit /b 1)

REM Install Python deps
echo Installing Python dependencies...
cd /d "%~dp0backend"
pip install -r requirements.txt
if errorlevel 1 (echo ERROR: pip install failed && pause && exit /b 1)

REM Create .env if not exists
cd /d "%~dp0"
if not exist ".env" (
    echo Creating .env from template...
    copy ".env.example" ".env"
    echo.
    echo IMPORTANT: Edit .env and add your API keys before starting!
    notepad .env
)

echo.
echo Setup complete! Run start.bat to launch the app.
pause
