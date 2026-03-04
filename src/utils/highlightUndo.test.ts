import { describe, expect, it } from 'vitest'
import { popLastHighlight, type HighlightUndoHistoryEntry } from './highlightUndo'

type TestLine = { id: string; page: number; text: string }

describe('highlight undo helpers', () => {
  it('keeps only the first marker after four draws and three undo operations', () => {
    const linesByPage: Record<number, TestLine[]> = {
      2: [
        { id: 'h1', page: 2, text: 'first' },
        { id: 'h2', page: 2, text: 'second' },
        { id: 'h3', page: 2, text: 'third' },
        { id: 'h4', page: 2, text: 'fourth' },
      ],
    }
    let history: HighlightUndoHistoryEntry[] = [
      { id: 'h1', page: 2 },
      { id: 'h2', page: 2 },
      { id: 'h3', page: 2 },
      { id: 'h4', page: 2 },
    ]
    let currentLines = linesByPage

    for (let i = 0; i < 3; i += 1) {
      const result = popLastHighlight(history, currentLines)
      history = result.nextHistory
      currentLines = result.nextLinesByPage
    }

    expect(history).toEqual([{ id: 'h1', page: 2 }])
    expect(currentLines[2]?.map((line) => line.id)).toEqual(['h1'])
  })

  it('returns unchanged state when history is empty', () => {
    const linesByPage: Record<number, TestLine[]> = {
      1: [{ id: 'h1', page: 1, text: 'line' }],
    }
    const result = popLastHighlight([], linesByPage)

    expect(result.removed).toBeNull()
    expect(result.nextHistory).toEqual([])
    expect(result.nextLinesByPage).toEqual(linesByPage)
  })
})
