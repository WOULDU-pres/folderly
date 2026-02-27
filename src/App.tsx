import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type RefObject } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { startDrag as startNativeDrag } from '@crabnebula/tauri-plugin-drag'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  AlertCircle,
  ArrowUp,
  BookmarkPlus,
  CheckCircle2,
  Copy,
  ChevronRight,
  Info,
  File,
  FileText,
  Folder,
  FolderPlus,
  Grid2x2,
  GripVertical,
  FolderDown,
  HardDrive,
  List,
  Menu,
  Monitor,
  Pencil,
  RefreshCcw,
  Scissors,
  Trash2,
  Undo2,
  ClipboardPaste,
  X,
} from 'lucide-react'

import { PdfViewer } from './components/PdfViewer'
import { PdfMergeModal } from './components/PdfMergeModal'
import { FileNameModal } from './components/FileNameModal'
import { SearchBar } from './components/SearchBar'
import { ContextMenu, type ContextMenuItem } from './components/ContextMenu'
import { BookmarkItem, DriveItem, FileItem, FolderItem, OrderMode, SortMode } from './types'
import { mergeManualOrder, sortFiles, sortFolders } from './utils/folderOrder'
import { extLabel, formatBytes, formatDate } from './utils/format'
import { encodeFileSrcUrl, getFileDirectory, withPreservedExtension } from './utils/path'
import { resolvePasteTarget } from './utils/pasteTarget'
import { useExplorerStore, type ClipboardState, type ExplorerEntry, type UndoEntry } from './store/useExplorerStore'

const BOOKMARK_STORAGE_KEY = 'explorer.bookmarks.v1'
const ENTRY_DRAG_MIME = 'application/x-windows-explorer-paths'
const FOLDER_PAGE_SIZE = 300
const ENTRY_PAGE_SIZE = 300
const SHARED_CLIPBOARD_EVENT = 'app://shared-clipboard-updated'
const SHARED_CLIPBOARD_LOCAL_KEY = 'explorer.sharedClipboard.v1'
const NATIVE_DRAG_PREVIEW_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8DwHwAFAAH/tkY6rQAAAABJRU5ErkJggg=='
const DROP_EVENT_DEDUPE_WINDOW_MS = 300
type SortField = 'name' | 'modifiedAt' | 'size'
type SortDirection = 'asc' | 'desc'
const SOURCE_FOLDER_BADGE_COLORS = ['#2563eb', '#16a34a', '#ca8a04', '#db2777', '#7c3aed', '#0891b2', '#f97316', '#0d9488', '#0284c7', '#6366f1']
type PathOperationMode = 'copy' | 'move'
type NativeDragContext = {
  paths: string[]
  mode: PathOperationMode
}

type SourceFolderHint = {
  id: string
  path: string
  normalizedPath: string
  label: string
  color: string
}

function resolveSortField(mode: SortMode): SortField {
  if (mode === 'name' || mode === 'nameDesc') return 'name'
  if (mode === 'modifiedAt' || mode === 'modifiedAtAsc') return 'modifiedAt'
  return 'size'
}

function resolveSortDirection(mode: SortMode): SortDirection {
  if (mode === 'name') return 'asc'
  if (mode === 'nameDesc') return 'desc'
  if (mode === 'modifiedAtAsc') return 'asc'
  return 'desc'
}

function toSortMode(field: SortField, direction: SortDirection): SortMode {
  if (field === 'name') return direction === 'asc' ? 'name' : 'nameDesc'
  if (field === 'modifiedAt') return direction === 'asc' ? 'modifiedAtAsc' : 'modifiedAt'
  return 'size'
}

function isTauriDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

function areSamePathSet(leftPaths: string[], rightPaths: string[]): boolean {
  if (leftPaths.length !== rightPaths.length) return false
  const left = new Set(leftPaths)
  for (const path of rightPaths) {
    if (!left.has(path)) {
      return false
    }
  }
  return true
}

function resolveDropPathFromWindowPosition(position: { x: number; y: number }): string | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  const scale = window.devicePixelRatio || 1
  const logicalX = position.x / scale
  const logicalY = position.y / scale
  const target = document.elementFromPoint(logicalX, logicalY)
  if (!target) return null
  const dropElement = target.closest<HTMLElement>('[data-drop-path]')
  const value = dropElement?.dataset.dropPath?.trim()
  return value || null
}

type SortableFolderRowProps = {
  folder: FolderItem
  selected: boolean
  manualMode: boolean
  sortable: boolean
  depth: number
  onClick: (folder: FolderItem, modifiers: SidebarSelectModifiers) => void
  onDoubleClick: (folder: FolderItem) => void
  onDropEntries: (paths: string[], destinationPath: string, copyMode: boolean) => void
}

function writeDragPayload(event: ReactDragEvent, paths: string[]) {
  const normalizedPaths = normalizeDragPaths(paths)
  const payload = JSON.stringify(normalizedPaths)
  const plainPayload = normalizedPaths.join('\n')

  event.dataTransfer.setData(ENTRY_DRAG_MIME, payload)
  event.dataTransfer.setData('text/plain', plainPayload)
  event.dataTransfer.setData('text/uri-list', normalizedPaths.map(toFileUriPath).join('\n'))
  event.dataTransfer.effectAllowed = 'copyMove'
}

function normalizeDragPaths(paths: string[]): string[] {
  const deduped = new Set<string>()
  for (const value of paths) {
    const trimmed = value.trim()
    if (!trimmed) continue
    deduped.add(trimmed)
  }
  return Array.from(deduped)
}

function decodeFileUriPath(value: string): string {
  if (!value.toLowerCase().startsWith('file://')) {
    return value
  }

  try {
    const uri = new URL(value)
    const decodedPath = decodeURIComponent(uri.pathname)
    const normalizedLeadingSlash = decodedPath.replace(/^\/([A-Za-z]:[\\/])/, '$1')
    return normalizedLeadingSlash.replace(/\//g, '\\')
  } catch {
    return value
  }
}

function toFileUriPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`
  }

  return `file:///${encodeURI(normalized.replace(/^\/+/, ''))}`
}

function extractDroppedFilePaths(event: ReactDragEvent): string[] {
  if (!event.dataTransfer.files || event.dataTransfer.files.length === 0) return []

  const paths: string[] = []
  for (let index = 0; index < event.dataTransfer.files.length; index += 1) {
    const entry = event.dataTransfer.files[index] as File & { path?: string }
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (path) {
      paths.push(path)
    }
  }

  return normalizeDragPaths(paths)
}

function parseDragPayload(payload: string): string[] {
  const trimmedPayload = payload.trim()
  if (!trimmedPayload) return []

  try {
    const parsed = JSON.parse(trimmedPayload)
    if (Array.isArray(parsed)) {
      return normalizeDragPaths(parsed.filter((value): value is string => typeof value === 'string'))
    }
    if (typeof parsed === 'string') {
      return normalizeDragPaths([parsed])
    }
  } catch {
    // fallback below
  }

  const lines = trimmedPayload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map(decodeFileUriPath)

  return normalizeDragPaths(lines)
}

function readDragPayload(event: ReactDragEvent): string[] {
  const mimePayload = event.dataTransfer.getData(ENTRY_DRAG_MIME)
  if (mimePayload) {
    const parsed = parseDragPayload(mimePayload)
    if (parsed.length > 0) {
      return parsed
    }
  }

  const uriListPayload = event.dataTransfer.getData('text/uri-list')
  if (uriListPayload) {
    const parsed = parseDragPayload(uriListPayload)
    if (parsed.length > 0) {
      return parsed
    }
  }

  const plainTextPayload = event.dataTransfer.getData('text/plain')
  if (plainTextPayload) {
    const parsed = parseDragPayload(plainTextPayload)
    if (parsed.length > 0) {
      return parsed
    }
  }

  const fileListPaths = extractDroppedFilePaths(event)
  if (fileListPaths.length > 0) {
    return fileListPaths
  }

  return []
}

function hasExplorerDragPayload(event: ReactDragEvent): boolean {
  const types = Array.from(event.dataTransfer.types)
  if (
    types.includes(ENTRY_DRAG_MIME) ||
    types.includes('text/plain') ||
    types.includes('text/uri-list') ||
    types.includes('Files')
  ) {
    return true
  }

  return extractDroppedFilePaths(event).length > 0
}

function readLocalClipboardState(): ClipboardState {
  try {
    const raw = window.localStorage.getItem(SHARED_CLIPBOARD_LOCAL_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null

    const maybe = parsed as { mode?: unknown; paths?: unknown }
    const mode = maybe.mode === 'copy' || maybe.mode === 'cut' ? maybe.mode : null
    if (!mode || !Array.isArray(maybe.paths)) return null

    const paths = maybe.paths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    if (!paths.length) return null

    return { mode, paths }
  } catch {
    return null
  }
}

function writeLocalClipboardState(nextClipboard: ClipboardState): void {
  try {
    if (!nextClipboard) {
      window.localStorage.removeItem(SHARED_CLIPBOARD_LOCAL_KEY)
      return
    }
    window.localStorage.setItem(SHARED_CLIPBOARD_LOCAL_KEY, JSON.stringify(nextClipboard))
  } catch {
    // localStorage may be unavailable in constrained environments
  }
}

function updateDropEffect(event: ReactDragEvent) {
  event.dataTransfer.dropEffect = event.ctrlKey || event.metaKey ? 'copy' : 'move'
}

function resolveDropCopyMode(event: ReactDragEvent): boolean {
  const dropEffect = event.dataTransfer.dropEffect
  if (dropEffect === 'copy') {
    return true
  }
  if (dropEffect === 'move') {
    return false
  }

  if (extractDroppedFilePaths(event).length > 0) {
    return true
  }

  return event.ctrlKey || event.metaKey
}

function SortableFolderRow({
  folder,
  selected,
  manualMode,
  sortable,
  depth,
  onClick,
  onDoubleClick,
  onDropEntries,
}: SortableFolderRowProps) {
  const dragState = useSortable({
    id: folder.id,
    disabled: !manualMode || !sortable,
  })
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = dragState
  const [dropTargetActive, setDropTargetActive] = useState(false)
  const indent = Math.max(0, depth) * 16

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    paddingLeft: `${8 + indent}px`,
  }
  return (
    <li
      ref={setNodeRef}
      style={style}
      data-drop-path={folder.path}
      className={`sidebar-row ${selected ? 'selected' : ''} ${folder.isHidden ? 'hidden-entry' : ''} ${dropTargetActive ? 'drop-target' : ''}`}
      role="option"
      aria-selected={selected}
      aria-label={folder.name}
      tabIndex={0}
      onClick={(event) => onClick(folder, { ctrl: event.ctrlKey || event.metaKey })}
      onDoubleClick={() => onDoubleClick(folder)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (e.key === 'Enter') onDoubleClick(folder)
          else onClick(folder, { ctrl: e.ctrlKey || e.metaKey })
        }
      }}
      onDragEnter={(event) => {
        if (!hasExplorerDragPayload(event)) return
        event.preventDefault()
        setDropTargetActive(true)
      }}
      onDragLeave={() => setDropTargetActive(false)}
      onDragOver={(event) => {
        if (!hasExplorerDragPayload(event)) return
        event.preventDefault()
        updateDropEffect(event)
        setDropTargetActive(true)
      }}
      onDrop={(event) => {
        setDropTargetActive(false)
        if (!hasExplorerDragPayload(event)) return
        event.preventDefault()
        event.stopPropagation()
        const paths = readDragPayload(event)
        if (!paths.length) return
        onDropEntries(paths, folder.path, resolveDropCopyMode(event))
      }}
    >
      <button
        ref={setActivatorNodeRef}
        className={`drag-handle ${manualMode && sortable ? '' : 'hidden'}`}
        disabled={!manualMode || !sortable}
        aria-label={`Drag to reorder ${folder.name}`}
        {...(manualMode && sortable ? listeners : {})}
        {...(manualMode && sortable ? attributes : {})}
        onClick={(event) => {
          event.stopPropagation()
        }}
        onDoubleClick={(event) => {
          event.stopPropagation()
        }}
        onMouseDown={(event) => {
          event.stopPropagation()
        }}
      >
        <GripVertical size={16} />
      </button>
      <Folder size={16} className="entry-kind-icon entry-icon-folder" />
      <span>{folder.name}</span>
    </li>
  )
}

type SelectModifiers = { ctrl: boolean; shift: boolean }
type SidebarSelectModifiers = Pick<SelectModifiers, 'ctrl'>

type SortableEntryRowProps = {
  entry: ExplorerEntry
  selected: boolean
  manualMode: boolean
  sortable: boolean
  depth: number
  dragPaths: string[]
  sourceFolderHint?: SourceFolderHint | null
  isCut: boolean
  isInlineRenaming: boolean
  inlineRenameValue: string
  inlineRenameInputRef: RefObject<HTMLInputElement | null>
  onSelect: (entry: ExplorerEntry, modifiers: SelectModifiers) => void
  onOpen: (entry: ExplorerEntry) => void
  onDropEntries: (paths: string[], destinationPath: string, copyMode: boolean) => void
  onStartNativeDrag?: (paths: string[], copyMode: boolean) => boolean
  onInlineRenameChange: (value: string) => void
  onInlineRenameCommit: () => void
  onInlineRenameCancel: () => void
  onContextMenu?: (e: React.MouseEvent, entry: ExplorerEntry) => void
  showSourceColumn: boolean
  canExpand: boolean
  isExpanded: boolean
  isLoadingChildren: boolean
  onToggleExpand?: (folder: FolderItem) => void
}

