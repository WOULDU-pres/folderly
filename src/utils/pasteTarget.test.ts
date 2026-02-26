import { describe, expect, it } from 'vitest'

import { resolvePasteTarget } from './pasteTarget'

describe('resolvePasteTarget', () => {
  it('uses a single selected folder target first', () => {
    const result = resolvePasteTarget({
      selectedFolderTargets: ['C:/dest/folder'],
      previewPath: 'C:/preview',
      currentPath: 'C:/current',
    })

    expect(result).toEqual({
      source: 'selected-folder',
      targetPath: 'C:/dest/folder',
      error: null,
    })
  })

  it('deduplicates selected folder targets before resolving', () => {
    const result = resolvePasteTarget({
      selectedFolderTargets: ['C:/dest/folder', ' C:/dest/folder '],
      previewPath: 'C:/preview',
      currentPath: 'C:/current',
    })

    expect(result).toEqual({
      source: 'selected-folder',
      targetPath: 'C:/dest/folder',
      error: null,
    })
  })

  it('rejects multiple selected folder targets as ambiguous', () => {
    const result = resolvePasteTarget({
      selectedFolderTargets: ['C:/dest/a', 'C:/dest/b'],
      previewPath: 'C:/preview',
      currentPath: 'C:/current',
    })

    expect(result.source).toBe('none')
    expect(result.targetPath).toBeNull()
    expect(result.error).toContain('모호')
  })

  it('falls back to preview path when no selected folder target exists', () => {
    const result = resolvePasteTarget({
      selectedFolderTargets: [],
      previewPath: 'C:/preview',
      currentPath: 'C:/current',
    })

    expect(result).toEqual({
      source: 'preview-path',
      targetPath: 'C:/preview',
      error: null,
    })
  })

  it('falls back to current path when preview path is not available', () => {
    const result = resolvePasteTarget({
      selectedFolderTargets: [],
      previewPath: ' ',
      currentPath: 'C:/current',
    })

    expect(result).toEqual({
      source: 'current-path',
      targetPath: 'C:/current',
      error: null,
    })
  })

  it('returns an explicit error when no destination is available', () => {
    const result = resolvePasteTarget({
      selectedFolderTargets: [],
      previewPath: '',
      currentPath: '',
    })

    expect(result.source).toBe('none')
    expect(result.targetPath).toBeNull()
    expect(result.error).toContain('붙여넣기 대상')
  })
})
