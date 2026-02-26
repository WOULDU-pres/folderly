export type SortMode = 'name' | 'modifiedAt' | 'size'
export type ViewMode = 'gallery' | 'list'
export type OrderMode = 'auto' | 'manual'

export interface DriveItem {
  id: string
  label: string
  path: string
}

export interface FolderItem {
  id: string
  name: string
  path: string
  modifiedAt: number
  isHidden: boolean
}

export interface FileItem {
  id: string
  name: string
  path: string
  ext: string
  size: number
  modifiedAt: number
  isHidden: boolean
}

export interface ExtractResult {
  outputPath: string
  pageCount: number
  warnings: string[]
}

export interface ExtractAndRemoveResult {
  extractedPath: string
  extractedCount: number
  remainingPath: string
  remainingCount: number
  warnings: string[]
}

export interface MergeSource {
  path: string
  pages: number[]
}

export interface MergeResult {
  outputPath: string
  totalPages: number
  warnings: string[]
}

export interface BookmarkItem {
  id: string
  name: string
  path: string
}
