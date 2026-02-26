export type PasteTargetSource = 'selected-folder' | 'preview-path' | 'current-path' | 'none'

export interface PasteTargetResolution {
  source: PasteTargetSource
  targetPath: string | null
  error: string | null
}

interface ResolvePasteTargetInput {
  selectedFolderTargets: string[]
  previewPath: string
  currentPath: string
}

function normalizePaths(paths: string[]): string[] {
  const deduped: string[] = []

  for (const path of paths) {
    const trimmed = path.trim()
    if (!trimmed) continue
    if (!deduped.includes(trimmed)) {
      deduped.push(trimmed)
    }
  }

  return deduped
}

export function resolvePasteTarget({
  selectedFolderTargets,
  previewPath,
  currentPath,
}: ResolvePasteTargetInput): PasteTargetResolution {
  const normalizedFolderTargets = normalizePaths(selectedFolderTargets)

  if (normalizedFolderTargets.length > 1) {
    return {
      source: 'none',
      targetPath: null,
      error: '여러 폴더가 선택되어 붙여넣기 대상이 모호합니다. 폴더를 1개만 선택하세요.',
    }
  }

  if (normalizedFolderTargets.length === 1) {
    return {
      source: 'selected-folder',
      targetPath: normalizedFolderTargets[0],
      error: null,
    }
  }

  const normalizedPreviewPath = previewPath.trim()
  if (normalizedPreviewPath) {
    return {
      source: 'preview-path',
      targetPath: normalizedPreviewPath,
      error: null,
    }
  }

  const normalizedCurrentPath = currentPath.trim()
  if (normalizedCurrentPath) {
    return {
      source: 'current-path',
      targetPath: normalizedCurrentPath,
      error: null,
    }
  }

  return {
    source: 'none',
    targetPath: null,
    error: '붙여넣기 대상 폴더를 찾을 수 없습니다.',
  }
}