function SortableEntryRow({
  entry,
  selected,
  manualMode,
  sortable,
  depth,
  dragPaths,
  sourceFolderHint,
  isCut,
  isInlineRenaming,
  inlineRenameValue,
  inlineRenameInputRef,
  onSelect,
  onOpen,
  onDropEntries,
  onStartNativeDrag,
  onInlineRenameChange,
  onInlineRenameCommit,
  onInlineRenameCancel,
  onContextMenu,
  showSourceColumn,
  canExpand,
  isExpanded,
  isLoadingChildren,
  onToggleExpand,
}: SortableEntryRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({
    id: entry.id,
    disabled: !manualMode || !sortable,
  })
  const [dropTargetActive, setDropTargetActive] = useState(false)

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  const sourceLocationLabel = showSourceColumn ? getPathParentFolderLabel(entry.path) : ''
  const locationLabel = sourceFolderHint?.label || getPathParentFolderName(entry.path) || sourceLocationLabel
  const locationTooltip = sourceFolderHint?.path || sourceLocationLabel || locationLabel
  const locationDotColor = sourceFolderHint?.color || 'var(--text-table-head)'
  const entryIconTone = entry.kind === 'folder' ? 'entry-icon-folder' : resolveFileIconTone(entry.ext)
  const normalizedCanExpand = entry.kind === 'folder' && canExpand
  const isExpandedRow = entry.kind === 'folder' && isExpanded
  const isLoadingRowChildren = entry.kind === 'folder' && isLoadingChildren
  const handleToggleClick = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (entry.kind !== 'folder' || !onToggleExpand || !normalizedCanExpand) return
    onToggleExpand(entry)
  }

  const folderToggleLabel = isLoadingRowChildren
    ? '하위 폴더 불러오는 중'
    : !normalizedCanExpand
      ? '하위 폴더 없음'
      : isExpandedRow
      ? '하위 폴더 접기'
      : '하위 폴더 펼치기'

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`table-row ${selected ? 'selected' : ''} ${entry.isHidden ? 'hidden-entry' : ''} ${isCut ? 'cut-entry' : ''} ${dropTargetActive ? 'drop-target' : ''} ${showSourceColumn ? 'with-location' : ''}`}
      role="row"
      aria-selected={selected}
      tabIndex={0}
      draggable
      onDragStart={(event) => {
        const target = event.target as HTMLElement | null
        if (manualMode && sortable && target?.closest('.file-drag-handle')) {
          event.preventDefault()
          return
        }
        const payloadPaths = selected && dragPaths.length > 0 ? dragPaths : [entry.path]
        const copyMode = event.ctrlKey || event.metaKey
        writeDragPayload(event, payloadPaths)
        onStartNativeDrag?.(payloadPaths, copyMode)
      }}
      data-drop-path={entry.kind === 'folder' ? entry.path : undefined}
      onDragOver={(event) => {
        if (entry.kind === 'folder') {
          event.preventDefault()
          updateDropEffect(event)
          setDropTargetActive(true)
        }
      }}
      onDragEnter={(event) => {
        if (entry.kind !== 'folder' || !hasExplorerDragPayload(event)) return
        event.preventDefault()
        setDropTargetActive(true)
      }}
      onDragLeave={() => setDropTargetActive(false)}
      onDrop={(event) => {
        setDropTargetActive(false)
        if (entry.kind !== 'folder') return
        if (!hasExplorerDragPayload(event)) return
        event.preventDefault()
        event.stopPropagation()
        const paths = readDragPayload(event)
        if (!paths.length) return
        onDropEntries(paths, entry.path, resolveDropCopyMode(event))
      }}
      onClick={(e) => onSelect(entry, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
      onDoubleClick={() => {
        if (!isInlineRenaming) {
          onOpen(entry)
        }
      }}
      onContextMenu={(e) => onContextMenu?.(e, entry)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onOpen(entry)
        } else if (e.key === ' ') {
          e.preventDefault()
          onSelect(entry, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
        }
      }}
    >
      <span role="gridcell">
        <button
          ref={setActivatorNodeRef}
          className={`file-drag-handle ${manualMode && sortable ? '' : 'hidden'}`}
          disabled={!manualMode || !sortable}
          aria-label={`Drag to reorder ${entry.name}`}
          {...(manualMode && sortable ? listeners : {})}
          {...(manualMode && sortable ? attributes : {})}
        >
          <GripVertical size={14} />
        </button>
      </span>
      <span
        role="gridcell"
        className="name-cell"
        style={{ paddingLeft: `${Math.max(0, depth) * 16}px` }}
      >
        {entry.kind === 'folder' && onToggleExpand ? (
          <button
            type="button"
            className={`folder-toggle ${isExpandedRow ? 'expanded' : normalizedCanExpand ? 'collapsed' : 'leaf'}`}
            aria-disabled={!normalizedCanExpand}
            disabled={!normalizedCanExpand}
            aria-label={folderToggleLabel}
            aria-expanded={isExpandedRow}
            onClick={handleToggleClick}
            onDoubleClick={(event) => {
              event.stopPropagation()
            }}
          >
            {isLoadingRowChildren ? (
              <RefreshCcw size={13} className="folder-toggle-icon folder-toggle-spin" />
            ) : (
              <ChevronRight size={13} className={`folder-toggle-icon ${normalizedCanExpand ? (isExpandedRow ? 'expanded' : 'collapsed') : 'leaf'}`} />
            )}
          </button>
        ) : (
          <span className="folder-toggle-space" aria-hidden="true" />
        )}
        {entry.kind === 'folder' ? (
          <Folder size={17} className={`entry-kind-icon ${entryIconTone}`} />
        ) : entry.ext === 'pdf' ? (
          <FileText size={17} className={`entry-kind-icon ${entryIconTone}`} />
        ) : (
          <File size={17} className={`entry-kind-icon ${entryIconTone}`} />
        )}
        {isInlineRenaming ? (
          <input
            ref={inlineRenameInputRef}
            className="inline-rename-input"
            value={inlineRenameValue}
            onChange={(event) => onInlineRenameChange(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onBlur={() => void onInlineRenameCommit()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                void onInlineRenameCommit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onInlineRenameCancel()
              } else {
                event.stopPropagation()
              }
            }}
            aria-label={`${entry.name} 이름 편집`}
          />
        ) : (
          <span className="entry-name-label" title={entry.name}>
            {entry.name}
          </span>
        )}
      </span>
      <span role="gridcell">{entry.kind === 'folder' ? '폴더' : extLabel(entry.ext)}</span>
      <span role="gridcell">{entry.kind === 'folder' ? '-' : formatBytes(entry.size)}</span>
      <span role="gridcell">{formatDate(entry.modifiedAt)}</span>
      {showSourceColumn && (
        <span
          role="gridcell"
          className="entry-location"
          title={locationTooltip}
          aria-label={`${entry.name} 출처: ${locationLabel}`}
        >
          <span className="entry-location-dot" style={{ background: locationDotColor }} />
          <span className="entry-location-label">{locationLabel}</span>
        </span>
      )}
    </li>
  )
}

type SortableGalleryCardProps = {
  entry: ExplorerEntry
  selected: boolean
  manualMode: boolean
  dragPaths: string[]
  sourceFolderHint?: SourceFolderHint | null
  isCut: boolean
  isInlineRenaming: boolean
  inlineRenameValue: string
  inlineRenameInputRef: RefObject<HTMLInputElement | null>
  onSelect: (entry: ExplorerEntry, modifiers: SelectModifiers) => void
  onOpen: (entry: ExplorerEntry) => void
  onDropEntries: (paths: string[], destinationPath: string, copyMode: boolean) => void
  onStartNativeDrag?: (paths: string[], copyMode: boolean) => boolean
  onStartInlineRename: (entry: ExplorerEntry) => void
  onInlineRenameChange: (value: string) => void
  onInlineRenameCommit: () => void
  onInlineRenameCancel: () => void
  onContextMenu?: (e: React.MouseEvent, entry: ExplorerEntry) => void
  showSourceColumn: boolean
}

function SortableGalleryCard({
  entry,
  selected,
  manualMode,
  dragPaths,
  sourceFolderHint,
  isCut,
  isInlineRenaming,
  inlineRenameValue,
  inlineRenameInputRef,
  onSelect,
  onOpen,
  onDropEntries,
  onStartNativeDrag,
  onStartInlineRename,
  onInlineRenameChange,
  onInlineRenameCommit,
  onInlineRenameCancel,
  onContextMenu,
  showSourceColumn,
}: SortableGalleryCardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({
    id: entry.id,
    disabled: !manualMode,
  })
  const [dropTargetActive, setDropTargetActive] = useState(false)

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  const sourceLocationLabel = showSourceColumn ? getPathParentFolderLabel(entry.path) : ''
  const locationLabel = sourceFolderHint?.label || getPathParentFolderName(entry.path) || sourceLocationLabel
  const locationTooltip = sourceFolderHint?.path || sourceLocationLabel || locationLabel
  const locationDotColor = sourceFolderHint?.color || 'var(--text-table-head)'
  const entryIconTone = entry.kind === 'folder' ? 'entry-icon-folder' : resolveFileIconTone(entry.ext)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`gallery-card ${selected ? 'selected' : ''} ${entry.isHidden ? 'hidden-entry' : ''} ${isCut ? 'cut-entry' : ''} ${dropTargetActive ? 'drop-target' : ''}`}
      role="button"
      aria-selected={selected}
      tabIndex={0}
      draggable
      onDragStart={(event) => {
        const target = event.target as HTMLElement | null
        if (manualMode && target?.closest('.gallery-drag-handle')) {
          event.preventDefault()
          return
        }
        const payloadPaths = selected && dragPaths.length > 0 ? dragPaths : [entry.path]
        const copyMode = event.ctrlKey || event.metaKey
        writeDragPayload(event, payloadPaths)
        onStartNativeDrag?.(payloadPaths, copyMode)
      }}
      data-drop-path={entry.kind === 'folder' ? entry.path : undefined}
      onDragOver={(event) => {
        if (entry.kind === 'folder') {
          event.preventDefault()
          updateDropEffect(event)
          setDropTargetActive(true)
        }
      }}
      onDragEnter={(event) => {
        if (entry.kind !== 'folder' || !hasExplorerDragPayload(event)) return
        event.preventDefault()
        setDropTargetActive(true)
      }}
      onDragLeave={() => setDropTargetActive(false)}
      onDrop={(event) => {
        setDropTargetActive(false)
        if (entry.kind !== 'folder') return
        if (!hasExplorerDragPayload(event)) return
        event.preventDefault()
        event.stopPropagation()
        const paths = readDragPayload(event)
        if (!paths.length) return
        onDropEntries(paths, entry.path, resolveDropCopyMode(event))
      }}
      onClick={(e) => onSelect(entry, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
      onDoubleClick={() => {
        if (!isInlineRenaming) {
          onOpen(entry)
        }
      }}
      onContextMenu={(e) => onContextMenu?.(e, entry)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (!isInlineRenaming) {
            onOpen(entry)
          }
        } else if (e.key === ' ') {
          e.preventDefault()
          onSelect(entry, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
        } else if (e.key === 'F2') {
          e.preventDefault()
          onStartInlineRename(entry)
        }
      }}
    >
      {manualMode && (
        <button
          ref={setActivatorNodeRef}
          className="gallery-drag-handle"
          aria-label={`${entry.name} 순서 조정`}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          {...listeners}
          {...attributes}
        >
          <GripVertical size={14} />
        </button>
      )}
      <div className="gallery-thumb">
        {entry.kind === 'folder' ? (
          <Folder size={32} className={`entry-kind-icon ${entryIconTone}`} />
        ) : isImage(entry.ext) ? (
          <img src={toEncodedFileSrc(entry.path)} alt={entry.name} loading="lazy" />
        ) : entry.ext === 'pdf' ? (
          <FileText size={32} className={`entry-kind-icon ${entryIconTone}`} />
        ) : (
          <File size={32} className={`entry-kind-icon ${entryIconTone}`} />
        )}
      </div>
      {isInlineRenaming ? (
        <input
          ref={inlineRenameInputRef}
          className="inline-rename-input"
          value={inlineRenameValue}
          onChange={(event) => onInlineRenameChange(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onBlur={() => void onInlineRenameCommit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              void onInlineRenameCommit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onInlineRenameCancel()
            } else {
              event.stopPropagation()
            }
          }}
          aria-label={`${entry.name} 이름 편집`}
        />
      ) : (
        <strong className="gallery-name" title={entry.name}>
          {entry.name}
        </strong>
      )}
      <div className="gallery-meta">
        <span className="gallery-type">{entry.kind === 'folder' ? '폴더' : extLabel(entry.ext)}</span>
        {showSourceColumn && (
          <div className="gallery-location" title={locationTooltip}>
            <span className="entry-location-dot" style={{ background: locationDotColor }} />
            <span className="gallery-location-label">{locationLabel}</span>
          </div>
        )}
      </div>
    </div>
  )
}

void SortableGalleryCard

function toWindowsStylePath(path: string): string {
  if (!path.startsWith('/mnt/')) {
    return path
  }

  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2 || parts[0] !== 'mnt') {
    return path
  }

  const drive = `${parts[1].toUpperCase()}:`
  const rest = parts.slice(2).join('\\')
  return rest ? `${drive}\\${rest}` : `${drive}\\`
}

