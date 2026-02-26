# Change: PDF Viewer Redesign

## Date
2026-02-25

## Summary
Replace the modal-based `PdfExtractModal` with a dual-panel `PdfViewer` component, add destructive page extraction, PDF merge from multiple sources, a direct file-byte IPC command to fix PDF loading, and a COM-based desktop shortcut in the installer.

## Scope

### PDF Dual-Panel Viewer (`PdfViewer` component)
- Replaced `PdfExtractModal` with `PdfViewer`, a near-fullscreen overlay (inset 24px).
- Left sidebar: 220px thumbnail list with scroll sync to the right pane.
- Right pane: large page preview with lazy loading via IntersectionObserver.
- Ordered selection UX: click-order badges displayed on selected thumbnails, selected thumbnails slide 8px right via `translateX(8px)` animation.
- Selection order (not page-number order) determines output page sequence.

### Destructive PDF Extraction (`extract_and_remove_pdf_pages` Rust command)
- New Tauri command that extracts selected pages to a new PDF and removes those pages from the original.
- Atomic write strategy: write to `.tmp` file, rename original to `.bak`, rename `.tmp` to original path. Cleans up `.bak` on success.
- Falls back to non-destructive copy when all pages are selected (original unchanged).

### PDF Merge (`merge_pdf_pages` Rust command)
- New Tauri command that merges selected pages from multiple source PDFs into one output PDF.
- Deep object copying with circular reference handling for safe page object duplication across source documents.

### PDF Fetch Fix (`read_file_bytes` Rust command)
- New Tauri command that reads a file's raw bytes and returns them over IPC.
- Bypasses `convertFileSrc` asset protocol which was broken for local PDF loading in the current Tauri configuration.
- Frontend passes the byte array directly to the PDF.js renderer.

### Installer Desktop Shortcut (`installer_stub.c`)
- Added COM-based `IShellLinkA` shortcut creation targeting the installed application executable.
- Shortcut is placed on the Windows desktop.
- Failure is non-fatal: installer completes successfully even if shortcut creation fails.

## Why

| Area | Reason |
|---|---|
| Dual-panel viewer | `PdfExtractModal` provided no spatial context between thumbnails and the full-page preview. Scroll sync and ordered-selection badges make multi-page selection intuitive. |
| Destructive extraction | Users needed a one-step "split off and remove" workflow. Atomic tmp→bak→rename prevents data loss if the process crashes mid-write. |
| PDF merge | Users needed to combine pages from multiple source PDFs without leaving the app. |
| `read_file_bytes` | `convertFileSrc` asset protocol did not reliably serve local files in the Tauri WebView on Windows. IPC byte transfer is a reliable fallback. |
| Desktop shortcut | Standard Windows installer expectation. Non-fatal design avoids blocking installs on locked/unusual desktop configurations. |

## Files Affected

### Frontend
- `src/components/PdfViewer.tsx` — new dual-panel viewer component (replaces `PdfExtractModal`)
- `src/components/PdfExtractModal.tsx` — removed / superseded
- `src/App.tsx` — updated to mount `PdfViewer` instead of `PdfExtractModal`

### Backend (Tauri / Rust)
- `src-tauri/src/main.rs` — registered three new Tauri commands: `extract_and_remove_pdf_pages`, `merge_pdf_pages`, `read_file_bytes`
- `src-tauri/src/pdf.rs` — implemented `extract_and_remove_pdf_pages` and `merge_pdf_pages` logic
- `src-tauri/src/fs_commands.rs` — implemented `read_file_bytes` command

### Installer
- `tools/installer_stub.c` — added COM `IShellLinkA` desktop shortcut creation block

### OpenSpec
- `openspec/specs/windows-file-explorer-mvp/spec.md` — added requirements for dual-panel viewer, destructive extraction, PDF merge, IPC byte read, and desktop shortcut
- `openspec/changes/2026-02-25-pdf-viewer-redesign/change.md` — this document

## Out of Scope
- Dark theme for PDF viewer
- Multi-window PDF comparison
- Cloud/remote PDF sources
- Undo for destructive extraction (`.bak` file is cleaned up on success)

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Atomic rename fails on Windows if `.bak` already exists | Pre-delete stale `.bak` before rename sequence |
| IntersectionObserver unavailable in older WebView | Feature-detect and fall back to eager render |
| COM shortcut creation blocked by policy or UAC | Wrapped in non-fatal error path; install proceeds |
| Circular references in PDF object graph during merge | Deep-copy with visited-set guards against infinite loops |
