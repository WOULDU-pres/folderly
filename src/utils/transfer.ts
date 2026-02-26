export type PasteSelectionEntry = {
  kind: 'folder' | 'file'
  path: string
}

export type PasteTargetResolution =
  | { ok: true; destinationPath: string }
  | { ok: false; reason: string }

export function resolvePasteTarget(
  selectedEntries: PasteSelectionEntry[],
  previewPath: string,
  currentPath: string,
): PasteTargetResolution {
  const folderTargets = Array.from(
    new Set(
      selectedEntries
        .filter((entry) => entry.kind === 'folder')
        .map((entry) => entry.path)
        .filter((path) => path.length > 0),
    ),
  )

  if (folderTargets.length > 1) {
    return {
      ok: false,
      reason: '여러 폴더가 선택되어 붙여넣기 대상을 결정할 수 없습니다. 폴더를 하나만 선택하세요.',
    }
  }

  if (folderTargets.length === 1) {
    return { ok: true, destinationPath: folderTargets[0] }
  }

  const fallback = previewPath || currentPath
  if (!fallback) {
    return {
      ok: false,
      reason: '붙여넣기 대상 폴더를 찾을 수 없습니다.',
    }
  }

  return { ok: true, destinationPath: fallback }
}
