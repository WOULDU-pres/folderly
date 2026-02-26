import { create } from 'zustand'
import { BookmarkItem, DriveItem, FileItem, FolderItem, OrderMode, SortMode, ViewMode } from '../types'

export type ExplorerEntry = ({ kind: 'folder' } & FolderItem) | ({ kind: 'file' } & FileItem)
export type ClipboardState = { mode: 'copy' | 'cut'; paths: string[] } | null
export type UndoMoveMapping = { fromPath: string; toPath: string }
export type UndoEntry =
  | { type: 'rename'; label: string; oldPath: string; newPath: string }
  | { type: 'move'; label: string; mappings: UndoMoveMapping[] }
  | { type: 'copy'; label: string; copiedPaths: string[] }
  | { type: 'delete'; label: string; deletedPaths: string[] }

const MAX_UNDO_STACK_SIZE = 50

interface NavigationSlice {
  currentPath: string
  previewPath: string
  drives: DriveItem[]
  quickAccess: DriveItem[]
  bookmarks: BookmarkItem[]
  folders: FolderItem[]
  previewFolders: FolderItem[]
  previewFiles: FileItem[]
}

interface SelectionSlice {
  selectedFolderId: string | null
  selectedEntryIds: string[]
  clipboard: ClipboardState
}

interface UISlice {
  viewMode: ViewMode
  sortMode: SortMode
  orderMode: OrderMode
  folderManualOrderIds: string[]
  entryManualOrderIds: string[]
  error: string | null
  operationInProgress: boolean
  operationStatus: string | null
  actionInProgress: boolean
}

interface UndoSlice {
  undoStack: UndoEntry[]
}

interface Actions {
  setCurrentPath: (path: string) => void
  setPreviewPath: (path: string) => void
  setDrives: (drives: DriveItem[]) => void
  setQuickAccess: (quickAccess: DriveItem[]) => void
  setBookmarks: (bookmarks: BookmarkItem[] | ((prev: BookmarkItem[]) => BookmarkItem[])) => void
  setFolders: (folders: FolderItem[]) => void
  setPreviewFolders: (folders: FolderItem[]) => void
  setPreviewFiles: (files: FileItem[]) => void
  setSelectedFolderId: (id: string | null | ((prev: string | null) => string | null)) => void
  setSelectedEntryIds: (ids: string[] | ((prev: string[]) => string[])) => void
  setClipboard: (clipboard: ClipboardState) => void
  setViewMode: (mode: ViewMode) => void
  setSortMode: (mode: SortMode) => void
  setOrderMode: (mode: OrderMode) => void
  setFolderManualOrderIds: (ids: string[]) => void
  setEntryManualOrderIds: (ids: string[]) => void
  setError: (error: string | null) => void
  setOperationInProgress: (inProgress: boolean) => void
  setOperationStatus: (status: string | null) => void
  setActionInProgress: (inProgress: boolean) => void
  pushUndoEntry: (entry: UndoEntry) => void
  popUndoEntry: () => UndoEntry | null
  clearUndoStack: () => void
}

export type ExplorerStore = NavigationSlice & SelectionSlice & UISlice & UndoSlice & Actions

