@echo off
REM ============================================================
REM  Windows PDF Explorer - Full Build Script
REM  Run this on native Windows terminal with Node.js + Rust installed
REM  Optional: MSVC (cl.exe) for building the installer EXE
REM ============================================================
cd /d %~dp0

echo [1/4] Installing npm dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

echo.
echo [2/4] Building Tauri app (frontend + Rust backend)...
call npm run tauri build
if errorlevel 1 (
    echo ERROR: tauri build failed
    pause
    exit /b 1
)

REM Find the built EXE and WebView2Loader.dll
set "TAURI_EXE=src-tauri\target\release\Windows PDF Directory Explorer.exe"
set "WV2_DLL=src-tauri\target\release\WebView2Loader.dll"

if not exist "%TAURI_EXE%" (
    echo ERROR: Tauri EXE not found at %TAURI_EXE%
    pause
    exit /b 1
)

REM Create release-win directory
if not exist release-win mkdir release-win

echo.
echo [3/4] Copying standalone EXE...
copy /Y "%TAURI_EXE%" "release-win\WindowsPdfExplorer.exe" >nul
if exist "%WV2_DLL%" (
    copy /Y "%WV2_DLL%" "release-win\WebView2Loader.dll" >nul
)

echo.
echo [4/4] Building installer EXE...

REM Try MSVC first (cl.exe)
where cl >nul 2>&1
if %errorlevel%==0 (
    echo   Using MSVC...
    cl /nologo /O2 /Fe:"release-win\WindowsPdfExplorer-Installer.exe" ^
       tools\installer\installer_stub.c ^
       /link shell32.lib ole32.lib uuid.lib user32.lib
    if errorlevel 1 (
        echo   WARNING: MSVC build failed, trying alternative...
        goto :try_gcc
    )
    goto :pack_installer
)

:try_gcc
REM Try MinGW/GCC
where gcc >nul 2>&1
if %errorlevel%==0 (
    echo   Using GCC...
    gcc -O2 -mwindows -o "release-win\WindowsPdfExplorer-Installer.exe" ^
        tools\installer\installer_stub.c ^
        -lshell32 -lole32 -luuid -luser32
    if errorlevel 1 (
        echo   WARNING: GCC build failed, skipping installer EXE
        goto :no_installer
    )
    goto :pack_installer
)

echo   No C compiler found (cl.exe or gcc). Skipping installer EXE.
goto :no_installer

:pack_installer
REM Pack the Tauri EXE + WebView2Loader.dll into the installer
echo   Packing payload into installer...
powershell -NoProfile -Command ^
    "$stub = [IO.File]::ReadAllBytes('release-win\WindowsPdfExplorer-Installer.exe');" ^
    "$exe = [IO.File]::ReadAllBytes('release-win\WindowsPdfExplorer.exe');" ^
    "$dllPath = 'release-win\WebView2Loader.dll';" ^
    "$dll = if (Test-Path $dllPath) { [IO.File]::ReadAllBytes($dllPath) } else { [byte[]]::new(0) };" ^
    "$magic = [Text.Encoding]::ASCII.GetBytes('WPDIINS1');" ^
    "$exeSize = [BitConverter]::GetBytes([uint64]$exe.Length);" ^
    "$dllSize = [BitConverter]::GetBytes([uint64]$dll.Length);" ^
    "$out = [IO.File]::Create('release-win\WindowsPdfExplorer-Installer.exe');" ^
    "$out.Write($stub, 0, $stub.Length);" ^
    "$out.Write($exe, 0, $exe.Length);" ^
    "$out.Write($dll, 0, $dll.Length);" ^
    "$out.Write($magic, 0, 8);" ^
    "$out.Write($exeSize, 0, 8);" ^
    "$out.Write($dllSize, 0, 8);" ^
    "$out.Close();" ^
    "Write-Host '  Installer packed successfully.'"
if errorlevel 1 (
    echo   WARNING: Failed to pack installer
    goto :no_installer
)
goto :done

:no_installer
echo.
echo   Standalone EXE is still available at:
echo     release-win\WindowsPdfExplorer.exe

:done
echo.
echo ============================================================
echo  Build completed!
echo.
echo  Standalone EXE:
echo    release-win\WindowsPdfExplorer.exe
if exist "release-win\WebView2Loader.dll" (
echo    release-win\WebView2Loader.dll
)
echo.
if exist "release-win\WindowsPdfExplorer-Installer.exe" (
echo  Installer EXE (with desktop shortcut):
echo    release-win\WindowsPdfExplorer-Installer.exe
)
echo.
echo  MSI Installer:
echo    src-tauri\target\release\bundle\msi\
echo ============================================================
echo.
pause
