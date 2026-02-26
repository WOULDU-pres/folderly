import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
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
  ArrowUp,
  BookmarkPlus,
  Copy,
  File,
  FileText,
  Folder,
  FolderPlus,
  Grid2x2,
  GripVertical,
  FolderDown,
  HardDrive,
  List,
  Monitor,
  Pencil,
  RefreshCcw,
  Scissors,
  Trash2,
  ClipboardPaste,
  X,
} from 'lucide-react'

import { PdfViewer } from './components/PdfViewer'
import { PdfMergeModal } from './components/PdfMergeModal'
import { BookmarkItem, DriveItem, FileItem, FolderItem, OrderMode, SortMode, ViewMode } from './types'
import { mergeManualOrder, sortFiles, sortFolders } from './utils/folderOrder'
import { extLabel, formatBytes, formatDate } from './utils/format'

const BOOKMARK_STORAGE_KEY = 'explorer.bookmarks.v1'
const ENTRY_DRAG_MIME = 'application/x-windows-explorer-paths'

type ExplorerEntry = ({ kind: 'folder' } & FolderItem) | ({ kind: 'file' } & FileItem)
type ClipboardState = { mode: 'copy' | 'cut'; paths: string[] } | null

type SortableFolderRowProps = {
  folder: FolderItem
  selected: boolean
  manualMode: boolean
  onClick: (folder: FolderItem) => void
  onDoubleClick: (folder: FolderItem) => void
  onDropEntries: (paths: string[], destinationPath: string, copyMode: boolean) => void
}

function writeDragPayload(event: ReactDragEvent, paths: string[]) {
  const payload = JSON.stringify(paths)
  event.dataTransfer.setData(ENTRY_DRAG_MIME, payload)
  event.dataTransfer.setData('text/plain', payload)
  event.dataTransfer.effectAllowed = 'copyMove'
}

function readDragPayload(event: ReactDragEvent): string[] {
  const payload = event.dataTransfer.getData(ENTRY_DRAG_MIME) || event.dataTransfer.getData('text/plain')
  if (!payload) return []

  try {
    const parsed = JSON.parse(payload)
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
    }
  } catch {
    return []
  }

  return []
}

function SortableFolderRow({
  folder,
  selected,
  manualMode,
  onClick,
  onDoubleClick,
  onDropEntries,
}: SortableFolderRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({
    id: folder.id,
    disabled: !manualMode,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`sidebar-row ${selected ? 'selected' : ''} ${folder.isHidden ? 'hidden-entry' : ''}`}
      onClick={() => onClick(folder)}
      onDoubleClick={() => onDoubleClick(folder)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const paths = readDragPayload(event)
        if (!paths.length) return
        onDropEntries(paths, folder.path, event.ctrlKey || event.metaKey)
      }}
    >
      <button
        ref={setActivatorNodeRef}
        className={`drag-handle ${manualMode ? '' : 'hidden'}`}
        disabled={!manualMode}
        aria-label={`Drag to reorder ${folder.name}`}
        {...listeners}
        {...attributes}
      >
        <GripVertical size={16} />
      </button>
      <Folder size={16} />
      <span>{folder.name}</span>
    </li>
  )
}

type SelectModifiers = { ctrl: boolean; shift: boolean }

type SortableEntryRowProps = {
  entry: ExplorerEntry
  selected: boolean
  manualMode: boolean
  dragPaths: string[]
  isCut: boolean
  onSelect: (entry: ExplorerEntry, modifiers: SelectModifiers) => void
  onOpen: (entry: ExplorerEntry) => void
  onDropEntries: (paths: string[], destinationPath: string, copyMode: boolean) => void
}