export const useExplorerStore = create<ExplorerStore>((set, get) => ({
  // Navigation
  currentPath: '',
  previewPath: '',
  drives: [],
  quickAccess: [],
  bookmarks: [],
  folders: [],
  previewFolders: [],
  previewFiles: [],

  // Selection
  selectedFolderId: null,
  selectedEntryIds: [],
  clipboard: null,

  // UI
  viewMode: 'list',
  sortMode: 'name',
  orderMode: 'auto',
  folderManualOrderIds: [],
  entryManualOrderIds: [],
  error: null,
  operationInProgress: false,
  operationStatus: null,
  actionInProgress: false,
  undoStack: [],

  // Actions
  setCurrentPath: (path) => set({ currentPath: path }),
  setPreviewPath: (path) => set({ previewPath: path }),
  setDrives: (drives) => set({ drives }),
  setQuickAccess: (quickAccess) => set({ quickAccess }),
  setBookmarks: (bookmarks) =>
    set((state) => ({
      bookmarks: typeof bookmarks === 'function' ? bookmarks(state.bookmarks) : bookmarks,
    })),
  setFolders: (folders) => set({ folders }),
  setPreviewFolders: (folders) => set({ previewFolders: folders }),
  setPreviewFiles: (files) => set({ previewFiles: files }),
  setSelectedFolderId: (id) =>
    set((state) => ({
      selectedFolderId: typeof id === 'function' ? id(state.selectedFolderId) : id,
    })),
  setSelectedEntryIds: (ids) =>
    set((state) => ({
      selectedEntryIds: typeof ids === 'function' ? ids(state.selectedEntryIds) : ids,
    })),
  setClipboard: (clipboard) => set({ clipboard }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setSortMode: (mode) => set({ sortMode: mode }),
  setOrderMode: (mode) => set({ orderMode: mode }),
  setFolderManualOrderIds: (ids) => set({ folderManualOrderIds: ids }),
  setEntryManualOrderIds: (ids) => set({ entryManualOrderIds: ids }),
  setError: (error) => set({ error }),
  setOperationInProgress: (inProgress) => set({ operationInProgress: inProgress }),
  setOperationStatus: (status) => set({ operationStatus: status }),
  setActionInProgress: (inProgress) => set({ actionInProgress: inProgress }),
  pushUndoEntry: (entry) =>
    set((state) => {
      const nextStack = [...state.undoStack, entry]
      return {
        undoStack:
          nextStack.length > MAX_UNDO_STACK_SIZE
            ? nextStack.slice(nextStack.length - MAX_UNDO_STACK_SIZE)
            : nextStack,
      }
    }),
  popUndoEntry: () => {
    const stack = get().undoStack
    if (stack.length === 0) {
      return null
    }
    const entry = stack[stack.length - 1]
    set({ undoStack: stack.slice(0, -1) })
    return entry
  },
  clearUndoStack: () => set({ undoStack: [] }),
}))

// Selector hooks for performance
export const useCurrentPath = () => useExplorerStore((s) => s.currentPath)
export const usePreviewPath = () => useExplorerStore((s) => s.previewPath)
export const useDrives = () => useExplorerStore((s) => s.drives)
export const useQuickAccess = () => useExplorerStore((s) => s.quickAccess)
export const useBookmarks = () => useExplorerStore((s) => s.bookmarks)
export const useFolders = () => useExplorerStore((s) => s.folders)
export const usePreviewFolders = () => useExplorerStore((s) => s.previewFolders)
export const usePreviewFiles = () => useExplorerStore((s) => s.previewFiles)
export const useSelectedFolderId = () => useExplorerStore((s) => s.selectedFolderId)
export const useSelectedEntryIds = () => useExplorerStore((s) => s.selectedEntryIds)
export const useClipboard = () => useExplorerStore((s) => s.clipboard)
export const useViewMode = () => useExplorerStore((s) => s.viewMode)
export const useSortMode = () => useExplorerStore((s) => s.sortMode)
export const useOrderMode = () => useExplorerStore((s) => s.orderMode)
export const useFolderManualOrderIds = () => useExplorerStore((s) => s.folderManualOrderIds)
export const useEntryManualOrderIds = () => useExplorerStore((s) => s.entryManualOrderIds)
export const useError = () => useExplorerStore((s) => s.error)
export const useOperationInProgress = () => useExplorerStore((s) => s.operationInProgress)
export const useOperationStatus = () => useExplorerStore((s) => s.operationStatus)
export const useActionInProgress = () => useExplorerStore((s) => s.actionInProgress)
export const useUndoStack = () => useExplorerStore((s) => s.undoStack)
