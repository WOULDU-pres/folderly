import { FileItem, FolderItem, SortMode } from '../types'

type SortableItem = {
  id: string
  name: string
  modifiedAt: number
  size?: number
}

const NATURAL_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

function compareNameNaturally(leftName: string, rightName: string): number {
  const diff = NATURAL_NAME_COLLATOR.compare(leftName, rightName)
  if (diff !== 0) return diff
  return leftName.localeCompare(rightName)
}

function sortByMode<T extends SortableItem>(items: T[], mode: SortMode): T[] {
  const copied = [...items]
  if (mode === 'name') {
    return copied.sort((a, b) => compareNameNaturally(a.name, b.name))
  }
  if (mode === 'nameDesc') {
    return copied.sort((a, b) => compareNameNaturally(b.name, a.name))
  }
  if (mode === 'size') {
    return copied.sort((a, b) => {
      const sizeDiff = (b.size ?? -1) - (a.size ?? -1)
      return sizeDiff !== 0 ? sizeDiff : compareNameNaturally(a.name, b.name)
    })
  }
  if (mode === 'modifiedAtAsc') {
    return copied.sort((a, b) => {
      const modifiedDiff = a.modifiedAt - b.modifiedAt
      return modifiedDiff !== 0 ? modifiedDiff : compareNameNaturally(a.name, b.name)
    })
  }
  return copied.sort((a, b) => {
    const modifiedDiff = b.modifiedAt - a.modifiedAt
    return modifiedDiff !== 0 ? modifiedDiff : compareNameNaturally(a.name, b.name)
  })
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