function SortableEntryRow({ entry, selected, manualMode, dragPaths, isCut, onSelect, onOpen, onDropEntries }: SortableEntryRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({
    id: entry.id,
    disabled: !manualMode,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`table-row ${selected ? 'selected' : ''} ${entry.isHidden ? 'hidden-entry' : ''} ${isCut ? 'cut-entry' : ''}`}
      draggable={!manualMode}
      onDragStart={(event) => writeDragPayload(event, selected && dragPaths.length > 0 ? dragPaths : [entry.path])}
      onDragOver={(event) => {
        if (entry.kind === 'folder') {
          event.preventDefault()
        }
      }}
      onDrop={(event) => {
        if (entry.kind !== 'folder') return
        event.preventDefault()
        const paths = readDragPayload(event)
        if (!paths.length) return
        onDropEntries(paths, entry.path, event.ctrlKey || event.metaKey)
      }}
      onClick={(e) => onSelect(entry, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
      onDoubleClick={() => onOpen(entry)}
    >
      <span>
        <button
          ref={setActivatorNodeRef}
          className={`file-drag-handle ${manualMode ? '' : 'hidden'}`}
          disabled={!manualMode}
          aria-label={`Drag to reorder ${entry.name}`}
          {...listeners}
          {...attributes}
        >
          <GripVertical size={14} />
        </button>
      </span>
      <span className="name-cell">
        {entry.kind === 'folder' ? <Folder size={16} /> : entry.ext === 'pdf' ? <FileText size={16} /> : <File size={16} />}
        {entry.name}
      </span>
      <span>{entry.kind === 'folder' ? '폴더' : extLabel(entry.ext)}</span>
      <span>{entry.kind === 'folder' ? '-' : formatBytes(entry.size)}</span>
      <span>{formatDate(entry.modifiedAt)}</span>
    </li>
  )
}

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

export default function App() {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const clickTimerRef = useRef<number | null>(null)
  const operationToastTimerRef = useRef<number | null>(null)

  const [currentPath, setCurrentPath] = useState('')
  const [previewPath, setPreviewPath] = useState('')
  const [drives, setDrives] = useState<DriveItem[]>([])
  const [quickAccess, setQuickAccess] = useState<DriveItem[]>([])
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([])

  const [folders, setFolders] = useState<FolderItem[]>([])
  const [previewFolders, setPreviewFolders] = useState<FolderItem[]>([])
  const [previewFiles, setPreviewFiles] = useState<FileItem[]>([])

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([])
  const lastClickedIndexRef = useRef<number>(-1)
  const [clipboard, setClipboard] = useState<ClipboardState>(null)

  const [sortMode, setSortMode] = useState<SortMode>('name')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [orderMode, setOrderMode] = useState<OrderMode>('auto')
  const [folderManualOrderIds, setFolderManualOrderIds] = useState<string[]>([])
  const [entryManualOrderIds, setEntryManualOrderIds] = useState<string[]>([])

  const [folderLoading, setFolderLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [operationInProgress, setOperationInProgress] = useState(false)
  const [operationStatus, setOperationStatus] = useState<string | null>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [actionInProgress, setActionInProgress] = useState(false)

  const [pdfModalOpen, setPdfModalOpen] = useState(false)
  const [mergePdfModalOpen, setMergePdfModalOpen] = useState(false)

  const sortedFolders = useMemo(() => sortFolders(folders, sortMode), [folders, sortMode])
  const displayFolders = useMemo(
    () => (orderMode === 'manual' ? mergeManualOrder(sortedFolders, folderManualOrderIds) : sortedFolders),
    [sortedFolders, orderMode, folderManualOrderIds],
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

  const displayEntries = useMemo(
    () => (orderMode === 'manual' ? mergeManualOrder(autoSortedEntries, entryManualOrderIds) : autoSortedEntries),
    [autoSortedEntries, orderMode, entryManualOrderIds],
  )

  const selectedEntries = useMemo(
    () => displayEntries.filter((entry) => selectedEntryIds.includes(entry.id)),
    [displayEntries, selectedEntryIds],
  )

  const selectedPaths = useMemo(() => selectedEntries.map((e) => e.path), [selectedEntries])

  const lastSelectedEntry = useMemo(() => {
    if (selectedEntryIds.length === 0) return null
    const lastId = selectedEntryIds[selectedEntryIds.length - 1]
    return displayEntries.find((entry) => entry.id === lastId) ?? null
  }, [displayEntries, selectedEntryIds])

  const selectedFile = lastSelectedEntry?.kind === 'file' ? lastSelectedEntry : null

  const cutPathSet = useMemo(
    () => new Set(clipboard?.mode === 'cut' ? clipboard.paths : []),
    [clipboard],
  )

  const resolveErrorMessage = (errorValue: unknown, fallback: string) => {
    if (errorValue instanceof Error && errorValue.message) return errorValue.message
    if (typeof errorValue === 'string' && errorValue) return errorValue
    if (typeof errorValue === 'object' && errorValue !== null && 'message' in errorValue) {
      const message = (errorValue as { message?: unknown }).message
      if (typeof message === 'string' && message) return message
    }
    return fallback
  }

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

  async function loadFolders(path: string) {
    setFolderLoading(true)
    setError(null)

    try {
      const result = await invoke<FolderItem[]>('list_folders', { parentPath: path })
      setFolders(result)
      setSelectedFolderId((prev) => (prev && result.some((folder) => folder.id === prev) ? prev : null))
    } catch (e) {
      setError(e instanceof Error ? e.message : '폴더를 불러오지 못했습니다.')
    } finally {
      setFolderLoading(false)
    }
  }

  async function loadPreviewEntries(path: string) {
    setPreviewLoading(true)
    setError(null)

    try {
      const [folderResult, fileResult] = await Promise.all([
        invoke<FolderItem[]>('list_folders', { parentPath: path }),
        invoke<FileItem[]>('list_files', { parentPath: path }),
      ])
      setPreviewFolders(folderResult)
      setPreviewFiles(fileResult)

      const idSet = new Set([...folderResult.map((entry) => entry.id), ...fileResult.map((entry) => entry.id)])
      setSelectedEntryIds((prev) => prev.filter((id) => idSet.has(id)))
    } catch (e) {
      setError(e instanceof Error ? e.message : '미리보기 항목을 불러오지 못했습니다.')
      setPreviewFolders([])
      setPreviewFiles([])
      setSelectedEntryIds([])
    } finally {
      setPreviewLoading(false)
    }
  }

  async function navigateToPath(path: string) {
    setCurrentPath(path)
    setPreviewPath(path)
    setSelectedFolderId(null)
    setSelectedEntryIds([])
    lastClickedIndexRef.current = -1
    await Promise.all([loadFolders(path), loadPreviewEntries(path)])
  }

  async function refreshExplorer() {
    await loadDrives()
    if (currentPath) {
      await loadFolders(currentPath)
    }

    const targetPreview = previewPath || currentPath
    if (targetPreview) {
      await loadPreviewEntries(targetPreview)
    }
  }

  async function applyPathOperation(
    paths: string[],
    destinationPath: string,
    mode: 'copy' | 'move',
  ): Promise<boolean> {
    if (operationInProgress) return false
    const normalized = paths.filter((path) => path && path !== destinationPath)
    if (!normalized.length) return false

    if (operationToastTimerRef.current) {
      window.clearTimeout(operationToastTimerRef.current)
      operationToastTimerRef.current = null
    }

    setOperationInProgress(true)
    setOperationStatus(mode === 'copy' ? '복사 중...' : '이동 중...')
    setError(null)

    try {
      if (mode === 'copy') {
        await invoke('copy_paths', { paths: normalized, destinationDir: destinationPath })
      } else {
        await invoke('move_paths', { paths: normalized, destinationDir: destinationPath })
      }
      await refreshExplorer()
      setOperationInProgress(false)
      setOperationStatus(mode === 'copy' ? '복사 완료' : '이동 완료')
      operationToastTimerRef.current = window.setTimeout(() => {
        setOperationStatus(null)
        operationToastTimerRef.current = null
      }, 3000)
      return true
    } catch (e) {
      setOperationInProgress(false)
      setOperationStatus(null)
      setError(resolveErrorMessage(e, `${mode === 'copy' ? '복사' : '이동'} 작업에 실패했습니다.`))
      return false
    }
  }

  async function pasteClipboard() {
    if (!clipboard || !previewPath || operationInProgress) return

    const completed = await applyPathOperation(
      clipboard.paths,
      previewPath,
      clipboard.mode === 'copy' ? 'copy' : 'move',
    )
    if (completed && clipboard.mode === 'cut') {
      setClipboard(null)
    }
  }

  async function renameSelected() {
    if (selectedEntryIds.length !== 1) return
    const entry = displayEntries.find((e) => e.id === selectedEntryIds[0])
    if (!entry) return
    const nextName = window.prompt('새 이름을 입력하세요', entry.name)
    if (!nextName || nextName.trim() === '' || nextName.trim() === entry.name) return
    if (actionInProgress) return
    setActionInProgress(true)

    try {
      const renamedPath = await invoke<string>('rename_path', { path: entry.path, newName: nextName.trim() })
      setSelectedEntryIds([renamedPath])
      await refreshExplorer()
    } catch (e) {
      setError(e instanceof Error ? e.message : '이름 변경에 실패했습니다.')
    } finally {
      setActionInProgress(false)
    }
  }

  async function createNewFolder() {
    const targetPath = previewPath || currentPath
    if (!targetPath) return

    const nextName = window.prompt('새 폴더 이름', '새 폴더')
    if (!nextName || nextName.trim() === '') return
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
    const msg =
      selectedEntries.length === 1
        ? `선택한 항목을 삭제하시겠습니까?\n${names}`
        : `선택한 ${selectedEntries.length}개 항목을 삭제하시겠습니까?\n${names}`
    const confirmed = window.confirm(msg)
    if (!confirmed) return
    if (actionInProgress) return
    setActionInProgress(true)

    try {
      await invoke('delete_paths', { paths: selectedPaths })
      setSelectedEntryIds([])
      await refreshExplorer()
    } catch (e) {
      setError(e instanceof Error ? e.message : '삭제에 실패했습니다.')
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
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        return
      }

      const ctrlOrMeta = event.ctrlKey || event.metaKey

      if (ctrlOrMeta && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelectedEntryIds(displayEntries.map((e) => e.id))
        return
      }
      if (ctrlOrMeta && event.key.toLowerCase() === 'c' && selectedPaths.length > 0 && !operationInProgress) {
        event.preventDefault()
        setClipboard({ mode: 'copy', paths: [...selectedPaths] })
        return
      }
      if (ctrlOrMeta && event.key.toLowerCase() === 'x' && selectedPaths.length > 0 && !operationInProgress) {
        event.preventDefault()
        setClipboard({ mode: 'cut', paths: [...selectedPaths] })
        return
      }
      if (ctrlOrMeta && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        if (!operationInProgress) {
          void pasteClipboard()
        }
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
            ? displayEntries.findIndex((e) => e.id === selectedEntryIds[selectedEntryIds.length - 1])
            : -1
        const nextIndex = Math.min(currentIndex + 1, displayEntries.length - 1)
        if (nextIndex >= 0) {
          if (event.shiftKey) {
            const id = displayEntries[nextIndex].id
            setSelectedEntryIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
          } else {
            setSelectedEntryIds([displayEntries[nextIndex].id])
          }
          lastClickedIndexRef.current = nextIndex
        }
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const currentIndex =
          selectedEntryIds.length > 0
            ? displayEntries.findIndex((e) => e.id === selectedEntryIds[selectedEntryIds.length - 1])
            : displayEntries.length
        const prevIndex = Math.max(currentIndex - 1, 0)
        if (displayEntries.length > 0) {
          if (event.shiftKey) {
            const id = displayEntries[prevIndex].id
            setSelectedEntryIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
          } else {
            setSelectedEntryIds([displayEntries[prevIndex].id])
          }
          lastClickedIndexRef.current = prevIndex
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedEntries, selectedPaths, selectedEntryIds, lastSelectedEntry, displayEntries, previewPath, clipboard, operationInProgress])

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
    }
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined

    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return
        const target = previewPath || currentPath
        if (!target) return
        void applyPathOperation(event.payload.paths, target, 'copy')
      })
      .then((cleanup) => {
        unlisten = cleanup
      })
      .catch(() => {
        // no-op
      })

    return () => {
      if (unlisten) {
        unlisten()
      }
    }
  }, [previewPath, currentPath, operationInProgress])

  const handleSidebarFolderClick = (folder: FolderItem) => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current)
    }

    clickTimerRef.current = window.setTimeout(() => {
      setSelectedFolderId(folder.id)
      setPreviewPath(folder.path)
      void loadPreviewEntries(folder.path)
      clickTimerRef.current = null
    }, 200)
  }

  const handleSidebarFolderDoubleClick = (folder: FolderItem) => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }

    void navigateToPath(folder.path)
  }

  const handleEntrySelect = (entry: ExplorerEntry, modifiers: SelectModifiers) => {
    const entryIndex = displayEntries.findIndex((e) => e.id === entry.id)

    if (modifiers.shift && lastClickedIndexRef.current >= 0) {
      const start = Math.min(lastClickedIndexRef.current, entryIndex)
      const end = Math.max(lastClickedIndexRef.current, entryIndex)
      const rangeIds = displayEntries.slice(start, end + 1).map((e) => e.id)

      if (modifiers.ctrl) {
        setSelectedEntryIds((prev) => {
          const set = new Set(prev)
          rangeIds.forEach((id) => set.add(id))
          return Array.from(set)
        })
      } else {
        setSelectedEntryIds(rangeIds)
      }
    } else if (modifiers.ctrl) {
      setSelectedEntryIds((prev) =>
        prev.includes(entry.id) ? prev.filter((id) => id !== entry.id) : [...prev, entry.id],
      )
      lastClickedIndexRef.current = entryIndex
    } else {
      setSelectedEntryIds([entry.id])
      lastClickedIndexRef.current = entryIndex
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

    const oldIndex = displayEntries.findIndex((entry) => entry.id === active.id)
    const newIndex = displayEntries.findIndex((entry) => entry.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return

    const reordered = arrayMove(displayEntries, oldIndex, newIndex)
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
        <button className="win-btn" onClick={() => void handleGoParent()}>
          <ArrowUp size={16} /> 상위 폴더
        </button>
        <button className="win-btn" onClick={() => void handleRefresh()}>
          <RefreshCcw size={15} /> 새로 고침
        </button>

        <label className="win-field">
          정렬
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as SortMode)}
            disabled={orderMode === 'manual'}
          >
            <option value="name">이름</option>
            <option value="modifiedAt">수정일</option>
          </select>
        </label>

        <button className={`win-btn ${orderMode === 'manual' ? 'active' : ''}`} onClick={() => void handleOrderModeToggle()}>
          수동 정렬 {orderMode === 'manual' ? 'ON' : 'OFF'}
        </button>

        <button className="win-btn" onClick={handleAddBookmark}>
          <BookmarkPlus size={16} /> 북마크 고정
        </button>
        <button className="win-btn" disabled={actionInProgress} onClick={() => void createNewFolder()}>
          <FolderPlus size={16} /> 새 폴더
        </button>

        <div className="quick-actions">
          <button
            className="win-btn"
            disabled={operationInProgress || selectedEntries.length === 0}
            onClick={() => setClipboard({ mode: 'copy', paths: [...selectedPaths] })}
          >
            <Copy size={15} /> 복사
          </button>
          <button
            className="win-btn"
            disabled={operationInProgress || selectedEntries.length === 0}
            onClick={() => setClipboard({ mode: 'cut', paths: [...selectedPaths] })}
          >
            <Scissors size={15} /> 잘라내기
          </button>
          <button className="win-btn" disabled={operationInProgress || !clipboard} onClick={() => void pasteClipboard()}>
            <ClipboardPaste size={15} /> 붙여넣기
          </button>
          <button className="win-btn" disabled={selectedEntryIds.length !== 1 || actionInProgress} onClick={() => void renameSelected()}>
            <Pencil size={15} /> 이름 바꾸기(F2)
          </button>
          <button className="win-btn" disabled={selectedEntries.length === 0 || actionInProgress} onClick={() => void deleteSelected()}>
            <Trash2 size={15} /> 삭제
          </button>
        </div>

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

      <main className="explorer-layout">
        <aside className="sidebar">
          <div className="pane-title">드라이브</div>
          <ul className="drive-list">
            {drives.map((drive) => (
              <li key={drive.id}>
                <button
                  className={`drive-btn ${currentPath.startsWith(drive.path) ? 'active' : ''}`}
                  onClick={() => void navigateToPath(drive.path)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    const paths = readDragPayload(event)
                    if (!paths.length) return
                    void applyPathOperation(paths, drive.path, event.ctrlKey || event.metaKey ? 'copy' : 'move')
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
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFolderDragEnd} onDragStart={(event) => setActiveDragId(String(event.active.id))}>
              <SortableContext items={displayFolders.map((folder) => folder.id)} strategy={verticalListSortingStrategy}>
                <ul className="sidebar-list">
                  {displayFolders.map((folder) => (
                    <SortableFolderRow
                      key={folder.id}
                      folder={folder}
                      selected={selectedFolderId === folder.id}
                      manualMode={orderMode === 'manual'}
                      onClick={handleSidebarFolderClick}
                      onDoubleClick={handleSidebarFolderDoubleClick}
                      onDropEntries={(paths, destinationPath, copyMode) =>
                        void applyPathOperation(paths, destinationPath, copyMode ? 'copy' : 'move')
                      }
                    />
                  ))}
                </ul>
              </SortableContext>
              <DragOverlay>
                {activeDragId ? (
                  <div style={{ padding: '8px 12px', background: '#fff', border: '1px solid var(--accent)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Folder size={16} /> {folders.find((f) => f.id === activeDragId)?.name}
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </aside>

        <section className="content-pane">
          <div className="pane-head">
            <p style={{ margin: 0, color: 'var(--muted)' }}>
              {displayEntries.length}개 항목
              {selectedEntries.length > 0 && ` · ${selectedEntries.length}개 선택됨`}
              {clipboard && ` · 클립보드: ${clipboard.mode === 'copy' ? '복사' : '잘라내기'} ${clipboard.paths.length}개`}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="win-btn"
                style={{ borderColor: 'var(--border)' }}
                disabled={previewFiles.filter((f) => f.ext.toLowerCase() === 'pdf').length < 2}
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
            </div>
          </div>

          {previewLoading && <p className="state-text">항목 로딩 중...</p>}
          {!previewLoading && displayEntries.length === 0 && <p className="state-text">현재 폴더가 비어 있습니다.</p>}

          {!previewLoading && displayEntries.length > 0 && viewMode === 'list' && (
            <div className="table-wrap">
              <div className="table-head">
                <span />
                <span>이름</span>
                <span>형식</span>
                <span>크기</span>
                <span>수정한 날짜</span>
              </div>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleEntryDragEnd} onDragStart={(event) => setActiveDragId(String(event.active.id))}>
                <SortableContext items={displayEntries.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
                  <ul className="table-body" onClick={(e) => { if (e.target === e.currentTarget) { setSelectedEntryIds([]); lastClickedIndexRef.current = -1 } }}>
                    {displayEntries.map((entry) => (
                      <SortableEntryRow
                        key={entry.id}
                        entry={entry}
                        selected={selectedEntryIds.includes(entry.id)}
                        manualMode={orderMode === 'manual'}
                        dragPaths={selectedPaths}
                        isCut={cutPathSet.has(entry.path)}
                        onSelect={handleEntrySelect}
                        onOpen={(item) => void openEntry(item)}
                        onDropEntries={(paths, destinationPath, copyMode) =>
                          void applyPathOperation(paths, destinationPath, copyMode ? 'copy' : 'move')
                        }
                      />
                    ))}
                  </ul>
                </SortableContext>
                <DragOverlay>
                  {activeDragId ? (
                    <div style={{ padding: '8px 12px', background: '#fff', border: '1px solid var(--accent)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', fontSize: 14 }}>
                      {displayEntries.find((e) => e.id === activeDragId)?.name}
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </div>
          )}

          {!previewLoading && displayEntries.length > 0 && viewMode === 'gallery' && (
            <div className="gallery-wrap" onClick={(e) => { if (e.target === e.currentTarget) { setSelectedEntryIds([]); lastClickedIndexRef.current = -1 } }}>
              {displayEntries.map((entry) => (
                <button
                  key={entry.id}
                  className={`gallery-card ${selectedEntryIds.includes(entry.id) ? 'selected' : ''} ${entry.isHidden ? 'hidden-entry' : ''} ${cutPathSet.has(entry.path) ? 'cut-entry' : ''}`}
                  draggable={orderMode !== 'manual'}
                  onDragStart={(event) => writeDragPayload(event, selectedEntryIds.includes(entry.id) && selectedPaths.length > 0 ? selectedPaths : [entry.path])}
                  onDragOver={(event) => {
                    if (entry.kind === 'folder') {
                      event.preventDefault()
                    }
                  }}
                  onDrop={(event) => {
                    if (entry.kind !== 'folder') return
                    event.preventDefault()
                    const paths = readDragPayload(event)
                    if (!paths.length) return
                    void applyPathOperation(paths, entry.path, event.ctrlKey || event.metaKey ? 'copy' : 'move')
                  }}
                  onClick={(e) => handleEntrySelect(entry, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
                  onDoubleClick={() => void openEntry(entry)}
                >
                  <div className="gallery-thumb">
                    {entry.kind === 'folder' ? (
                      <Folder size={32} />
                    ) : isImage(entry.ext) ? (
                      <img src={convertFileSrc(entry.path)} alt={entry.name} loading="lazy" />
                    ) : entry.ext === 'pdf' ? (
                      <FileText size={32} />
                    ) : (
                      <File size={32} />
                    )}
                  </div>
                  <strong title={entry.name}>{entry.name}</strong>
                  <span>{entry.kind === 'folder' ? '폴더' : extLabel(entry.ext)}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </main>

      {(operationStatus || error) && <div className="error-toast">{error ?? operationStatus}</div>}

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
            void loadPreviewEntries(targetPreview)
          }
        }}
        onRenamed={(oldPath: string, newPath: string) => {
          setSelectedEntryIds((prev) => prev.map((id) => (id === oldPath ? newPath : id)))
          const targetPreview = previewPath || currentPath
          if (targetPreview) {
            void loadPreviewEntries(targetPreview)
          }
        }}
      />

      <PdfMergeModal
        open={mergePdfModalOpen}
        pdfFiles={previewFiles.filter((f) => f.ext.toLowerCase() === 'pdf')}
        currentDir={previewPath || currentPath}
        onClose={() => setMergePdfModalOpen(false)}
        onMerged={() => {
          const targetPreview = previewPath || currentPath
          if (targetPreview) {
            void loadPreviewEntries(targetPreview)
          }
        }}
      />
    </div>
  )
}
