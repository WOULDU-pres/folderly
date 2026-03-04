export type HighlightUndoHistoryEntry = {
  id: string
  page: number
}

export function popLastHighlight<T extends { id: string }>(
  history: HighlightUndoHistoryEntry[],
  linesByPage: Record<number, T[]>,
): {
  removed: HighlightUndoHistoryEntry | null
  nextHistory: HighlightUndoHistoryEntry[]
  nextLinesByPage: Record<number, T[]>
} {
  const removed = history[history.length - 1] ?? null
  if (!removed) {
    return {
      removed: null,
      nextHistory: history,
      nextLinesByPage: linesByPage,
    }
  }

  const nextHistory = history.slice(0, -1)
  const pageLines = linesByPage[removed.page]

  if (!pageLines?.length) {
    return {
      removed,
      nextHistory,
      nextLinesByPage: linesByPage,
    }
  }

  let removeIndex = -1
  for (let index = pageLines.length - 1; index >= 0; index -= 1) {
    if (pageLines[index].id === removed.id) {
      removeIndex = index
      break
    }
  }

  if (removeIndex < 0) {
    return {
      removed,
      nextHistory,
      nextLinesByPage: linesByPage,
    }
  }

  const nextPageLines = [...pageLines.slice(0, removeIndex), ...pageLines.slice(removeIndex + 1)]

  if (nextPageLines.length === 0) {
    const { [removed.page]: _deleted, ...rest } = linesByPage
    return {
      removed,
      nextHistory,
      nextLinesByPage: rest,
    }
  }

  return {
    removed,
    nextHistory,
    nextLinesByPage: {
      ...linesByPage,
      [removed.page]: nextPageLines,
    },
  }
}