type BreadcrumbSegment = { label: string; path: string }

function buildBreadcrumbs(internalPath: string): BreadcrumbSegment[] {
  if (!internalPath) return []

  if (internalPath.startsWith('/mnt/')) {
    const parts = internalPath.split('/').filter(Boolean)
    if (parts.length < 2 || parts[0] !== 'mnt') return [{ label: internalPath, path: internalPath }]

    const drive = `${parts[1].toUpperCase()}:`
    const segments: BreadcrumbSegment[] = [{ label: `${drive}\\`, path: `/mnt/${parts[1]}` }]

    for (let i = 2; i < parts.length; i++) {
      const partialPath = '/' + parts.slice(0, i + 1).join('/')
      segments.push({ label: parts[i], path: partialPath })
    }
    return segments
  }

  // Windows native path (C:\foo\bar) or Unix path
  const sep = internalPath.includes('\\') ? '\\' : '/'
  const parts = internalPath.split(sep).filter(Boolean)
  if (parts.length === 0) return [{ label: internalPath, path: internalPath }]

  const segments: BreadcrumbSegment[] = []
  for (let i = 0; i < parts.length; i++) {
    const partialPath = parts.slice(0, i + 1).join(sep) + (i === 0 && sep === '\\' ? '\\' : '')
    const label = i === 0 && sep === '\\' ? `${parts[0]}\\` : parts[i]
    segments.push({ label, path: partialPath })
  }
  return segments
}

function isImage(ext: string) {
  return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext.toLowerCase())
}

function resolveFileIconTone(ext: string): string {
  const normalizedExt = ext.toLowerCase()
  if (normalizedExt === 'pdf') return 'entry-icon-pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(normalizedExt)) return 'entry-icon-image'
  if (['doc', 'docx', 'hwp', 'txt', 'rtf', 'md'].includes(normalizedExt)) return 'entry-icon-doc'
  if (['xls', 'xlsx', 'csv'].includes(normalizedExt)) return 'entry-icon-sheet'
  if (['ppt', 'pptx'].includes(normalizedExt)) return 'entry-icon-slide'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(normalizedExt)) return 'entry-icon-archive'
  return 'entry-icon-file'
}

function toEncodedFileSrc(path: string): string {
  return encodeFileSrcUrl(convertFileSrc(path))
}

function deriveBookmarkName(path: string) {
  const winPath = toWindowsStylePath(path)
  const normalized = winPath.endsWith('\\') ? winPath.slice(0, -1) : winPath
  const index = normalized.lastIndexOf('\\')
  if (index < 0) {
    return normalized
  }
  const name = normalized.slice(index + 1)
  return name || normalized
}

function getPathParentFolderLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const lastSep = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSep < 0) return ''

  const parentPath = normalized.slice(0, lastSep)
  if (!parentPath) return ''
  if (/^[A-Za-z]:$/.test(parentPath)) {
    return `${parentPath}\\`
  }

  return toWindowsStylePath(parentPath)
}

function getPathParentFolderName(path: string): string {
  const sourcePath = getPathParentFolderLabel(path)
  if (!sourcePath) return ''
  const normalized = sourcePath.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : sourcePath
}

function normalizePathForSourceMatch(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/\/+$/g, '').replace(/\/\/+/g, '/')
}

function getSourceFolderLabelForDisplay(path: string, showDisambiguated: boolean): string {
  const normalized = normalizePathForSourceMatch(toWindowsStylePath(path))
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 1) {
    return parts[parts.length - 1] ?? normalized
  }
  if (!showDisambiguated) {
    return parts[parts.length - 1]
  }
  return parts.slice(-2).join('\\')
}

function resolveSourceFolderHint(path: string, sourceFolderHints: SourceFolderHint[]): SourceFolderHint | null {
  if (!sourceFolderHints.length) return null
  const normalized = normalizePathForSourceMatch(path)

  let bestMatch: SourceFolderHint | null = null
  for (const hint of sourceFolderHints) {
    const prefix = hint.normalizedPath
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      if (!bestMatch || prefix.length > bestMatch.normalizedPath.length) {
        bestMatch = hint
      }
    }
  }

  return bestMatch
}

function buildSourceFolderHints(folders: FolderItem[], selectedSidebarFolderIds: string[]): SourceFolderHint[] {
  if (selectedSidebarFolderIds.length < 2) return []

  const folderById = new Map(folders.map((folder) => [folder.id, folder]))
  const selectedFolders = selectedSidebarFolderIds
    .map((id) => folderById.get(id))
    .filter((folder): folder is FolderItem => Boolean(folder))

  if (selectedFolders.length < 2) return []

  const nameCount = new Map<string, number>()
  for (const folder of selectedFolders) {
    const baseName = getPathName(folder.path)
    nameCount.set(baseName, (nameCount.get(baseName) ?? 0) + 1)
  }

  return selectedFolders.map((folder, index) => {
    const baseName = getPathName(folder.path)
    const disambiguate = (nameCount.get(baseName) ?? 0) > 1
    return {
      id: folder.id,
      path: folder.path,
      normalizedPath: normalizePathForSourceMatch(folder.path),
      label: getSourceFolderLabelForDisplay(folder.path, disambiguate),
      color: SOURCE_FOLDER_BADGE_COLORS[index % SOURCE_FOLDER_BADGE_COLORS.length],
    }
  })
}

function getPathName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const slashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values())
}

type EntryTreeRow = {
  key: string
  entry?: ExplorerEntry
  depth: number
  parentFolderId?: string
  placeholder?: 'loading' | 'empty'
}

function sortExplorerEntries(entries: ExplorerEntry[], mode: SortMode): ExplorerEntry[] {
  const folders = entries
    .filter((entry): entry is Extract<ExplorerEntry, { kind: 'folder' }> => entry.kind === 'folder')
    .map(({ kind: _kind, ...folder }) => folder)
  const files = entries
    .filter((entry): entry is Extract<ExplorerEntry, { kind: 'file' }> => entry.kind === 'file')
    .map(({ kind: _kind, ...file }) => file)

  return [
    ...sortFolders(folders, mode).map((folder) => ({ ...folder, kind: 'folder' as const })),
    ...sortFiles(files, mode).map((file) => ({ ...file, kind: 'file' as const })),
  ]
}

