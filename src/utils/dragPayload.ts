export const ENTRY_DRAG_MIME = 'application/x-windows-explorer-paths'

export type EncodedDragPayload = {
  mimePayload: string
  plainPayload: string
  uriListPayload: string
}

export function normalizeDragPaths(paths: string[]): string[] {
  const deduped = new Set<string>()
  for (const value of paths) {
    const trimmed = value.trim()
    if (!trimmed) continue
    deduped.add(trimmed)
  }
  return Array.from(deduped)
}

function decodeFileUriPath(value: string): string {
  if (!value.toLowerCase().startsWith('file://')) {
    return value
  }

  try {
    const uri = new URL(value)
    const decodedPath = decodeURIComponent(uri.pathname)
    const normalizedLeadingSlash = decodedPath.replace(/^\/([A-Za-z]:[\\/])/, '$1')
    return normalizedLeadingSlash.replace(/\//g, '\\')
  } catch {
    return value
  }
}

function toFileUriPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`
  }

  return `file:///${encodeURI(normalized.replace(/^\/+/, ''))}`
}

export function encodeDragPayload(paths: string[]): EncodedDragPayload {
  const normalizedPaths = normalizeDragPaths(paths)
  return {
    mimePayload: JSON.stringify(normalizedPaths),
    plainPayload: normalizedPaths.join('\n'),
    uriListPayload: normalizedPaths.map(toFileUriPath).join('\n'),
  }
}

export function parseDragPayload(payload: string): string[] {
  const trimmedPayload = payload.trim()
  if (!trimmedPayload) return []

  try {
    const parsed = JSON.parse(trimmedPayload)
    if (Array.isArray(parsed)) {
      return normalizeDragPaths(parsed.filter((value): value is string => typeof value === 'string'))
    }
    if (typeof parsed === 'string') {
      return normalizeDragPaths([parsed])
    }
  } catch {
    // fallback below
  }

  const lines = trimmedPayload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map(decodeFileUriPath)

  return normalizeDragPaths(lines)
}
