# Test Plan: Windows File Explorer MVP

## Objectives
Validate critical MVP behaviors and capture reproducible verification evidence.

## Environments
- Primary: Windows 11
- Secondary: Linux/macOS for non-OS-specific UI/unit checks

## Automated Verification (target commands)
- `npm run lint`
- `npm run test`
- `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`

## Functional Test Matrix

### Navigation + Preview
1. Single-click file -> preview opens without navigation.
2. Double-click folder -> navigation enters folder.
3. Switching views does not reset current path.
4. Startup path defaults to C drive (`C:\` on Windows, `/mnt/c` on WSL when available).
5. Right pane includes both folders and files for the active preview path.
6. Activating a right-pane folder entry navigates into that folder.

### Ordering
1. Auto sort by name/date renders deterministic order.
2. Manual drag reorder persists after restart.
3. Manual order only affects folders for configured path.
4. Manual file drag reorder persists after restart and does not overwrite folder order data.
5. Manual mixed-entry reorder in right pane persists for preview path.

### Drive + Bookmark UX
1. Sidebar shows detected drives and supports direct navigation.
2. Pinning a folder creates bookmark chip in top bar.
3. Clicking bookmark chip navigates to pinned path.
4. Removing bookmark chip updates persistence (localStorage).

### Hidden Entry Rendering
1. Hidden file/folder entries are present in listings.
2. Hidden entries are rendered with reduced opacity in list/gallery/sidebar.

### PDF Extraction
1. Select source PDF and page subset.
2. Generate output PDF.
3. Open output and confirm selected pages/order only.

### Theme
1. Light theme appears consistently across app surfaces.
2. No dark mode toggle/settings in MVP UI.
3. Pretendard font is applied across primary UI components.

### File Operations + Shortcuts
1. `Ctrl/Cmd+C`, `Ctrl/Cmd+X`, `Ctrl/Cmd+V` perform copy/cut/paste on selected entry.
2. `Delete` removes selected entry after confirmation.
3. `F2` renames selected entry.
4. Internal drag-drop to folder/drive performs move (copy with Ctrl modifier).
5. External drag-drop file(s) into window imports into active preview path.
6. `Ctrl/Cmd+Shift+N` creates new folder in active preview path.

### Open Behavior
1. Double-click PDF/file launches OS default handler via system open command.

## Evidence to Capture
- Command outputs for lint/test/build/cargo test.
- Screenshots/gifs for navigation, reorder, and PDF extraction flow.
- Hash/size check of generated PDF artifacts.
