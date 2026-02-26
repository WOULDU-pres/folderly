## Purpose
Provide a Windows-first desktop file explorer MVP focused on fast folder browsing, custom folder ordering, and PDF page extraction.

## Requirements
### Requirement: Windows desktop shell and local filesystem access
The app SHALL run as a Tauri desktop application and read local filesystem data through backend commands.

#### Scenario: Launch explorer shell
- **WHEN** the app starts
- **THEN** it shows the explorer workspace and loads folders from the default root path.

### Requirement: Drive shortcuts and Windows-path compatibility
The app SHALL expose available drives as quick shortcuts and support Windows-style paths in WSL environments.

#### Scenario: Load default root on WSL/Windows
- **WHEN** the app boots on WSL with `/mnt/c` available (or on Windows with `C:\`)
- **THEN** the explorer starts from C drive root.

#### Scenario: Open drive from sidebar
- **WHEN** a user selects a drive shortcut (for example `C:`, `D:`)
- **THEN** the folder pane reloads using that drive root path.

### Requirement: Single-click preview and double-click navigation
The app SHALL support one-click folder preview and double-click folder navigation.

#### Scenario: Preview a folder with one click
- **WHEN** a user single-clicks a folder in the left pane
- **THEN** the right pane displays that folder’s files.

#### Scenario: Navigate into folder with double click
- **WHEN** a user double-clicks a folder in the left pane
- **THEN** the current path changes to that folder and the folder list reloads.

### Requirement: Right pane mixed explorer entries
The right pane SHALL show both folders and files for the active preview path.

#### Scenario: Show folder and file entries together
- **WHEN** the user opens or previews a path
- **THEN** the right pane renders folders and files together in list/gallery views.

#### Scenario: Open folder from right pane
- **WHEN** the user activates a folder entry in the right pane
- **THEN** the explorer navigates into that folder path.

### Requirement: Auto and manual folder ordering modes
The app SHALL provide auto-sort and manual drag-order modes for folders.

#### Scenario: Auto sort mode
- **WHEN** manual mode is OFF
- **THEN** folder order follows the selected auto sort key (name or modified date).

#### Scenario: Manual drag mode
- **WHEN** manual mode is ON and the user drags folder rows by the handle
- **THEN** the custom order is applied and persisted for the current parent path.

### Requirement: Auto and manual file ordering modes
The app SHALL provide auto-sort and manual drag-order modes for files.

#### Scenario: Manual file drag mode
- **WHEN** manual mode is ON and the user drags file rows by the handle
- **THEN** the custom file order is applied and persisted for the selected folder path.

#### Scenario: Manual mixed-entry drag mode
- **WHEN** manual mode is ON in the right pane
- **THEN** mixed folder/file entry order can be arranged and persisted for that preview path.

### Requirement: Manual ordering persistence in SQLite
The app SHALL save and restore manual folder/file order using SQLite.

#### Scenario: Restore saved order
- **WHEN** a user returns to a path previously ordered in manual mode
- **THEN** saved folder/file order is restored from SQLite even after app restart.

### Requirement: List and gallery file views
The app SHALL provide both list and gallery rendering for file previews.

#### Scenario: Switch file view mode
- **WHEN** the user toggles view mode
- **THEN** files for the selected folder are shown in the chosen layout without losing selection context.

### Requirement: PDF dual-panel viewer with scroll sync
The app SHALL display PDF thumbnails in a left sidebar and a large preview in a right pane, with scroll position kept in sync between the two panels.

#### Scenario: Open PDF viewer
- **WHEN** the user opens PDF extraction for a file
- **THEN** a near-fullscreen overlay (inset 24px) appears with a 220px thumbnail sidebar on the left and a large preview pane on the right.

#### Scenario: Scroll sync between panels
- **WHEN** the user scrolls the right preview pane
- **THEN** the left thumbnail sidebar scrolls to keep the corresponding thumbnail visible.

#### Scenario: Ordered page selection with badges
- **WHEN** the user clicks page thumbnails to select them
- **THEN** each selected thumbnail shows a click-order badge, slides 8px to the right, and the selection order determines output page order.

#### Scenario: Lazy thumbnail loading
- **WHEN** thumbnails enter the viewport
- **THEN** they are rendered on demand using IntersectionObserver to avoid upfront cost for large PDFs.

### Requirement: PDF page extraction to single output file
The app SHALL let users select pages from one source PDF and export them into one new PDF.

#### Scenario: Extract selected pages
- **WHEN** the user opens PDF extraction, selects pages, and confirms
- **THEN** the app writes one output PDF containing only selected pages in ascending order.

### Requirement: Destructive PDF page extraction
The app SHALL support extracting selected pages from a PDF while removing those pages from the original file.

#### Scenario: Destructive extract — partial selection
- **WHEN** the user selects a subset of pages and confirms destructive extraction
- **THEN** the app writes a new PDF with the selected pages and atomically rewrites the original PDF with those pages removed (tmp write → bak rename → final rename).

#### Scenario: Destructive extract — all pages selected
- **WHEN** the user selects all pages and confirms
- **THEN** the app falls back to non-destructive extraction and leaves the original file unchanged.

### Requirement: PDF page merge from multiple source files
The app SHALL let users merge selected pages from multiple source PDFs into one output PDF.

#### Scenario: Merge pages from multiple PDFs
- **WHEN** the user selects pages across multiple source PDFs and confirms merge
- **THEN** the app writes one output PDF containing the selected pages from all sources combined in selection order.

### Requirement: Direct file byte reads for PDF loading
The app SHALL read PDF file bytes directly through Tauri IPC rather than relying on the asset protocol.

#### Scenario: Load PDF bytes via IPC
- **WHEN** the PDF viewer needs to display a file
- **THEN** the app invokes `read_file_bytes` over Tauri IPC and passes the result to the PDF renderer, bypassing the `convertFileSrc` asset protocol.

### Requirement: Light theme only for MVP
The app SHALL ship with light theme only.

#### Scenario: No dark mode option
- **WHEN** the user uses the MVP UI
- **THEN** only light theme styling is presented and no theme toggle is shown.

### Requirement: Hidden files/folders remain visible with distinction
The app SHALL show hidden entries while visually distinguishing them with lower opacity.

#### Scenario: Render hidden entries
- **WHEN** hidden files or folders are included in listing results
- **THEN** they appear in the list/gallery with translucent styling instead of being filtered out.

### Requirement: Bookmark pin bar for quick folder access
The app SHALL allow pinning folders and show them in a top bookmark bar.

#### Scenario: Pin and open bookmark
- **WHEN** a user pins a folder
- **THEN** it appears in the bookmark bar and clicking it navigates to that folder path.

### Requirement: File-system operations with shortcuts
The app SHALL support core explorer operations (copy, cut, paste, move, delete, rename) with keyboard shortcuts.

#### Scenario: Copy/Cut/Paste operations
- **WHEN** a user selects an entry and uses `Ctrl/Cmd+C`, `Ctrl/Cmd+X`, `Ctrl/Cmd+V`
- **THEN** the app copies/moves entries to the active preview path.

#### Scenario: Delete operation
- **WHEN** a user presses `Delete` on a selected entry
- **THEN** the app removes that entry from disk after confirmation.

#### Scenario: Rename with F2
- **WHEN** a user selects an entry and presses `F2`
- **THEN** the app renames the entry and refreshes the listing.

#### Scenario: Drag and drop move/copy
- **WHEN** a user drags entries to folders/drives or drops external files onto the explorer
- **THEN** the app performs move/copy into the target path.

#### Scenario: Create new folder
- **WHEN** a user invokes new-folder action (button or `Ctrl/Cmd+Shift+N`)
- **THEN** the app creates the folder under active preview path and refreshes the listing.

### Requirement: System-open for local files including PDF
The app SHALL open selected files with the OS default handler.

#### Scenario: Open PDF file from listing
- **WHEN** the user activates a PDF file in the right pane
- **THEN** the file opens with the system default PDF viewer.

### Requirement: Desktop shortcut created on install
The installer SHALL create a desktop shortcut for the application using COM-based shell link creation.

#### Scenario: Shortcut created after install
- **WHEN** the installer completes successfully
- **THEN** a shortcut to the application executable appears on the Windows desktop.

#### Scenario: Install succeeds even if shortcut fails
- **WHEN** COM-based shortcut creation fails for any reason
- **THEN** the installer still completes successfully and the application is usable without the shortcut.
