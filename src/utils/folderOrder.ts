import { FileItem, FolderItem, SortMode } from '../types'

type SortableItem = {
  id: string
  name: string
  modifiedAt: number
}

function sortByMode<T extends SortableItem>(items: T[], mode: SortMode): T[] {
  const copied = [...items]
  if (mode === 'name') {
    return copied.sort((a, b) => a.name.localeCompare(b.name))
  }
  return copied.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export function sortFolders(items: FolderItem[], mode: SortMode): FolderItem[] {
  return sortByMode(items, mode)
}

export function sortFiles(items: FileItem[], mode: SortMode): FileItem[] {
  return sortByMode(items, mode)
}

export function mergeManualOrder<T extends { id: string }>(items: T[], manualIds: string[]): T[] {
  const map = new Map(items.map((item) => [item.id, item]))
  const ordered: T[] = []

  for (const id of manualIds) {
    const item = map.get(id)
    if (item) {
      ordered.push(item)
      map.delete(id)
    }
  }

  return [...ordered, ...Array.from(map.values())]
}
