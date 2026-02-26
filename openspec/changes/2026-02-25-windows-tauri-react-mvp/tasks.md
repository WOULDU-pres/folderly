# Implementation Tasks

## Product + UX
- [x] Finalize interaction map for 1-click preview and 2-click navigation.
- [x] Confirm list/gallery view parity for key actions.

## Frontend
- [x] Implement directory pane, path toolbar, and item grid/list switcher.
- [x] Implement preview panel behavior and supported file handling.
- [x] Add drag-handle UI for manual folder ordering.
- [x] Add drag-handle UI for manual file ordering (list view) and apply same manual order to gallery rendering.
- [x] Render right pane as mixed entries (folders + files), not files-only.
- [x] Allow right-pane folder activation to navigate into folder.
- [x] Add explorer operation controls + shortcuts (copy/cut/paste/delete/rename F2).
- [x] Add native drag-drop handlers for move/copy between explorer targets.
- [x] Add external drop import (window file-drop) into active preview path.
- [x] Add hidden-entry translucent rendering for files/folders.
- [x] Add top bookmark bar with pin/remove/navigate interactions.
- [x] Add fixed drive shortcuts section in sidebar.
- [x] Apply Pretendard font and Windows 11-like visual polish.
- [x] Add light-theme-only styling and remove dark-mode toggles.

## Backend (Tauri)
- [x] Implement filesystem read/list commands.
- [x] Implement drive discovery command (`list_drives`) for Windows/WSL.
- [x] Implement WSL path translation for Windows-style input paths.
- [x] Implement SQLite persistence for folder + file manual order.
- [x] Implement filesystem operation commands (`copy_paths`, `move_paths`, `delete_paths`, `rename_path`, `create_folder`).
- [x] Implement system-open command (`open_path_in_system`) for file/PDF open reliability.
- [x] Implement PDF page extraction command producing a single PDF.

## Quality
- [x] Unit tests for ordering logic and persistence mapping helpers.
- [x] Rust unit tests for copy/move/delete/rename command paths.
- [x] Build verification for frontend (`npm run build`).
- [x] Rust verification (`cargo test --manifest-path src-tauri/Cargo.toml`).

## Documentation
- [x] OpenSpec base spec + extended requirements updated and validated.
- [x] Change doc created.
- [x] Test plan created.
- [x] Verification report updated with current command evidence.
