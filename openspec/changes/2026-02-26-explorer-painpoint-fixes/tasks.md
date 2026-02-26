## Tasks

### Phase A: Zustand Store Extraction
- [x] A1: Create `src/store/useExplorerStore.ts` with navigation, selection, and UI slices
- [x] A2: Refactor App.tsx to consume Zustand store instead of local useState
- [x] A3: Verify TypeScript compiles and existing functionality works

### Phase B: UX Workflow Fixes
- [x] B1: Replace window.prompt in App.tsx rename with FileNameModal
- [x] B2: Add confirmation for destructive PDF extract in PdfViewer.tsx

### Phase C: Accessibility Completion
- [x] C1: Add tabIndex={0} and keyboard handlers to sidebar rows, table rows, gallery cards
- [x] C2: Add ARIA roles (role="grid", aria-selected, role="alert") to App.tsx elements

### Phase D: Dark Mode
- [x] D1: Add dark theme CSS variables and @media (prefers-color-scheme: dark) to styles.css

### Phase E: File Operations
- [x] E1: Create ContextMenu.tsx component with right-click handler integration
- [x] E2: Add rename_order_entry Rust command and call it after rename in App.tsx

### Phase F: Search & Progress
- [x] F1: Add search/filter input to command bar with Ctrl+F shortcut
- [x] F2: Add progress indicators to PDF extract and merge operations
