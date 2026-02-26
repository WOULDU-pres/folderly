# Change: Windows Tauri+React File Explorer MVP

## Date
2026-02-25

## Summary
Deliver an MVP desktop file explorer optimized for Windows with preview-first browsing, flexible folder ordering, dual views, and PDF page extraction.

## Scope
- Tauri + React + TypeScript application scaffolding.
- 1-click preview and 2-click folder navigation interactions.
- Auto/manual folder/file ordering and SQLite persistence for manual order.
- Gallery and list views.
- PDF page-selection extraction into one output PDF.
- Hidden file/folder rendering with translucency (not filtered out).
- Bookmark bar (Chrome-like pin strip) for quick folder access.
- Drive discovery + fixed drive shortcuts (C/D/G/I...) in sidebar.
- WSL Windows-path compatibility (`C:\...` -> `/mnt/c/...`) and C-root defaulting.
- Pretendard typography and Windows 11-inspired visual tuning.
- `ui-ux-pro-max` skill guidance 적용(탐색기 UI 계층/간격/톤 보정).
- Right pane mixed entry view (folders + files) with folder navigation.
- File-system operations: copy/cut/paste/delete/rename(F2) and drag-drop move/copy.
- External file drop import into active preview path.
- Native system-open command for reliable local file/PDF open behavior.
- Light-theme-only UI.
- Verification evidence and test documentation.

## Out of Scope
- Dark theme
- Online sync/collaboration
- Enterprise auth/permissions systems

## Risks
- Native filesystem behavior differences between Windows and non-Windows developer environments.
- PDF extraction reliability on malformed PDFs.
- Drag-and-drop reordering ergonomics in large directories.
- WSL and Windows path normalization edge cases (separator and drive-root handling).
- Large directories containing hidden/system entries can impact rendering performance.

## Mitigations
- Keep Tauri command boundaries small and testable.
- Add deterministic PDF extraction tests with fixtures.
- Document manual test paths for interaction-heavy behaviors.