export default function App() {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const clickTimerRef = useRef<number | null>(null)
  const operationToastTimerRef = useRef<number | null>(null)
  const undoToastTimerRef = useRef<number | null>(null)
  const nativeDragContextRef = useRef<NativeDragContext | null>(null)
  const operationInProgressRef = useRef(false)
  const lastDropSignatureRef = useRef<{ signature: string; timestamp: number } | null>(null)

  const {
    currentPath, setCurrentPath,
    previewPath, setPreviewPath,
    drives, setDrives,
    quickAccess, setQuickAccess,
    bookmarks, setBookmarks,
    folders, setFolders,
    previewFolders, setPreviewFolders,
    previewFiles, setPreviewFiles,
    setSelectedFolderId,
    selectedEntryIds, setSelectedEntryIds,
    clipboard, setClipboard,
    sortMode, setSortMode,
    viewMode, setViewMode,
    orderMode, setOrderMode,
    folderManualOrderIds, setFolderManualOrderIds,
    entryManualOrderIds, setEntryManualOrderIds,
    error, setError,
    operationInProgress, setOperationInProgress,
    operationStatus, setOperationStatus,
    actionInProgress, setActionInProgress,
    pushUndoEntry,
    popUndoEntry,
  } = useExplorerStore()

  const lastClickedIndexRef = useRef<number>(-1)

  const [folderLoading, setFolderLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)

  const [pdfModalOpen, setPdfModalOpen] = useState(false)
  const [mergePdfModalOpen, setMergePdfModalOpen] = useState(false)

  // Phase B1: Rename modal state
  const [renameModalOpen, setRenameModalOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<ExplorerEntry | null>(null)
  const [inlineRenameId, setInlineRenameId] = useState<string | null>(null)
  const [inlineRenameValue, setInlineRenameValue] = useState('')
  const inlineRenameInputRef = useRef<HTMLInputElement | null>(null)
  const inlineRenameSubmittingRef = useRef(false)

  // Phase B1: Create folder modal state
  const [createFolderModalOpen, setCreateFolderModalOpen] = useState(false)

  // Phase F1: Search filter
  const [searchQuery, setSearchQuery] = useState('')
  const [isCompactLayout, setIsCompactLayout] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const compactLayoutRef = useRef<boolean | null>(null)

  // Phase E1: Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [selectedSidebarFolderIds, setSelectedSidebarFolderIds] = useState<string[]>([])
  const [expandedEntryFolderIds, setExpandedEntryFolderIds] = useState<Set<string>>(new Set())
  const expandedEntryFolderIdsRef = useRef<Set<string>>(new Set())
  const [entryChildrenByFolderId, setEntryChildrenByFolderId] = useState<Map<string, ExplorerEntry[]>>(new Map())
  const [entryChildrenLoadingIds, setEntryChildrenLoadingIds] = useState<Set<string>>(new Set())
  const [visibleFolderCount, setVisibleFolderCount] = useState(FOLDER_PAGE_SIZE)
  const [visibleEntryCount, setVisibleEntryCount] = useState(ENTRY_PAGE_SIZE)
  const [undoToastMessage, setUndoToastMessage] = useState<string | null>(null)
  const [isOpeningSecondaryWindow, setIsOpeningSecondaryWindow] = useState(false)

  const sortedFolders = useMemo(() => sortFolders(folders, sortMode), [folders, sortMode])
  const displayFolders = useMemo(
    () => (orderMode === 'manual' ? mergeManualOrder(sortedFolders, folderManualOrderIds) : sortedFolders),
    [sortedFolders, orderMode, folderManualOrderIds],
  )
  const visibleFolders = useMemo(
    () => (orderMode === 'manual' ? displayFolders : displayFolders.slice(0, visibleFolderCount)),
    [displayFolders, orderMode, visibleFolderCount],
  )
  const hasMoreFolders = orderMode !== 'manual' && visibleFolders.length < displayFolders.length
  const selectedSidebarFolderIdSet = useMemo(
    () => new Set(selectedSidebarFolderIds),
    [selectedSidebarFolderIds],
  )
  const allKnownFolderById = useMemo(
    () => new Map(displayFolders.map((folder) => [folder.id, folder] as const)),
    [displayFolders],
  )

  const autoSortedEntries = useMemo<ExplorerEntry[]>(() => {
    const folderEntries = sortFolders(previewFolders, sortMode).map((entry) => ({
      ...entry,
      kind: 'folder' as const,
    }))
    const fileEntries = sortFiles(previewFiles, sortMode).map((entry) => ({
      ...entry,
      kind: 'file' as const,
    }))
    return [...folderEntries, ...fileEntries]
  }, [previewFolders, previewFiles, sortMode])

  const orderedEntries = useMemo(
    () => (orderMode === 'manual' ? mergeManualOrder(autoSortedEntries, entryManualOrderIds) : autoSortedEntries),
    [autoSortedEntries, orderMode, entryManualOrderIds],
  )

  const baseDisplayEntries = useMemo(() => {
    if (!searchQuery.trim()) return orderedEntries
    const q = searchQuery.trim().toLowerCase()
    return orderedEntries.filter((entry) => entry.name.toLowerCase().includes(q))
  }, [orderedEntries, searchQuery])
  const visibleRootEntries = useMemo(
    () => (orderMode === 'manual' ? baseDisplayEntries : baseDisplayEntries.slice(0, visibleEntryCount)),
    [baseDisplayEntries, orderMode, visibleEntryCount],
  )
  const hasMoreEntries = orderMode !== 'manual' && visibleRootEntries.length < baseDisplayEntries.length
  const getSortedEntryChildren = (folderId: string) => {
    const children = entryChildrenByFolderId.get(folderId) ?? []
    return sortExplorerEntries(children, sortMode)
  }
  const visibleEntryRows = useMemo<EntryTreeRow[]>(() => {
    const buildRows = (entries: ExplorerEntry[], depth: number, parentFolderId?: string): EntryTreeRow[] => {
      return entries.flatMap((entry) => {
        const row: EntryTreeRow = {
          key: entry.id,
          entry,
          depth,
          parentFolderId,
        }

        if (entry.kind !== 'folder') {
          return [row]
        }

        const isExpanded = expandedEntryFolderIds.has(entry.id)
        if (!isExpanded) {
          return [row]
        }

        const isLoadingChildren = entryChildrenLoadingIds.has(entry.id)
        if (isLoadingChildren) {
          return [
            row,
            {
              key: `${entry.id}:loading`,
              depth: depth + 1,
              parentFolderId: entry.id,
              placeholder: 'loading',
            },
          ]
        }

        const childEntries = getSortedEntryChildren(entry.id)
        if (childEntries.length === 0) {
          return [
            row,
            {
              key: `${entry.id}:empty`,
              depth: depth + 1,
              parentFolderId: entry.id,
              placeholder: 'empty',
            },
          ]
        }

        return [row, ...buildRows(childEntries, depth + 1, entry.id)]
      })
    }

    return buildRows(visibleRootEntries, 0)
  }, [visibleRootEntries, expandedEntryFolderIds, entryChildrenLoadingIds, entryChildrenByFolderId, sortMode])
  const visibleEntries = useMemo(
    () => visibleEntryRows.filter((row): row is EntryTreeRow & { entry: ExplorerEntry } => Boolean(row.entry)).map((row) => row.entry),
    [visibleEntryRows],
  )
  const selectedEntryIdSet = useMemo(() => new Set(selectedEntryIds), [selectedEntryIds])
  const allKnownEntryNodes = useMemo(() => {
    const collected: ExplorerEntry[] = [...baseDisplayEntries]
    for (const children of entryChildrenByFolderId.values()) {
      collected.push(...children)
    }
    return dedupeById(collected)
  }, [baseDisplayEntries, entryChildrenByFolderId])
  const entryById = useMemo(
    () => new Map(allKnownEntryNodes.map((entry) => [entry.id, entry] as const)),
    [allKnownEntryNodes],
  )
  const entryIndexById = useMemo(
    () => new Map(visibleEntries.map((entry, index) => [entry.id, index] as const)),
    [visibleEntries],
  )

  const selectedEntries = useMemo(
    () => selectedEntryIds.map((id) => entryById.get(id)).filter((entry): entry is ExplorerEntry => Boolean(entry)),
    [selectedEntryIds, entryById],
  )

  const showSourceColumn = useMemo(() => selectedSidebarFolderIds.length > 1, [selectedSidebarFolderIds])
  const sourceFolderHints = useMemo(
    () => buildSourceFolderHints(folders, selectedSidebarFolderIds),
    [folders, selectedSidebarFolderIds],
  )
  const sourceFolderByEntryId = useMemo(() => {
    if (!showSourceColumn || sourceFolderHints.length === 0) return new Map<string, SourceFolderHint>()
    const map = new Map<string, SourceFolderHint>()
    for (const entry of visibleEntries) {
      const hint = resolveSourceFolderHint(entry.path, sourceFolderHints)
      if (hint) {
        map.set(entry.id, hint)
      }
    }
    return map
  }, [visibleEntries, sourceFolderHints, showSourceColumn])

  const selectedPaths = useMemo(() => selectedEntries.map((e) => e.path), [selectedEntries])
  const selectedSidebarFolderPaths = useMemo(
    () =>
      selectedSidebarFolderIds
        .map((id) => allKnownFolderById.get(id)?.path)
        .filter((path): path is string => Boolean(path)),
    [selectedSidebarFolderIds, allKnownFolderById],
  )
  const operationSelectedPaths = useMemo(
    () => (selectedPaths.length > 0 ? selectedPaths : selectedSidebarFolderPaths),
    [selectedPaths, selectedSidebarFolderPaths],
  )
  const canCreateFolder = Boolean(previewPath || currentPath)
  const activeSortField = useMemo(() => resolveSortField(sortMode), [sortMode])
  const activeSortDirection = useMemo(() => resolveSortDirection(sortMode), [sortMode])

  const lastSelectedEntry = useMemo(() => {
    if (selectedEntryIds.length === 0) return null
    const lastId = selectedEntryIds[selectedEntryIds.length - 1]
    return entryById.get(lastId) ?? null
  }, [entryById, selectedEntryIds])

  const selectedFile = lastSelectedEntry?.kind === 'file' ? lastSelectedEntry : null
  const previewPdfFiles = useMemo<FileItem[]>(
    () =>
      orderedEntries
        .filter(
          (entry): entry is Extract<ExplorerEntry, { kind: 'file' }> =>
            entry.kind === 'file' && entry.ext.toLowerCase() === 'pdf',
        )
        .map(({ kind: _kind, ...file }) => file),
    [orderedEntries],
  )

  const cutPathSet = useMemo(
    () => new Set(clipboard?.mode === 'cut' ? clipboard.paths : []),
    [clipboard],
  )

  useEffect(() => {
    expandedEntryFolderIdsRef.current = expandedEntryFolderIds
  }, [expandedEntryFolderIds])

  useEffect(() => {
    operationInProgressRef.current = operationInProgress
  }, [operationInProgress])

  const resolveErrorMessage = (errorValue: unknown, fallback: string) => {
    if (errorValue instanceof Error && errorValue.message) return errorValue.message
    if (typeof errorValue === 'string' && errorValue) return errorValue
    if (typeof errorValue === 'object' && errorValue !== null && 'message' in errorValue) {
      const message = (errorValue as { message?: unknown }).message
      if (typeof message === 'string' && message) return message
    }
    return fallback
  }

  const normalizeClipboardState = (value: unknown): ClipboardState => {
    if (!value || typeof value !== 'object') {
      return null
    }

    const candidate = value as { mode?: unknown; paths?: unknown }
    const mode = candidate.mode === 'copy' || candidate.mode === 'cut' ? candidate.mode : null
    const paths = Array.isArray(candidate.paths)
      ? candidate.paths.filter((path): path is string => typeof path === 'string' && path.length > 0)
      : []

    if (!mode || paths.length === 0) {
      return null
    }

    return {
      mode,
      paths,
    }
  }

  const clearUndoToast = () => {
    if (undoToastTimerRef.current) {
      window.clearTimeout(undoToastTimerRef.current)
      undoToastTimerRef.current = null
    }
    setUndoToastMessage(null)
  }

  const showUndoToast = (entry: UndoEntry) => {
    if (undoToastTimerRef.current) {
      window.clearTimeout(undoToastTimerRef.current)
    }
    setUndoToastMessage(entry.label)
    undoToastTimerRef.current = window.setTimeout(() => {
      setUndoToastMessage(null)
      undoToastTimerRef.current = null
    }, 5000)
  }

  const registerUndoEntry = (entry: UndoEntry) => {
    pushUndoEntry(entry)
    showUndoToast(entry)
  }

  const toastState = useMemo(() => {
    if (error) {
      return {
        title: '작업 실패',
        message: error,
        tone: 'error' as const,
        inProgress: false,
        role: 'alert' as const,
        ariaLive: 'assertive' as const,
      }
    }
    if (!operationStatus) {
      return null
    }
    const isSuccess = operationStatus.includes('완료')
    const isInProgress = operationStatus.includes('중')
    return {
      title: isSuccess ? '작업 완료' : isInProgress ? '작업 진행 중' : '작업 상태',
      message: operationStatus,
      tone: isSuccess ? 'success' : 'info',
      inProgress: isInProgress,
      role: 'status' as const,
      ariaLive: 'polite' as const,
    }
  }, [error, operationStatus])

  async function loadDrives() {
    try {
      const [driveResult, quickResult] = await Promise.all([
        invoke<DriveItem[]>('list_drives'),
        invoke<DriveItem[]>('get_quick_access_paths'),
      ])
      setDrives(driveResult)
      setQuickAccess(quickResult)
    } catch {
      setDrives([])
      setQuickAccess([])
    }
  }

  async function loadFolders(path: string): Promise<FolderItem[]> {
    setFolderLoading(true)
    setError(null)

    try {
      const result = await invoke<FolderItem[]>('list_folders', { parentPath: path })
      setFolders(result)
      const folderIdSet = new Set(result.map((folder) => folder.id))
      setSelectedSidebarFolderIds((prev) => {
        const next = prev.filter((id) => folderIdSet.has(id))
        setSelectedFolderId((current) => {
          if (current && folderIdSet.has(current)) return current
          return next.length > 0 ? next[next.length - 1] : null
        })
        return next
      })
      return result
    } catch (e) {
      setError(e instanceof Error ? e.message : '폴더를 불러오지 못했습니다.')
      return []
    } finally {
      setFolderLoading(false)
    }
  }

  async function loadEntryChildren(folder: FolderItem): Promise<ExplorerEntry[]> {
    if (entryChildrenByFolderId.has(folder.id) || entryChildrenLoadingIds.has(folder.id)) {
      return []
    }

    setEntryChildrenLoadingIds((prev) => {
      const next = new Set(prev)
      next.add(folder.id)
      return next
    })

    try {
      const [childFolders, childFiles] = await Promise.all([
        invoke<FolderItem[]>('list_folders', { parentPath: folder.path }),
        invoke<FileItem[]>('list_files', { parentPath: folder.path }),
      ])
      const dedupedEntries = dedupeById([
        ...childFolders.map((entry) => ({ ...entry, kind: 'folder' as const })),
        ...childFiles.map((entry) => ({ ...entry, kind: 'file' as const })),
      ])

      setEntryChildrenByFolderId((prev) => {
        const next = new Map(prev)
        next.set(folder.id, dedupedEntries)
        return next
      })
      return dedupedEntries
    } catch (e) {
      setError(e instanceof Error ? e.message : '하위 항목을 불러오지 못했습니다.')
      setEntryChildrenByFolderId((prev) => {
        const next = new Map(prev)
        next.set(folder.id, [])
        return next
      })
      return []
    } finally {
      setEntryChildrenLoadingIds((prev) => {
        const next = new Set(prev)
        next.delete(folder.id)
        return next
      })
    }
  }

  function toggleRightPanelFolderExpansion(folder: FolderItem) {
    const isExpanded = expandedEntryFolderIds.has(folder.id)
    setExpandedEntryFolderIds((prev) => {
      const next = new Set(prev)
      if (isExpanded) {
        next.delete(folder.id)
      } else {
        next.add(folder.id)
      }
      return next
    })

    if (!isExpanded) {
      void loadEntryChildren(folder)
    }
  }

  async function loadPreviewEntries(
    pathOrPaths: string | string[],
    options?: { preserveExpandedState?: boolean },
  ) {
    const preserveExpandedState = options?.preserveExpandedState ?? false
    setPreviewLoading(true)
    setError(null)
    if (!preserveExpandedState) {
      setExpandedEntryFolderIds(new Set())
      setEntryChildrenByFolderId(new Map())
      setEntryChildrenLoadingIds(new Set())
    }
    const targetPaths = Array.isArray(pathOrPaths)
      ? Array.from(new Set(pathOrPaths.filter((path) => path.length > 0)))
      : [pathOrPaths]
    const expandedFolderIdsSnapshot = preserveExpandedState ? Array.from(expandedEntryFolderIdsRef.current) : []
    if (expandedFolderIdsSnapshot.length > 0) {
      setEntryChildrenLoadingIds((prev) => {
        const next = new Set(prev)
        expandedFolderIdsSnapshot.forEach((id) => next.add(id))
        return next
      })
    }

    try {
      const results = await Promise.all(
        targetPaths.map((path) =>
          Promise.all([
            invoke<FolderItem[]>('list_folders', { parentPath: path }),
            invoke<FileItem[]>('list_files', { parentPath: path }),
          ]),
        ),
      )
      const folderResult = dedupeById(results.flatMap(([folders]) => folders))
      const fileResult = dedupeById(results.flatMap(([, files]) => files))
      setPreviewFolders(folderResult)
      setPreviewFiles(fileResult)

      const idSet = new Set([...folderResult.map((entry) => entry.id), ...fileResult.map((entry) => entry.id)])
      setSelectedEntryIds((prev) => prev.filter((id) => idSet.has(id)))

      if (expandedFolderIdsSnapshot.length > 0) {
        const rootFoldersById = new Map(folderResult.map((folder) => [folder.id, folder] as const))
        const refreshedChildren = await Promise.all(
          expandedFolderIdsSnapshot.map(async (folderId) => {
            const knownFolder = rootFoldersById.get(folderId) ?? (() => {
              const knownEntry = entryById.get(folderId)
              return knownEntry?.kind === 'folder' ? knownEntry : null
            })()

            if (!knownFolder) {
              return { folderId, entries: null as ExplorerEntry[] | null }
            }

            try {
              const [childFolders, childFiles] = await Promise.all([
                invoke<FolderItem[]>('list_folders', { parentPath: knownFolder.path }),
                invoke<FileItem[]>('list_files', { parentPath: knownFolder.path }),
              ])

              return {
                folderId,
                entries: dedupeById([
                  ...childFolders.map((entry) => ({ ...entry, kind: 'folder' as const })),
                  ...childFiles.map((entry) => ({ ...entry, kind: 'file' as const })),
                ]),
              }
            } catch {
              return {
                folderId,
                entries: [] as ExplorerEntry[],
              }
            }
          }),
        )

        const removedExpandedIds = new Set(
          refreshedChildren
            .filter((result) => result.entries === null)
            .map((result) => result.folderId),
        )

        setEntryChildrenByFolderId((prev) => {
          const next = new Map(prev)
          refreshedChildren.forEach(({ folderId, entries }) => {
            if (entries === null) {
              next.delete(folderId)
              return
            }
            next.set(folderId, entries)
          })
          return next
        })

        if (removedExpandedIds.size > 0) {
          setExpandedEntryFolderIds((prev) => {
            const next = new Set(prev)
            removedExpandedIds.forEach((id) => next.delete(id))
            return next
          })
        }
      }
    } catch (e) {
      const fallback =
        targetPaths.length > 1
          ? '선택한 폴더 미리보기 항목을 불러오지 못했습니다.'
          : '미리보기 항목을 불러오지 못했습니다.'
      setError(e instanceof Error ? e.message : fallback)
      setPreviewFolders([])
      setPreviewFiles([])
      setSelectedEntryIds([])
    } finally {
      if (expandedFolderIdsSnapshot.length > 0) {
        setEntryChildrenLoadingIds((prev) => {
          const next = new Set(prev)
          expandedFolderIdsSnapshot.forEach((id) => next.delete(id))
          return next
        })
      }
      setPreviewLoading(false)
    }
  }

  async function navigateToPath(path: string) {
    if (isCompactLayout) {
      setSidebarCollapsed(true)
    }
    setCurrentPath(path)
    setPreviewPath(path)
    setSelectedFolderId(null)
    setSelectedSidebarFolderIds([])
    setSelectedEntryIds([])
    setInlineRenameId(null)
    setInlineRenameValue('')
    setSearchQuery('')
    lastClickedIndexRef.current = -1
    await Promise.all([loadFolders(path), loadPreviewEntries(path)])
  }

  async function refreshExplorer() {
    await loadDrives()
    if (currentPath) {
      await loadFolders(currentPath)
    }

    if (selectedSidebarFolderIds.length > 1) {
      const selectedFolderPaths = Array.from(
        new Set(selectedSidebarFolderIds.map((id) => allKnownFolderById.get(id)?.path).filter((path): path is string => Boolean(path))),
      )
      if (selectedFolderPaths.length > 1) {
        await loadPreviewEntries(selectedFolderPaths, { preserveExpandedState: true })
        return
      }
    }

    const targetPreview = previewPath || currentPath
    if (targetPreview) {
      await loadPreviewEntries(targetPreview, { preserveExpandedState: true })
    }
  }

  function shouldSkipDuplicateDrop(paths: string[], destinationPath: string, mode: PathOperationMode): boolean {
    const normalizedPaths = normalizeDragPaths(paths)
    if (!normalizedPaths.length || !destinationPath) return true

    const signature = `${mode}|${destinationPath}|${[...normalizedPaths].sort().join('|')}`
    const timestamp = Date.now()
    const previous = lastDropSignatureRef.current

    if (
      previous
      && previous.signature === signature
      && timestamp - previous.timestamp <= DROP_EVENT_DEDUPE_WINDOW_MS
    ) {
      return true
    }

    lastDropSignatureRef.current = { signature, timestamp }
    return false
  }

  function handleDroppedPaths(paths: string[], destinationPath: string, mode: PathOperationMode) {
    if (shouldSkipDuplicateDrop(paths, destinationPath, mode)) return
    void applyPathOperation(paths, destinationPath, mode)
  }

  async function applyPathOperation(
    paths: string[],
    destinationPath: string,
    mode: 'copy' | 'move',
    options?: { recordUndo?: boolean },
  ): Promise<boolean> {
    if (operationInProgressRef.current) return false
    const recordUndo = options?.recordUndo ?? true
    const normalized = paths.filter((path) => path && path !== destinationPath)
    if (!normalized.length) return false

    if (operationToastTimerRef.current) {
      window.clearTimeout(operationToastTimerRef.current)
      operationToastTimerRef.current = null
    }

    operationInProgressRef.current = true
    setOperationInProgress(true)
    setOperationStatus(mode === 'copy' ? '복사 중...' : '이동 중...')
    setError(null)

    try {
      const movedOrCopiedPaths =
        mode === 'copy'
          ? await invoke<string[]>('copy_paths', { paths: normalized, destinationDir: destinationPath })
          : await invoke<string[]>('move_paths', { paths: normalized, destinationDir: destinationPath })

      if (recordUndo) {
        if (mode === 'copy') {
          registerUndoEntry({
            type: 'copy',
            label: movedOrCopiedPaths.length === 1 ? '복사 완료' : `복사 완료 (${movedOrCopiedPaths.length}개)`,
            copiedPaths: movedOrCopiedPaths,
          })
        } else {
          registerUndoEntry({
            type: 'move',
            label: movedOrCopiedPaths.length === 1 ? '이동 완료' : `이동 완료 (${movedOrCopiedPaths.length}개)`,
            mappings: normalized.map((fromPath, index) => ({
              fromPath: movedOrCopiedPaths[index] ?? fromPath,
              toPath: fromPath,
            })),
          })
        }
      }

      await refreshExplorer()
      operationInProgressRef.current = false
      setOperationInProgress(false)
      setOperationStatus(mode === 'copy' ? '복사 완료' : '이동 완료')
      operationToastTimerRef.current = window.setTimeout(() => {
        setOperationStatus(null)
        operationToastTimerRef.current = null
      }, 3000)
      return true
    } catch (e) {
      operationInProgressRef.current = false
      setOperationInProgress(false)
      setOperationStatus(null)
      setError(resolveErrorMessage(e, `${mode === 'copy' ? '복사' : '이동'} 작업에 실패했습니다.`))
      return false
    }
  }

  async function setSharedClipboard(nextClipboard: Exclude<ClipboardState, null>) {
    await invoke('set_shared_clipboard', { clipboard: nextClipboard })
  }

  async function clearSharedClipboard() {
    await invoke('clear_shared_clipboard')
  }

  async function getLatestSharedClipboard(): Promise<ClipboardState> {
    try {
      const shared = await invoke<ClipboardState>('get_shared_clipboard')
      const normalized = normalizeClipboardState(shared)
      if (normalized) {
        setClipboard(normalized)
        writeLocalClipboardState(normalized)
      }
      return normalized
    } catch {
      return readLocalClipboardState()
    }
  }

  function syncClipboard(nextClipboard: ClipboardState) {
    setClipboard(nextClipboard)
    writeLocalClipboardState(nextClipboard)
    if (!nextClipboard) {
      void clearSharedClipboard().catch((error) => {
        setError(resolveErrorMessage(error, '클립보드 상태를 초기화하지 못했습니다.'))
      })
      return
    }

    void setSharedClipboard(nextClipboard).catch((error) => {
      setError(resolveErrorMessage(error, '클립보드 상태를 동기화하지 못했습니다.'))
    })
  }

  function tryStartNativeFileDrag(paths: string[], copyMode: boolean): boolean {
    if (!isTauriDesktopRuntime()) return false
    if (nativeDragContextRef.current) return false

    const normalizedPaths = normalizeDragPaths(paths)
    if (!normalizedPaths.length) return false

    const mode: PathOperationMode = copyMode ? 'copy' : 'move'
    nativeDragContextRef.current = { paths: normalizedPaths, mode }

    void startNativeDrag({
      item: normalizedPaths,
      icon: NATIVE_DRAG_PREVIEW_ICON,
      mode,
    })
      .catch(() => {
        // no-op
      })
      .finally(() => {
        nativeDragContextRef.current = null
      })

    return true
  }

  async function openSecondaryWindow() {
    if (isOpeningSecondaryWindow) return
    if (!isTauriDesktopRuntime()) {
      setError('새 창 기능은 데스크톱 앱(Tauri)에서만 사용할 수 있습니다.')
      return
    }

    setIsOpeningSecondaryWindow(true)
    try {
      await invoke('open_second_window')
    } catch (error) {
      setError(resolveErrorMessage(error, '두 번째 창을 열지 못했습니다.'))
    } finally {
      setIsOpeningSecondaryWindow(false)
    }
  }

  async function pasteClipboard() {
    if (operationInProgress) return
    const effectiveClipboard =
      clipboard ??
      (await getLatestSharedClipboard()) ??
      readLocalClipboardState()
    if (!effectiveClipboard) return

    const targetResolution = resolvePasteTarget({
      selectedFolderTargets: selectedEntries
        .filter((entry) => entry.kind === 'folder')
        .map((entry) => entry.path),
      previewPath,
      currentPath,
    })
    if (targetResolution.error || !targetResolution.targetPath) {
      setError(targetResolution.error ?? '붙여넣기 대상 폴더를 찾을 수 없습니다.')
      return
    }

    const completed = await applyPathOperation(
      effectiveClipboard.paths,
      targetResolution.targetPath,
      effectiveClipboard.mode === 'copy' ? 'copy' : 'move',
    )
    if (completed && effectiveClipboard.mode === 'cut') {
      syncClipboard(null)
    }
  }

  function renameSelected() {
    if (selectedEntryIds.length !== 1) return
    const entry = entryById.get(selectedEntryIds[0])
    if (!entry) return
    cancelInlineRename()
    setRenameTarget(entry)
    setRenameModalOpen(true)
  }

  function beginInlineRename(entry: ExplorerEntry) {
    setRenameModalOpen(false)
    setRenameTarget(null)
    setInlineRenameId(entry.id)
    setInlineRenameValue(entry.name)
    if (!selectedEntryIdSet.has(entry.id)) {
      setSelectedEntryIds([entry.id])
    }
    const entryIndex = entryIndexById.get(entry.id) ?? -1
    ensureEntryVisible(entryIndex)
  }

  function cancelInlineRename() {
    if (inlineRenameSubmittingRef.current) return
    setInlineRenameId(null)
    setInlineRenameValue('')
  }

  async function renameEntry(
    entry: ExplorerEntry,
    nextName: string,
    options?: { recordUndo?: boolean },
  ): Promise<string | null> {
    const trimmed = nextName.trim()
    const recordUndo = options?.recordUndo ?? true
    if (!trimmed || trimmed === entry.name) {
      return null
    }
    const renamed = entry.kind === 'file' ? withPreservedExtension(trimmed, entry.name) : trimmed
    if (renamed === entry.name) {
      return null
    }
    if (actionInProgress) {
      return null
    }
    setActionInProgress(true)

    try {
      const renamedPath = await invoke<string>('rename_path', { path: entry.path, newName: renamed })
      setSelectedEntryIds([renamedPath])

      if (recordUndo) {
        registerUndoEntry({
          type: 'rename',
          label: `이름 변경 완료: ${entry.name}`,
          oldPath: entry.path,
          newPath: renamedPath,
        })
      }

      const parentPath = previewPath || currentPath
      if (parentPath) {
        await invoke('rename_order_entry', {
          parentPath,
          oldId: entry.id,
          newId: renamedPath,
        }).catch(() => { /* order sync is best-effort */ })
      }

      await refreshExplorer()
      return renamedPath
    } catch (e) {
      setError(e instanceof Error ? e.message : '이름 변경에 실패했습니다.')
      return null
    } finally {
      setActionInProgress(false)
    }
  }

  async function handleRenameConfirm(nextName: string) {
    setRenameModalOpen(false)
    const entry = renameTarget
    setRenameTarget(null)
    if (!entry) return
    await renameEntry(entry, nextName)
  }

  async function commitInlineRename() {
    if (!inlineRenameId || inlineRenameSubmittingRef.current) return

    const entry = entryById.get(inlineRenameId)
    const pendingName = inlineRenameValue
    setInlineRenameId(null)
    setInlineRenameValue('')

    if (!entry) return
    inlineRenameSubmittingRef.current = true
    try {
      await renameEntry(entry, pendingName)
    } finally {
      inlineRenameSubmittingRef.current = false
    }
  }

  function createNewFolder() {
    const targetPath = previewPath || currentPath
    if (!targetPath) return
    setCreateFolderModalOpen(true)
  }

  async function handleCreateFolderConfirm(nextName: string) {
    setCreateFolderModalOpen(false)
    const targetPath = previewPath || currentPath
    if (!targetPath) return
    if (nextName.trim() === '') return
    if (actionInProgress) return
    setActionInProgress(true)

    try {
      const createdPath = await invoke<string>('create_folder', {
        parentPath: targetPath,
        folderName: nextName.trim(),
      })
      await refreshExplorer()
      setSelectedEntryIds([createdPath])
    } catch (e) {
      setError(e instanceof Error ? e.message : '새 폴더 생성에 실패했습니다.')
    } finally {
      setActionInProgress(false)
    }
  }

  async function deleteSelected() {
    if (selectedEntries.length === 0) return
    const names = selectedEntries.map((e) => e.name).join('\n')
    const deletedPaths = [...selectedPaths]
    const deletedLabel =
      selectedEntries.length === 1
        ? `휴지통 이동: ${selectedEntries[0].name}`
        : `휴지통 이동: ${selectedEntries.length}개 항목`
    const msg =
      selectedEntries.length === 1
        ? `선택한 항목을 휴지통으로 이동하시겠습니까?\n${names}`
        : `선택한 ${selectedEntries.length}개 항목을 휴지통으로 이동하시겠습니까?\n${names}`
    const confirmed = window.confirm(msg)
    if (!confirmed) return
    if (actionInProgress) return
    setActionInProgress(true)

    try {
      await invoke('delete_paths', { paths: selectedPaths })
      registerUndoEntry({
        type: 'delete',
        label: deletedLabel,
        deletedPaths,
      })
      setSelectedEntryIds([])
      await refreshExplorer()
    } catch (e) {
      setError(e instanceof Error ? e.message : '휴지통 이동에 실패했습니다.')
    } finally {
      setActionInProgress(false)
    }
  }

  async function undoLastAction() {
    if (actionInProgress || operationInProgress) return
    const entry = popUndoEntry()
    if (!entry) {
      setOperationStatus('실행 취소할 작업이 없습니다.')
      operationToastTimerRef.current = window.setTimeout(() => {
        setOperationStatus(null)
        operationToastTimerRef.current = null
      }, 2000)
      return
    }

    clearUndoToast()
    setActionInProgress(true)
    setError(null)

    try {
      switch (entry.type) {
        case 'rename': {
          const originalName = getPathName(entry.oldPath)
          const restoredPath = await invoke<string>('rename_path', {
            path: entry.newPath,
            newName: originalName,
          })
          setSelectedEntryIds([restoredPath])
          break
        }
        case 'move': {
          for (const mapping of entry.mappings) {
            const destinationDir = getFileDirectory(mapping.toPath)
            const destinationName = getPathName(mapping.toPath)
            const movedBack = await invoke<string[]>('move_paths', {
              paths: [mapping.fromPath],
              destinationDir,
            })
            const movedBackPath = movedBack[0]
            if (movedBackPath && movedBackPath !== mapping.toPath) {
              await invoke<string>('rename_path', {
                path: movedBackPath,
                newName: destinationName,
              })
            }
          }
          break
        }
        case 'copy': {
          await invoke('delete_paths', { paths: entry.copiedPaths })
          break
        }
        case 'delete': {
          const restoredPaths = await invoke<string[]>('restore_paths_from_trash', {
            paths: entry.deletedPaths,
          })
          if (restoredPaths.length > 0) {
            setSelectedEntryIds(restoredPaths)
          }
          break
        }
      }

      await refreshExplorer()
      setOperationStatus('실행 취소 완료')
      operationToastTimerRef.current = window.setTimeout(() => {
        setOperationStatus(null)
        operationToastTimerRef.current = null
      }, 3000)
    } catch (e) {
      pushUndoEntry(entry)
      setError(resolveErrorMessage(e, '실행 취소에 실패했습니다.'))
    } finally {
      setActionInProgress(false)
    }
  }

  async function openEntry(entry: ExplorerEntry) {
    if (entry.kind === 'folder') {
      await navigateToPath(entry.path)
      return
    }

    if (entry.kind === 'file' && entry.ext.toLowerCase() === 'pdf') {
      setSelectedEntryIds([entry.id])
      setPdfModalOpen(true)
      return
    }

    try {
      await invoke('open_path_in_system', { path: entry.path })
    } catch (e) {
      setError(e instanceof Error ? e.message : '파일을 열지 못했습니다.')
    }
  }

  useEffect(() => {
    if (!pdfModalOpen && mergePdfModalOpen) {
      setMergePdfModalOpen(false)
    }
  }, [pdfModalOpen, mergePdfModalOpen])

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth
      const height = window.innerHeight
      const isPortrait = height > width
      const compact = width <= 1120 || (isPortrait && width <= 1600)
      setIsCompactLayout(compact)
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const prevCompact = compactLayoutRef.current
    if (prevCompact === null) {
      setSidebarCollapsed(isCompactLayout)
    } else if (isCompactLayout && !prevCompact) {
      setSidebarCollapsed(true)
    } else if (!isCompactLayout && prevCompact) {
      setSidebarCollapsed(false)
    }
    compactLayoutRef.current = isCompactLayout
  }, [isCompactLayout])

  useEffect(() => {
    if (!isCompactLayout || sidebarCollapsed) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSidebarCollapsed(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isCompactLayout, sidebarCollapsed])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(BOOKMARK_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as BookmarkItem[]
      if (Array.isArray(parsed)) {
        setBookmarks(parsed.filter((item) => item && typeof item.path === 'string'))
      }
    } catch {
      setBookmarks([])
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(bookmarks))
  }, [bookmarks])

  useEffect(() => {
    let cancelled = false

    invoke<ClipboardState>('get_shared_clipboard')
      .then((clipboardValue) => {
        if (cancelled) return
        const normalized = normalizeClipboardState(clipboardValue) ?? readLocalClipboardState()
        setClipboard(normalized)
        writeLocalClipboardState(normalized)
      })
      .catch(() => {
        if (cancelled) return
        setClipboard(readLocalClipboardState())
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let unlisten: UnlistenFn | undefined

    listen<{ clipboard?: ClipboardState | null }>(SHARED_CLIPBOARD_EVENT, (event) => {
      const nextClipboard = normalizeClipboardState(event.payload?.clipboard)
      setClipboard(nextClipboard)
      writeLocalClipboardState(nextClipboard)
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup()
          return
        }
        unlisten = cleanup
      })
      .catch(() => {
        // no-op
      })

    return () => {
      disposed = true
      if (unlisten) {
        unlisten()
      }
    }
  }, [])

  useEffect(() => {
    async function bootstrap() {
      try {
        const initialPath = await invoke<string>('get_default_root_path')
        setCurrentPath(initialPath)
        setPreviewPath(initialPath)
        await Promise.all([loadDrives(), loadFolders(initialPath), loadPreviewEntries(initialPath)])
      } catch (e) {
        setError(e instanceof Error ? e.message : '초기 경로를 불러오지 못했습니다.')
      }
    }

    void bootstrap()
  }, [])

  useEffect(() => {
    if (orderMode !== 'manual' || !currentPath) return

    invoke<string[]>('load_manual_order', { parentPath: currentPath })
      .then(setFolderManualOrderIds)
      .catch(() => setFolderManualOrderIds([]))
  }, [orderMode, currentPath])

  useEffect(() => {
    if (orderMode !== 'manual' || !previewPath) {
      setEntryManualOrderIds([])
      return
    }

    invoke<string[]>('load_file_manual_order', { parentPath: previewPath })
      .then(setEntryManualOrderIds)
      .catch(() => setEntryManualOrderIds([]))
  }, [orderMode, previewPath])

  useEffect(() => {
    setVisibleFolderCount(FOLDER_PAGE_SIZE)
  }, [currentPath, sortMode, orderMode])

  useEffect(() => {
    setVisibleEntryCount(ENTRY_PAGE_SIZE)
  }, [previewPath, searchQuery, sortMode, orderMode])

  const ensureEntryVisible = (entryIndex: number) => {
    if (entryIndex < 0 || orderMode === 'manual') return
    setVisibleEntryCount((prev) => {
      if (entryIndex < visibleEntries.length) return prev
      return Math.min(baseDisplayEntries.length, prev + ENTRY_PAGE_SIZE)
    })
  }

  useEffect(() => {
    if (!inlineRenameId) return

    const raf = window.requestAnimationFrame(() => {
      inlineRenameInputRef.current?.focus()
      inlineRenameInputRef.current?.select()
    })

    return () => window.cancelAnimationFrame(raf)
  }, [inlineRenameId, viewMode])

  useEffect(() => {
    if (!inlineRenameId) return
    if (!entryById.has(inlineRenameId)) {
      setInlineRenameId(null)
      setInlineRenameValue('')
    }
  }, [inlineRenameId, entryById])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        return
      }

      const ctrlOrMeta = event.ctrlKey || event.metaKey

      if (ctrlOrMeta && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelectedEntryIds(visibleEntries.map((e) => e.id))
        return
      }
      if (ctrlOrMeta && event.key.toLowerCase() === 'c' && operationSelectedPaths.length > 0 && !operationInProgress) {
        event.preventDefault()
        syncClipboard({ mode: 'copy', paths: [...operationSelectedPaths] })
        return
      }
      if (ctrlOrMeta && event.key.toLowerCase() === 'x' && operationSelectedPaths.length > 0 && !operationInProgress) {
        event.preventDefault()
        syncClipboard({ mode: 'cut', paths: [...operationSelectedPaths] })
        return
      }
      if (ctrlOrMeta && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        if (!operationInProgress) {
          void pasteClipboard()
        }
        return
      }
      if (ctrlOrMeta && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void undoLastAction()
        return
      }
      if (ctrlOrMeta && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void createNewFolder()
        return
      }
      if (event.key === 'F2') {
        event.preventDefault()
        void renameSelected()
        return
      }
      if (event.key === 'Delete' && selectedEntries.length > 0) {
        event.preventDefault()
        void deleteSelected()
        return
      }
      if (event.key === 'Enter' && lastSelectedEntry) {
        event.preventDefault()
        void openEntry(lastSelectedEntry)
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const currentIndex =
          selectedEntryIds.length > 0
            ? (entryIndexById.get(selectedEntryIds[selectedEntryIds.length - 1]) ?? -1)
            : -1
        const nextIndex = Math.min(currentIndex + 1, visibleEntries.length - 1)
        if (nextIndex >= 0) {
          ensureEntryVisible(nextIndex)
          if (event.shiftKey) {
            const id = visibleEntries[nextIndex].id
            setSelectedEntryIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
          } else {
            setSelectedEntryIds([visibleEntries[nextIndex].id])
          }
          lastClickedIndexRef.current = nextIndex
        }
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const currentIndex =
          selectedEntryIds.length > 0
            ? (entryIndexById.get(selectedEntryIds[selectedEntryIds.length - 1]) ?? visibleEntries.length)
            : visibleEntries.length
        const prevIndex = Math.max(currentIndex - 1, 0)
        if (visibleEntries.length > 0) {
          ensureEntryVisible(prevIndex)
          if (event.shiftKey) {
            const id = visibleEntries[prevIndex].id
            setSelectedEntryIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
          } else {
            setSelectedEntryIds([visibleEntries[prevIndex].id])
          }
          lastClickedIndexRef.current = prevIndex
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedEntries, selectedEntryIds, lastSelectedEntry, visibleEntries, baseDisplayEntries, entryIndexById, previewPath, clipboard, operationInProgress, orderMode, operationSelectedPaths])

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 10000)
    return () => clearTimeout(timer)
  }, [error])

  useEffect(() => {
    return () => {
      if (operationToastTimerRef.current) {
        window.clearTimeout(operationToastTimerRef.current)
      }
      if (undoToastTimerRef.current) {
        window.clearTimeout(undoToastTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return
        const droppedPaths = normalizeDragPaths(event.payload.paths)
        if (!droppedPaths.length) return

        const dropPathFromPoint = resolveDropPathFromWindowPosition({
          x: event.payload.position.x,
          y: event.payload.position.y,
        })
        const target = dropPathFromPoint || previewPath || currentPath
        if (!target) return

        const nativeDragContext = nativeDragContextRef.current
        const mode: PathOperationMode =
          nativeDragContext && areSamePathSet(nativeDragContext.paths, droppedPaths)
            ? nativeDragContext.mode
            : 'copy'

        handleDroppedPaths(droppedPaths, target, mode)
      })
      .then((cleanup) => {
        if (disposed) {
          cleanup()
          return
        }
        unlisten = cleanup
      })
      .catch(() => {
        // no-op
      })

    return () => {
      disposed = true
      if (unlisten) {
        unlisten()
      }
    }
  }, [previewPath, currentPath])

  const handleSidebarFolderClick = (folder: FolderItem, modifiers: SidebarSelectModifiers) => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current)
    }

    clickTimerRef.current = window.setTimeout(() => {
      setInlineRenameId(null)
      setInlineRenameValue('')
      const nextSelectedIds = modifiers.ctrl
        ? (selectedSidebarFolderIdSet.has(folder.id)
          ? selectedSidebarFolderIds.filter((id) => id !== folder.id)
          : [...selectedSidebarFolderIds, folder.id])
        : [folder.id]
      const nextFolderIdSet = new Set(nextSelectedIds)
      const nextSelectedFolders = Array.from(nextFolderIdSet)
        .map((id) => allKnownFolderById.get(id))
        .filter((item): item is FolderItem => Boolean(item))
      const normalizedSelectedIds = nextSelectedFolders.map((item) => item.id)

      setSelectedSidebarFolderIds(normalizedSelectedIds)

      if (nextSelectedFolders.length === 0) {
        setSelectedFolderId(null)
        setPreviewPath(currentPath)
        if (currentPath) {
          void loadPreviewEntries(currentPath)
        }
        clickTimerRef.current = null
        return
      }

      const activeFolder = nextSelectedFolders.find((item) => item.id === folder.id) ?? nextSelectedFolders[nextSelectedFolders.length - 1]
      setSelectedFolderId(activeFolder.id)
      setPreviewPath(activeFolder.path)

      if (nextSelectedFolders.length > 1) {
        void loadPreviewEntries(nextSelectedFolders.map((item) => item.path))
      } else {
        void loadPreviewEntries(activeFolder.path)
      }
      if (isCompactLayout) {
        setSidebarCollapsed(true)
      }
      clickTimerRef.current = null
    }, 200)
  }

  const handleSidebarFolderDoubleClick = (folder: FolderItem) => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }

    setSelectedSidebarFolderIds([])
    void navigateToPath(folder.path)
  }

  const handleEntrySelect = (entry: ExplorerEntry, modifiers: SelectModifiers) => {
    const entryIndex = entryIndexById.get(entry.id) ?? -1
    if (entryIndex < 0) return
    if (inlineRenameId && inlineRenameId !== entry.id) {
      cancelInlineRename()
    }

    if (modifiers.shift && lastClickedIndexRef.current >= 0) {
      const start = Math.min(lastClickedIndexRef.current, entryIndex)
      const end = Math.max(lastClickedIndexRef.current, entryIndex)
      const rangeIds = visibleEntries.slice(start, end + 1).map((e) => e.id)

      if (modifiers.ctrl) {
        setSelectedEntryIds((prev) => {
          const set = new Set(prev)
          rangeIds.forEach((id) => set.add(id))
          return Array.from(set)
        })
      } else {
        setSelectedEntryIds(rangeIds)
      }
      ensureEntryVisible(entryIndex)
    } else if (modifiers.ctrl) {
      setSelectedEntryIds((prev) =>
        prev.includes(entry.id) ? prev.filter((id) => id !== entry.id) : [...prev, entry.id],
      )
      lastClickedIndexRef.current = entryIndex
      ensureEntryVisible(entryIndex)
    } else {
      setSelectedEntryIds([entry.id])
      lastClickedIndexRef.current = entryIndex
      ensureEntryVisible(entryIndex)
    }
  }

  const handleGoParent = async () => {
    if (!currentPath) return

    try {
      const parentPath = await invoke<string>('get_parent_path', { path: currentPath })
      if (parentPath && parentPath !== currentPath) {
        await navigateToPath(parentPath)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '상위 폴더로 이동하지 못했습니다.')
    }
  }

  const handleRefresh = async () => {
    await refreshExplorer()
  }

  const handleLoadMoreFolders = () => {
    setVisibleFolderCount((prev) => Math.min(displayFolders.length, prev + FOLDER_PAGE_SIZE))
  }

  const handleLoadMoreEntries = () => {
    setVisibleEntryCount((prev) => Math.min(baseDisplayEntries.length, prev + ENTRY_PAGE_SIZE))
  }

  const handleOrderModeToggle = async () => {
    const nextMode: OrderMode = orderMode === 'auto' ? 'manual' : 'auto'
    setOrderMode(nextMode)

    if (nextMode === 'manual') {
      try {
        const [savedFolders, savedEntries] = await Promise.all([
          currentPath ? invoke<string[]>('load_manual_order', { parentPath: currentPath }) : Promise.resolve([]),
          previewPath ? invoke<string[]>('load_file_manual_order', { parentPath: previewPath }) : Promise.resolve([]),
        ])
        setFolderManualOrderIds(savedFolders)
        setEntryManualOrderIds(savedEntries)
      } catch {
        setFolderManualOrderIds([])
        setEntryManualOrderIds([])
      }
    }
  }

  const handleFolderDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null)
    if (orderMode !== 'manual') return
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = displayFolders.findIndex((folder) => folder.id === active.id)
    const newIndex = displayFolders.findIndex((folder) => folder.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return

    const reordered = arrayMove(displayFolders, oldIndex, newIndex)
    const ids = reordered.map((folder) => folder.id)
    setFolderManualOrderIds(ids)

    try {
      await invoke('save_manual_order', { parentPath: currentPath, orderedIds: ids })
    } catch (e) {
      setError(e instanceof Error ? e.message : '폴더 순서 저장에 실패했습니다.')
    }
  }

  const handleEntryDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null)
    if (orderMode !== 'manual' || !previewPath) return
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = baseDisplayEntries.findIndex((entry) => entry.id === active.id)
    const newIndex = baseDisplayEntries.findIndex((entry) => entry.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return

    const reordered = arrayMove(baseDisplayEntries, oldIndex, newIndex)
    const ids = reordered.map((entry) => entry.id)
    setEntryManualOrderIds(ids)

    try {
      await invoke('save_file_manual_order', {
        parentPath: previewPath,
        orderedIds: ids,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : '항목 순서 저장에 실패했습니다.')
    }
  }

  const getRightPanelFolderToggleState = (entry: ExplorerEntry) => {
    if (entry.kind !== 'folder') {
      return {
        canExpand: false,
        isExpanded: false,
        isLoadingChildren: false,
      }
    }

    const isExpanded = expandedEntryFolderIds.has(entry.id)
    const isLoadingChildren = entryChildrenLoadingIds.has(entry.id)
    const childEntries = getSortedEntryChildren(entry.id)
    const hasLoadedChildren = entryChildrenByFolderId.has(entry.id)
    const canExpand = isLoadingChildren || !hasLoadedChildren || isExpanded || childEntries.length > 0

    return {
      canExpand,
      isExpanded,
      isLoadingChildren,
    }
  }

  const handleContextMenu = (e: React.MouseEvent, entry: ExplorerEntry) => {
    e.preventDefault()
    e.stopPropagation()
    if (inlineRenameId && inlineRenameId !== entry.id) {
      cancelInlineRename()
    }
    if (!selectedEntryIdSet.has(entry.id)) {
      setSelectedEntryIds([entry.id])
      const entryIndex = entryIndexById.get(entry.id) ?? -1
      lastClickedIndexRef.current = entryIndex
      ensureEntryVisible(entryIndex)
    }
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const handleContentContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    cancelInlineRename()
    setSelectedEntryIds([])
    lastClickedIndexRef.current = -1
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return []
    const entry = selectedEntries.length === 1 ? selectedEntries[0] : null
    return [
      {
        label: '열기',
        shortcut: 'Enter',
        disabled: !entry,
        onClick: () => { if (entry) void openEntry(entry) },
      },
      {
        label: '이름 바꾸기',
        icon: <Pencil size={14} />,
        shortcut: 'F2',
        disabled: selectedEntryIds.length !== 1,
        onClick: () => void renameSelected(),
      },
      {
        label: '복사',
        icon: <Copy size={14} />,
        shortcut: 'Ctrl+C',
        disabled: operationSelectedPaths.length === 0,
        onClick: () => syncClipboard({ mode: 'copy', paths: [...operationSelectedPaths] }),
      },
      {
        label: '잘라내기',
        icon: <Scissors size={14} />,
        shortcut: 'Ctrl+X',
        disabled: operationSelectedPaths.length === 0,
        onClick: () => syncClipboard({ mode: 'cut', paths: [...operationSelectedPaths] }),
      },
      {
        label: '붙여넣기',
        icon: <ClipboardPaste size={14} />,
        shortcut: 'Ctrl+V',
        disabled: !clipboard,
        onClick: () => void pasteClipboard(),
      },
      {
        label: '새 폴더 만들기',
        icon: <FolderPlus size={14} />,
        shortcut: 'Ctrl+Shift+N',
        disabled: !canCreateFolder || actionInProgress,
        onClick: () => void createNewFolder(),
      },
      {
        label: '휴지통으로 이동',
        icon: <Trash2 size={14} />,
        shortcut: 'Del',
        danger: true,
        disabled: selectedEntries.length === 0,
        onClick: () => void deleteSelected(),
      },
    ]
  }, [contextMenu, selectedEntries, selectedEntryIds, operationSelectedPaths, clipboard, canCreateFolder, actionInProgress])

  const handleAddBookmark = () => {
    const targetPath = previewPath || currentPath
    if (!targetPath) return

    setBookmarks((prev) => {
      if (prev.some((item) => item.path === targetPath)) {
        return prev
      }
      return [
        ...prev,
        {
          id: targetPath,
          path: targetPath,
          name: deriveBookmarkName(targetPath),
        },
      ]
    })
  }

  const handleRemoveBookmark = (id: string) => {
    setBookmarks((prev) => prev.filter((item) => item.id !== id))
  }

  const handleSortFieldChange = (field: SortField) => {
    const nextDirection = field === 'size' ? 'desc' : activeSortDirection
    setSortMode(toSortMode(field, nextDirection))
  }

  const handleSortDirectionChange = (direction: SortDirection) => {
    if (activeSortField === 'size') return
    setSortMode(toSortMode(activeSortField, direction))
  }

  return (
    <div className="explorer-app" role="application" aria-label="Windows style explorer">
      <header className="window-header">
        <h1>파일 탐색기</h1>
        <nav className="path-breadcrumb" aria-label="path breadcrumb">
          {buildBreadcrumbs(previewPath || currentPath).map((seg, i, arr) => (
            <span key={seg.path}>
              <button
                className="breadcrumb-btn"
                onClick={() => void navigateToPath(seg.path)}
                title={seg.path}
              >
                {seg.label}
              </button>
              {i < arr.length - 1 && <span className="breadcrumb-sep">\</span>}
            </span>
          ))}
        </nav>
      </header>

      <section className="command-bar">
        {isCompactLayout && (
          <button
            type="button"
            className={`win-btn sidebar-toggle-btn ${sidebarCollapsed ? '' : 'active'}`}
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            aria-label={sidebarCollapsed ? '사이드바 열기' : '사이드바 닫기'}
            aria-controls="explorer-sidebar"
            aria-expanded={!sidebarCollapsed}
          >
            <Menu size={16} />
            {sidebarCollapsed ? '메뉴' : '메뉴 닫기'}
          </button>
        )}
        <button className="win-btn" onClick={() => void handleGoParent()}>
          <ArrowUp size={16} /> 상위 폴더
        </button>
        <button className="win-btn" onClick={() => void handleRefresh()}>
          <RefreshCcw size={15} /> 새로 고침
        </button>
        <button
          className="win-btn"
          disabled={isOpeningSecondaryWindow || !isTauriDesktopRuntime()}
          onClick={() => void openSecondaryWindow()}
          aria-busy={isOpeningSecondaryWindow}
          title={
            !isTauriDesktopRuntime()
              ? '데스크톱 앱(Tauri)에서만 새 창을 열 수 있습니다.'
              : isOpeningSecondaryWindow
                ? '새 창을 여는 중입니다.'
                : '새 창'
          }
        >
          <Monitor size={15} /> {isOpeningSecondaryWindow ? '열기 중...' : '새 창'}
        </button>

        <div className="sort-controls" aria-label="정렬 옵션">
          <div className="sort-chip-group" role="group" aria-label="정렬 기준">
            <button
              type="button"
              className={`sort-chip ${activeSortField === 'name' ? 'active' : ''}`}
              disabled={orderMode === 'manual'}
              onClick={() => handleSortFieldChange('name')}
            >
              이름
            </button>
            <button
              type="button"
              className={`sort-chip ${activeSortField === 'modifiedAt' ? 'active' : ''}`}
              disabled={orderMode === 'manual'}
              onClick={() => handleSortFieldChange('modifiedAt')}
            >
              수정일
            </button>
            <button
              type="button"
              className={`sort-chip ${activeSortField === 'size' ? 'active' : ''}`}
              disabled={orderMode === 'manual'}
              onClick={() => handleSortFieldChange('size')}
            >
              크기
            </button>
          </div>
          <div className="sort-chip-group" role="group" aria-label="정렬 방향">
            <button
              type="button"
              className={`sort-chip ${activeSortDirection === 'asc' ? 'active' : ''}`}
              disabled={orderMode === 'manual' || activeSortField === 'size'}
              onClick={() => handleSortDirectionChange('asc')}
            >
              정방향
            </button>
            <button
              type="button"
              className={`sort-chip ${activeSortDirection === 'desc' ? 'active' : ''}`}
              disabled={orderMode === 'manual' || activeSortField === 'size'}
              onClick={() => handleSortDirectionChange('desc')}
            >
              역순
            </button>
          </div>
        </div>

        <button className={`win-btn ${orderMode === 'manual' ? 'active' : ''}`} onClick={() => void handleOrderModeToggle()}>
          수동 정렬 {orderMode === 'manual' ? 'ON' : 'OFF'}
        </button>

        <button className="win-btn" onClick={handleAddBookmark}>
          <BookmarkPlus size={16} /> 북마크 고정
        </button>

        <SearchBar value={searchQuery} onChange={setSearchQuery} />

        <div className="mode-switch" role="tablist" aria-label="view mode">
          <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>
            <List size={15} /> 목록
          </button>
          <button className={viewMode === 'gallery' ? 'active' : ''} onClick={() => setViewMode('gallery')}>
            <Grid2x2 size={15} /> 갤러리
          </button>
        </div>
      </section>

      <section className="bookmark-bar" aria-label="folder bookmarks">
        <span className="bookmark-title">북마크</span>
        {bookmarks.length === 0 ? (
          <span className="bookmark-empty">고정된 폴더가 없습니다.</span>
        ) : (
          bookmarks.map((item) => (
            <div key={item.id} className="bookmark-chip">
              <button className="bookmark-link" onClick={() => void navigateToPath(item.path)} title={toWindowsStylePath(item.path)}>
                {item.name}
              </button>
              <button className="bookmark-remove" onClick={() => handleRemoveBookmark(item.id)} aria-label="remove bookmark">
                <X size={12} />
              </button>
            </div>
          ))
        )}
      </section>

      <main className={`explorer-layout ${isCompactLayout ? 'compact-layout' : ''} ${isCompactLayout && sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        {isCompactLayout && !sidebarCollapsed && (
          <button
            type="button"
            className="sidebar-scrim"
            onClick={() => setSidebarCollapsed(true)}
            aria-label="사이드바 닫기"
          />
        )}
        <aside id="explorer-sidebar" className="sidebar" aria-hidden={isCompactLayout && sidebarCollapsed}>
          <div className="pane-title">드라이브</div>
          <ul className="drive-list" role="listbox" aria-label="드라이브 목록">
            {drives.map((drive) => (
              <li key={drive.id} role="option" aria-selected={currentPath.startsWith(drive.path)}>
                <button
                  className={`drive-btn ${currentPath.startsWith(drive.path) ? 'active' : ''}`}
                  data-drop-path={drive.path}
                  onClick={() => void navigateToPath(drive.path)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    const paths = readDragPayload(event)
                    if (!paths.length) return
                    const mode: PathOperationMode = resolveDropCopyMode(event) ? 'copy' : 'move'
                    handleDroppedPaths(paths, drive.path, mode)
                  }}
                >
                  <HardDrive size={15} /> {drive.label}
                </button>
              </li>
            ))}
          </ul>

          {quickAccess.length > 0 && (
            <>
              <div className="pane-title">빠른 액세스</div>
              <ul className="drive-list">
                {quickAccess.map((item) => (
                  <li key={item.id}>
                    <button
                      className={`drive-btn ${(previewPath || currentPath) === item.path ? 'active' : ''}`}
                      data-drop-path={item.path}
                      onClick={() => void navigateToPath(item.path)}
                    >
                      {item.id === 'quick:desktop' ? <Monitor size={15} /> : <FolderDown size={15} />} {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="pane-title">폴더 ({displayFolders.length})</div>
          {folderLoading ? (
            <p className="state-text">폴더 로딩 중...</p>
          ) : (
            <>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFolderDragEnd} onDragStart={(event) => setActiveDragId(String(event.active.id))}>
                  <SortableContext items={visibleFolders.map((folder) => folder.id)} strategy={verticalListSortingStrategy}>
                    <ul className="sidebar-list" role="listbox" aria-label="폴더 목록" aria-multiselectable="true">
                      {visibleFolders.map((folder) => (
                        <SortableFolderRow
                          key={folder.id}
                          folder={folder}
                          selected={selectedSidebarFolderIdSet.has(folder.id)}
                          manualMode={orderMode === 'manual'}
                          sortable
                          depth={0}
                          onClick={handleSidebarFolderClick}
                          onDoubleClick={handleSidebarFolderDoubleClick}
                          onDropEntries={(paths, destinationPath, copyMode) =>
                            handleDroppedPaths(paths, destinationPath, copyMode ? 'copy' : 'move')
                          }
                        />
                      ))}
                    </ul>
                  </SortableContext>
                <DragOverlay>
                  {activeDragId ? (
                    <div style={{ padding: '8px 12px', background: '#fff', border: '1px solid var(--accent)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Folder size={16} /> {displayFolders.find((folder) => folder.id === activeDragId)?.name}
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
              {hasMoreFolders && (
                <div className="load-more-wrap">
                  <p className="state-text compact">{visibleFolders.length} / {displayFolders.length}개 폴더 표시 중</p>
                  <button className="win-btn load-more-btn" onClick={handleLoadMoreFolders}>
                    폴더 더 보기 (+{Math.min(FOLDER_PAGE_SIZE, displayFolders.length - visibleFolders.length)})
                  </button>
                </div>
              )}
            </>
          )}
        </aside>

        <section
          className="content-pane"
          data-drop-path={previewPath || currentPath || undefined}
          onDragOver={(event) => {
            if (!hasExplorerDragPayload(event)) return
            event.preventDefault()
            updateDropEffect(event)
          }}
          onDrop={(event) => {
            if (!hasExplorerDragPayload(event)) return
            event.preventDefault()
            const destinationPath = previewPath || currentPath
            if (!destinationPath) return
            const paths = readDragPayload(event)
            if (!paths.length) return
            const mode: PathOperationMode = resolveDropCopyMode(event) ? 'copy' : 'move'
            handleDroppedPaths(paths, destinationPath, mode)
          }}
        >
          <div className="pane-head">
            <p className="pane-summary">
              {baseDisplayEntries.length}개 항목
              {hasMoreEntries && ` · ${visibleRootEntries.length}개 표시 중`}
              {selectedSidebarFolderIds.length > 1 && ` · 폴더 ${selectedSidebarFolderIds.length}개 통합 보기`}
              {selectedEntries.length > 0 && ` · ${selectedEntries.length}개 선택됨`}
              {clipboard && ` · 클립보드: ${clipboard.mode === 'copy' ? '복사' : '잘라내기'} ${clipboard.paths.length}개`}
            </p>
            {showSourceColumn && sourceFolderHints.length > 0 && (
              <div className="source-badges" role="list" aria-label="통합 보기 출처">
                {sourceFolderHints.map((folder) => (
                  <span key={folder.id} className="source-badge" role="listitem" title={folder.path}>
                    <span className="source-badge-dot" style={{ background: folder.color }} />
                    <span className="source-badge-label">{folder.label}</span>
                  </span>
                ))}
              </div>
            )}
            <p className="pane-hint">
              드래그 기본 동작: 이동 (Ctrl/Cmd를 누르면 복사)
            </p>
            <div className="pane-actions">
              {pdfModalOpen && (
                <>
                  <button
                    className="win-btn"
                    style={{ borderColor: 'var(--border)' }}
                    disabled={previewPdfFiles.length < 2}
                    onClick={() => setMergePdfModalOpen(true)}
                  >
                    PDF 병합
                  </button>
                  <button
                    className="win-btn primary"
                    disabled={selectedFile?.ext.toLowerCase() !== 'pdf'}
                    onClick={() => setPdfModalOpen(true)}
                  >
                    PDF 페이지 추출
                  </button>
                </>
              )}
            </div>
          </div>

          {previewLoading && <p className="state-text">항목 로딩 중...</p>}
          {!previewLoading && baseDisplayEntries.length === 0 && <p className="state-text">현재 폴더가 비어 있습니다.</p>}

          {!previewLoading && baseDisplayEntries.length > 0 && viewMode === 'list' && (
            <div className="table-wrap" role="grid" aria-label="파일 목록">
              <div className={`table-head ${showSourceColumn ? 'with-location' : ''}`} role="row">
                <span role="columnheader" />
                <span role="columnheader">이름</span>
                <span role="columnheader">형식</span>
                <span role="columnheader">크기</span>
                <span role="columnheader">수정한 날짜</span>
                {showSourceColumn && <span role="columnheader">위치</span>}
              </div>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleEntryDragEnd} onDragStart={(event) => setActiveDragId(String(event.active.id))}>
                <SortableContext items={visibleRootEntries.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
                  <ul className="table-body" role="rowgroup" onClick={(e) => {
                    if (e.target === e.currentTarget) {
                      cancelInlineRename()
                      setSelectedEntryIds([])
                      lastClickedIndexRef.current = -1
                    }
                  }}
                  onContextMenu={(e) => {
                    if (e.target === e.currentTarget) {
                      handleContentContextMenu(e)
                    }
                  }}>
                    {visibleEntryRows.map((row) => {
                      if (!row.entry) {
                        return (
                          <li
                            key={row.key}
                            className="table-row table-child-row"
                            role="presentation"
                            style={{ paddingLeft: `${22 + row.depth * 16}px` }}
                          >
                            <span>{row.placeholder === 'loading' ? '하위 항목 로딩 중...' : '하위 항목 없음'}</span>
                          </li>
                        )
                      }

                      const entry = row.entry
                      const folderToggleState = getRightPanelFolderToggleState(entry)
                      return (
                        <SortableEntryRow
                          key={row.key}
                          entry={entry}
                          selected={selectedEntryIdSet.has(entry.id)}
                          manualMode={orderMode === 'manual'}
                          sortable={row.depth === 0}
                          depth={row.depth}
                          dragPaths={selectedPaths}
                          isCut={cutPathSet.has(entry.path)}
                          isInlineRenaming={inlineRenameId === entry.id}
                          inlineRenameValue={inlineRenameValue}
                          inlineRenameInputRef={inlineRenameInputRef}
                          onSelect={handleEntrySelect}
                          sourceFolderHint={sourceFolderByEntryId.get(entry.id) ?? null}
                          onOpen={(item) => void openEntry(item)}
                          onDropEntries={(paths, destinationPath, copyMode) =>
                            handleDroppedPaths(paths, destinationPath, copyMode ? 'copy' : 'move')
                          }
                          onStartNativeDrag={tryStartNativeFileDrag}
                          canExpand={folderToggleState.canExpand}
                          isExpanded={folderToggleState.isExpanded}
                          isLoadingChildren={folderToggleState.isLoadingChildren}
                          onToggleExpand={toggleRightPanelFolderExpansion}
                          onInlineRenameChange={setInlineRenameValue}
                          onInlineRenameCommit={() => void commitInlineRename()}
                          onInlineRenameCancel={cancelInlineRename}
                          onContextMenu={handleContextMenu}
                          showSourceColumn={showSourceColumn}
                        />
                      )
                    })}
                  </ul>
                </SortableContext>
                <DragOverlay>
                  {activeDragId ? (
                    <div style={{ padding: '8px 12px', background: '#fff', border: '1px solid var(--accent)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', fontSize: 14 }}>
                      {entryById.get(activeDragId)?.name}
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
              {hasMoreEntries && (
                <div className="load-more-wrap">
                  <button className="win-btn load-more-btn" onClick={handleLoadMoreEntries}>
                    항목 더 보기 (+{Math.min(ENTRY_PAGE_SIZE, baseDisplayEntries.length - visibleRootEntries.length)})
                  </button>
                </div>
              )}
            </div>
          )}

          {!previewLoading && baseDisplayEntries.length > 0 && viewMode === 'gallery' && (
            <>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleEntryDragEnd}
                onDragStart={(event) => setActiveDragId(String(event.active.id))}
              >
                <SortableContext items={visibleRootEntries.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
                  <div
                    className="gallery-wrap"
                    onClick={(e) => {
                      if (e.target === e.currentTarget) {
                        cancelInlineRename()
                        setSelectedEntryIds([])
                        lastClickedIndexRef.current = -1
                      }
                    }}
                    onContextMenu={(e) => {
                      if (e.target === e.currentTarget) {
                        handleContentContextMenu(e)
                      }
                    }}
                  >
                    {visibleRootEntries.map((entry) => (
                      <SortableGalleryCard
                        key={entry.id}
                        entry={entry}
                        selected={selectedEntryIdSet.has(entry.id)}
                        manualMode={orderMode === 'manual'}
                        dragPaths={selectedPaths}
                        isCut={cutPathSet.has(entry.path)}
                        isInlineRenaming={inlineRenameId === entry.id}
                        inlineRenameValue={inlineRenameValue}
                        inlineRenameInputRef={inlineRenameInputRef}
                        onSelect={handleEntrySelect}
                        sourceFolderHint={sourceFolderByEntryId.get(entry.id) ?? null}
                        onOpen={(item) => void openEntry(item)}
                        onDropEntries={(paths, destinationPath, copyMode) =>
                          handleDroppedPaths(paths, destinationPath, copyMode ? 'copy' : 'move')
                        }
                        onStartNativeDrag={tryStartNativeFileDrag}
                        onStartInlineRename={beginInlineRename}
                        onInlineRenameChange={setInlineRenameValue}
                        onInlineRenameCommit={() => void commitInlineRename()}
                        onInlineRenameCancel={cancelInlineRename}
                        onContextMenu={handleContextMenu}
                        showSourceColumn={showSourceColumn}
                      />
                    ))}
                  </div>
                </SortableContext>
                <DragOverlay>
                  {activeDragId ? (
                    <div style={{ padding: '8px 12px', background: '#fff', border: '1px solid var(--accent)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', fontSize: 14 }}>
                      {entryById.get(activeDragId)?.name}
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
              {hasMoreEntries && (
                <div className="load-more-wrap">
                  <button className="win-btn load-more-btn" onClick={handleLoadMoreEntries}>
                    항목 더 보기 (+{Math.min(ENTRY_PAGE_SIZE, baseDisplayEntries.length - visibleRootEntries.length)})
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </main>

      {(toastState || undoToastMessage) && (
        <div className="toast-stack">
          {toastState && (
            <div className={`toast ${toastState.tone}-toast`} role={toastState.role} aria-live={toastState.ariaLive} aria-atomic="true">
              <span className="toast-icon" aria-hidden="true">
                {toastState.tone === 'error' ? (
                  <AlertCircle size={16} />
                ) : toastState.tone === 'success' ? (
                  <CheckCircle2 size={16} />
                ) : toastState.inProgress ? (
                  <RefreshCcw size={16} className="toast-spin" />
                ) : (
                  <Info size={16} />
                )}
              </span>
              <div className="toast-content">
                <strong className="toast-title">{toastState.title}</strong>
                <span className="toast-message">{toastState.message}</span>
              </div>
            </div>
          )}

          {undoToastMessage && (
            <div className="toast info-toast undo-toast" role="status" aria-live="polite" aria-atomic="true">
              <span className="toast-icon" aria-hidden="true">
                <Undo2 size={16} />
              </span>
              <div className="toast-content">
                <strong className="toast-title">실행 취소 가능</strong>
                <span className="toast-message">{undoToastMessage}</span>
                <span className="toast-shortcut">단축키: Ctrl+Z</span>
              </div>
              <button type="button" className="undo-toast-btn" onClick={() => void undoLastAction()}>
                실행 취소
              </button>
            </div>
          )}
        </div>
      )}

      <PdfViewer
        open={pdfModalOpen}
        file={selectedFile}
        currentDir={previewPath || currentPath}
        onClose={() => setPdfModalOpen(false)}
        onExtracted={() => {
          if (currentPath) {
            void loadFolders(currentPath)
          }
          const targetPreview = previewPath || currentPath
          if (targetPreview) {
            void loadPreviewEntries(targetPreview, { preserveExpandedState: true })
          }
        }}
        onRenamed={(oldPath: string, newPath: string) => {
          setSelectedEntryIds((prev) => prev.map((id) => (id === oldPath ? newPath : id)))
          const targetPreview = previewPath || currentPath
          if (targetPreview) {
            void loadPreviewEntries(targetPreview, { preserveExpandedState: true })
          }
        }}
      />

      <PdfMergeModal
        open={mergePdfModalOpen}
        pdfFiles={previewPdfFiles}
        currentDir={previewPath || currentPath}
        onClose={() => setMergePdfModalOpen(false)}
        onMerged={() => {
          const targetPreview = previewPath || currentPath
          if (targetPreview) {
            void loadPreviewEntries(targetPreview, { preserveExpandedState: true })
          }
        }}
      />

      <FileNameModal
        open={renameModalOpen}
        title="이름 바꾸기"
        defaultName={renameTarget?.name ?? ''}
        preserveExtension={renameTarget?.kind === 'file'}
        onConfirm={(name) => void handleRenameConfirm(name)}
        onCancel={() => { setRenameModalOpen(false); setRenameTarget(null) }}
      />

      <FileNameModal
        open={createFolderModalOpen}
        title="새 폴더"
        defaultName="새 폴더"
        onConfirm={(name) => void handleCreateFolderConfirm(name)}
        onCancel={() => setCreateFolderModalOpen(false)}
      />

      <ContextMenu
        open={contextMenu !== null}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        items={contextMenuItems}
        onClose={() => setContextMenu(null)}
      />
    </div>
  )
}
