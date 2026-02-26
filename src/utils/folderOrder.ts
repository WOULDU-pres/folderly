import { FileItem, FolderItem, SortMode } from '../types'

type SortableItem = {
  id: string
  name: string
  modifiedAt: number
  size?: number
}

const DIGIT_SEGMENT = /^\d+$/

function normalizeNumericSegment(segment: string): string {
  const normalized = segment.replace(/^0+/, '')
  return normalized.length > 0 ? normalized : '0'
}

function compareNameNaturally(leftName: string, rightName: string): number {
  const leftSegments = leftName.match(/\d+|\D+/g) ?? [leftName]
  const rightSegments = rightName.match(/\d+|\D+/g) ?? [rightName]
  const segmentCount = Math.max(leftSegments.length, rightSegments.length)

  for (let i = 0; i < segmentCount; i += 1) {
    const left = leftSegments[i]
    const right = rightSegments[i]

    if (left === undefined) return -1
    if (right === undefined) return 1

    const bothNumeric = DIGIT_SEGMENT.test(left) && DIGIT_SEGMENT.test(right)
    if (bothNumeric) {
      const normalizedLeft = normalizeNumericSegment(left)
      const normalizedRight = normalizeNumericSegment(right)

      if (normalizedLeft.length !== normalizedRight.length) {
        return normalizedLeft.length - normalizedRight.length
      }

      if (normalizedLeft !== normalizedRight) {
        return normalizedLeft.localeCompare(normalizedRight)
      }

      if (left.length !== right.length) {
        return left.length - right.length
      }

      continue
    }

    const segmentDiff = left.localeCompare(right)
    if (segmentDiff !== 0) {
      return segmentDiff
    }
  }

  return leftName.localeCompare(rightName)
}

function sortByMode<T extends SortableItem>(items: T[], mode: SortMode): T[] {
  const copied = [...items]
  if (mode === 'name') {
    return copied.sort((a, b) => compareNameNaturally(a.name, b.name))
  }
  if (mode === 'size') {
    return copied.sort((a, b) => {
      const sizeDiff = (b.size ?? -1) - (a.size ?? -1)
      return sizeDiff !== 0 ? sizeDiff : compareNameNaturally(a.name, b.name)
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
