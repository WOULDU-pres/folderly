# Handoff: Explorer Pain Point Fixes — Deferred Items

## Context

Two sessions audited and fixed 22 of 28 UX pain points in the Tauri file explorer app.
The following 6 items were explicitly deferred due to complexity, platform dependencies, or scope.

### Commits (in order)
1. `590627e` — Memory leaks, focus-visible, DragOverlay, loading guards, color contrast, lang="ko"
2. `c21f199` — Zustand store, dark mode, context menu, search bar, ARIA roles, FileNameModal for rename/create, destructive extract confirmation
3. `f0a9fe0` — ProgressBar integration, rename_order_entry call, dark mode modal fixes

---

## Deferred Items

### P1 #5: Trash / Recycle Bin (휴지통)
**Priority:** P1 (High)
**Problem:** `delete_paths` permanently deletes files. No recovery possible on user mistake.
**Why deferred:** Requires platform-specific APIs — Windows `SHFileOperation` or `IFileOperation` with `FOFX_RECYCLEONDELETE`, macOS `NSFileManager.trashItem`. Linux has `trash-cli` or freedesktop trash spec.
**Approach:**
- Add a Rust crate like `trash` (https://crates.io/crates/trash) which provides cross-platform trash support
- Replace `std::fs::remove_file` / `remove_dir_all` in `src-tauri/src/fs.rs` `delete_paths` with `trash::delete`
- Add a user-facing toggle or always default to trash (with permanent delete as Shift+Delete)
- Update `src/App.tsx` delete confirmation text to reflect "휴지통으로 이동" instead of "삭제"
**Files:** `src-tauri/Cargo.toml` (add `trash` dep), `src-tauri/src/fs.rs` (`delete_paths`), `src/App.tsx` (UI text)
**Estimated scope:** Small — mostly a crate swap + UI text change

### P1 #8: Large Directory Performance (대용량 디렉토리)
**Priority:** P1 (High)
**Problem:** `list_folders` and `list_files` load all entries synchronously. Directories with 10,000+ items cause UI freezes.
**Why deferred:** Requires backend async streaming and frontend virtualization.
**Approach:**
- **Backend:** Convert `list_folders`/`list_files` in `src-tauri/src/fs.rs` to streaming with Tauri events. Use `read_dir` iterator with batch emit (e.g., 200 items per event).
- **Frontend:** Add virtual scrolling to the table and gallery views. Use `react-window` or `@tanstack/react-virtual`.
- **Incremental alternative:** Add pagination (load first 500, "load more" button) as a simpler first step.
**Files:** `src-tauri/src/fs.rs`, `src/App.tsx` (table/gallery rendering), `package.json` (virtual scroll dep)
**Estimated scope:** Medium-Large — backend streaming + frontend virtualization

### P2 #13: Undo System (Ctrl+Z 실행 취소)
**Priority:** P2 (Medium)
**Problem:** No undo for file operations (rename, move, delete, paste). Users cannot recover from mistakes.
**Why deferred:** Requires a state history stack with operation-specific reversal logic.
**Approach:**
- Create an `UndoStack` in the Zustand store (`src/store/useExplorerStore.ts`)
- Each file operation (rename, move, copy, delete) pushes an undo entry: `{ type, payload, reverse() }`
  - rename: `{ oldPath, newPath }` → reverse = rename back
  - move: `{ paths, source, destination }` → reverse = move back
  - delete: requires trash integration (P1 #5) — reverse = restore from trash
  - copy: `{ copiedPaths }` → reverse = delete copies
- Add Ctrl+Z keyboard handler in the global keydown listener
- Show undo toast with "실행 취소" button (auto-dismiss after 5s)
**Dependencies:** P1 #5 (trash) should be implemented first so delete can be undone
**Files:** `src/store/useExplorerStore.ts` (undo slice), `src/App.tsx` (keyboard handler, undo toast)
**Estimated scope:** Medium — state management + per-operation reversal logic

### P2 #21: Path Edge Cases (한글/특수문자/긴 경로)
**Priority:** P2 (Medium)
**Problem:** Potential issues with Korean characters, special characters (spaces, `&`, `#`), and very long paths (>260 chars on Windows).
**Why deferred:** Requires extensive cross-platform testing on actual Windows with real filesystem.
**Approach:**
- **Audit:** Test all Rust commands with paths containing: 한글, spaces, `&`, `#`, `()`, Unicode emoji, paths > 260 chars
- **Backend fixes in `src-tauri/src/fs.rs`:**
  - Use `\\?\` prefix for long paths on Windows (extended-length path)
  - Ensure all `PathBuf` operations handle Unicode correctly (Rust does this natively, but edge cases exist with Windows API)
  - Add proper error messages for invalid paths
- **Frontend fixes:**
  - `src/utils/path.ts` — verify `getFileDirectory`, `toCustomNamePdfPath` handle special chars
  - `src/App.tsx` — ensure breadcrumbs render correctly with special chars
  - URL encoding for `convertFileSrc()` calls with special character paths
- **Testing:** Add integration tests with Unicode paths in `src-tauri/src/fs.rs` tests
**Files:** `src-tauri/src/fs.rs`, `src/utils/path.ts`, `src/App.tsx`
**Estimated scope:** Medium — mostly testing and edge case fixes

### P3 #23-28: Future Iterations (향후 개선)
**Priority:** P3 (Low)

| # | Issue | Notes |
|---|-------|-------|
| 23 | 갤러리 뷰 수동 정렬 미지원 | Add @dnd-kit to gallery view. Currently only list view supports manual ordering via `SortableContext`. Need to wrap gallery cards in `SortableContext` with `rectSortingStrategy`. |
| 24 | 정렬 옵션 부족 (이름/크기/날짜 등) | Add `size` to `SortMode` type in `src/types.ts`. Update `sortFiles`/`sortFolders` in `src/utils/folderOrder.ts`. Add option to sort select in command bar. |
| 25 | 인라인 파일명 편집 미지원 | Double-click on filename cell → convert to editable input. On Enter/blur → rename. Needs careful focus management. |
| 26 | 사이드바 폴더 멀티선택 미지원 | Allow Ctrl+Click on sidebar folders to select multiple. Show combined contents in preview pane. Mainly UI state change in `handleSidebarFolderClick`. |
| 27 | 터치 타겟 크기 부족 (모바일 대응) | Increase min-height of `.sidebar-row`, `.table-row` to 44px. Add touch-specific padding. Consider `@media (pointer: coarse)` for touch devices. |
| 28 | 에러/성공 토스트 스타일 혼동 | Currently both use `.error-toast`. Create separate `.success-toast` class with green border/bg. Distinguish visually between error, success, and info states. |

---

## Architecture Reference

### Key Files
| File | Purpose |
|------|---------|
| `src/store/useExplorerStore.ts` | Zustand store — navigation, selection, UI state |
| `src/App.tsx` | Main component — ~1380 lines, uses store + local state for modals/drag |
| `src/components/PdfViewer.tsx` | PDF viewer with extract, rename, zoom |
| `src/components/PdfMergeModal.tsx` | PDF merge with preview |
| `src/components/ContextMenu.tsx` | Right-click context menu (not yet connected to sidebar) |
| `src/components/SearchBar.tsx` | Ctrl+F search filter |
| `src/components/ProgressBar.tsx` | Determinate progress bar |
| `src/components/FileNameModal.tsx` | Generic filename input modal |
| `src/styles.css` | All styles with CSS variables + dark mode |
| `src-tauri/src/fs.rs` | All filesystem Tauri commands |
| `src-tauri/src/order.rs` | Manual order SQLite persistence |
| `src-tauri/src/pdf.rs` | PDF extract/merge (lopdf) |
| `src-tauri/src/lib.rs` | Tauri command registration |

### Tech Stack
- **Frontend:** React 19, TypeScript 5.8, Zustand 5, @dnd-kit, pdfjs-dist, lucide-react, Vite 7
- **Backend:** Rust, Tauri 2, lopdf, rusqlite
- **Testing:** Vitest (frontend), cargo test (backend)

### Build & Test Commands
```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run dev          # vite dev server
cd src-tauri && cargo test  # Rust tests
```

---

## Decisions Made (for context)
- **Zustand over Redux/Context:** Already in package.json, minimal boilerplate, good React 19 compatibility
- **CSS variables over CSS-in-JS:** Dark mode via `prefers-color-scheme` media query, no runtime cost
- **FileNameModal reuse:** Single generic modal for rename, create folder, extract filename, merge filename
- **Non-destructive extract as default:** Users must explicitly opt-in to destructive (extract + remove from original) operation
- **Best-effort order DB sync:** `rename_order_entry` failure doesn't block the rename operation (`.catch(() => {})`)
- **Client-side search only:** SearchBar filters current directory entries in memory, no backend search API
