@echo off
REM Launch Tauri dev app through WSL (requires WSLg)
wsl -e bash -lc "cd /mnt/c/workspace/windows-pdf-dir && source ~/.cargo/env && npm run tauri dev"
