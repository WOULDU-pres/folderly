import { describe, expect, it } from 'vitest'
import { isUndoShortcut, shouldHandleExplorerUndoShortcut } from './undoShortcut'

describe('undo shortcut helpers', () => {
  it('recognizes Ctrl/Cmd + Z as undo shortcut', () => {
    expect(isUndoShortcut({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(true)
    expect(isUndoShortcut({ key: 'Z', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })).toBe(true)
  })

  it('rejects undo when modifier combination is not supported', () => {
    expect(isUndoShortcut({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe(false)
    expect(isUndoShortcut({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: true })).toBe(false)
    expect(isUndoShortcut({ key: 'x', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false)
  })

  it('disables explorer-level undo while PDF modal is open', () => {
    const event = { key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
    expect(shouldHandleExplorerUndoShortcut(event, { pdfModalOpen: true })).toBe(false)
    expect(shouldHandleExplorerUndoShortcut(event, { pdfModalOpen: false })).toBe(true)
  })
})
