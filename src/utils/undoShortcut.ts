type UndoShortcutEvent = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export function isUndoShortcut(event: UndoShortcutEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey)
    && !event.shiftKey
    && !event.altKey
    && event.key.toLowerCase() === 'z'
  )
}

export function shouldHandleExplorerUndoShortcut(
  event: UndoShortcutEvent,
  options: { pdfModalOpen: boolean },
): boolean {
  if (!isUndoShortcut(event)) return false
  return !options.pdfModalOpen
}
