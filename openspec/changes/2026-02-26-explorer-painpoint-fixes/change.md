## Summary
Fix remaining 13 pain points found during file explorer UX audit. Covers state management refactoring, accessibility hardening, UX workflow improvements, and visual polish.

## Motivation
The initial audit found 28 issues. The first pass resolved 15 of them (memory leaks, focus styles, DragOverlay, color contrast, lang, FileNameModal hardcoding, loading guards). This change addresses the remaining 13 issues across P0-P2 priority.

## Scope

### Phase A: State Management (P0 #2)
**Extract Zustand store from App.tsx God Component**
- Create `src/store/useExplorerStore.ts` with Zustand
- Move navigation state (currentDir, previewDir, folders, files, drives, bookmarks) to store
- Move selection state (selectedEntries, clipboard) to store
- Move UI state (viewMode, sortMode, orderMode, error) to store
- Keep local-only state in App.tsx (modals open/closed, drag state)
- Benefit: eliminates unnecessary re-renders, cleaner code

### Phase B: UX Workflow Fixes (P1 #4, #7)
**B1: Replace window.prompt with FileNameModal for rename (P1 #4)**
- In App.tsx `renameSelected`: replace `window.prompt()` with `FileNameModal`
- Add `renameModalOpen` state and `renameTarget` state
- Reuse the existing FileNameModal component (now generic after Phase 1 fix)

**B2: Add confirmation dialog for destructive PDF extract (P1 #7)**
- In PdfViewer.tsx: when partial selection, show a confirmation before `extract_and_remove_pdf_pages`
- Add a simple confirm modal or use a state flag to show warning text
- Default to non-destructive extract; require explicit opt-in for destructive mode

### Phase C: Accessibility (P0 #3 remaining, P1 #10)
**C1: Add tabIndex to interactive rows (P0 #3 completion)**
- Sidebar folder rows: add `tabIndex={0}` and `onKeyDown` for Enter/Space
- Table file rows: add `tabIndex={0}` and `onKeyDown` for Enter/Space
- Gallery cards: add `tabIndex={0}` and `onKeyDown` for Enter/Space
- PDF thumbnail cards: add `tabIndex={0}` and `onKeyDown`

**C2: Add ARIA roles and attributes (P1 #10)**
- `.table-head` + `.table-body`: add `role="grid"`, `role="rowgroup"`, `role="row"`, `role="gridcell"`
- Selected rows: add `aria-selected="true"`
- Error toast: add `role="alert"` and `aria-live="assertive"`
- Sidebar folder list: add `role="listbox"`, items `role="option"`
- Drive list: add `role="listbox"`

### Phase D: Dark Mode (P2 #17)
- Add CSS custom properties for dark theme in `:root` and `@media (prefers-color-scheme: dark)`
- Map all existing hardcoded colors to CSS variables
- Cover: backgrounds, borders, text, accents, shadows, modals, PDF viewer

### Phase E: File Operations (P2 #12, #15)
**E1: Context menu (P2 #12)**
- Create `src/components/ContextMenu.tsx`
- Add `onContextMenu` handler to file/folder rows
- Menu items: Open, Rename (F2), Copy (Ctrl+C), Cut (Ctrl+X), Paste (Ctrl+V), Delete (Del), Open in System
- Position menu at mouse coordinates, close on click outside or Escape

**E2: Rename → order DB sync (P2 #15)**
- After successful rename in App.tsx, call `save_manual_order` / `save_file_manual_order` to update the order entry with the new path
- In Rust `order.rs`: add `rename_order_entry` command that updates the path key in SQLite

### Phase F: Search & Progress (P2 #20, #22)
**F1: Search/filter bar (P2 #20)**
- Add search input in command bar (Ctrl+F to focus)
- Filter folders and files by name substring (client-side)
- Clear filter on directory navigation

**F2: Progress indicators for PDF operations (P2 #22)**
- PdfViewer extract: show progress bar during extraction
- PdfMergeModal merge: show progress during merge
- Use a simple determinate progress bar (current page / total pages)

## Non-goals
- P2 #13 Undo system: complex state history management, deferred to future
- P2 #21 Path edge cases: requires extensive cross-platform testing, deferred
- P2 #8 Large directory performance: requires backend async streaming, deferred
- P1 #5 Trash/recycle bin: requires platform-specific APIs, deferred
- P3 items (#23-28): deferred to future iterations

## Files to modify
- `src/store/useExplorerStore.ts` (NEW)
- `src/App.tsx` (major refactor)
- `src/components/PdfViewer.tsx`
- `src/components/ContextMenu.tsx` (NEW)
- `src/styles.css`
- `src/types.ts`
- `src-tauri/src/order.rs`
- `src-tauri/src/lib.rs`

## Risk
- Phase A (Zustand) is the highest risk as it touches App.tsx extensively
- Phase D (dark mode) is largely CSS-only, low risk
- Phase E1 (context menu) is a new component, moderate risk
