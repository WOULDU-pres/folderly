function isWindowsPath(path: string): boolean {
  return path.includes('\\') || /^[a-zA-Z]:/.test(path) || path.startsWith('\\\\')
}

function stripWindowsVerbatimPrefix(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  }
  if (path.startsWith('\\\\?\\')) {
    return path.slice('\\\\?\\'.length)
  }
  return path
}

function trimTrailingSeparator(path: string, sep: '/' | '\\'): string {
  if (!path) return path
  if (sep === '/') {
    return path === '/' ? path : path.replace(/\/+$/, '')
  }

  if (/^[a-zA-Z]:$/.test(path)) return `${path}\\`
  if (/^[a-zA-Z]:\\$/.test(path)) return path
  return path.replace(/\\+$/, '')
}

function joinPath(directory: string, fileName: string): string {
  const source = stripWindowsVerbatimPrefix(directory.trim())
  const windowsPath = isWindowsPath(source)
  const sep: '/' | '\\' = windowsPath ? '\\' : '/'

  const normalizedDirectory = windowsPath
    ? source.replace(/\//g, '\\')
    : source.replace(/\\/g, '/')
  const base = trimTrailingSeparator(normalizedDirectory, sep)

  if (!base) return fileName
  return base.endsWith(sep) ? `${base}${fileName}` : `${base}${sep}${fileName}`
}

export function getFileDirectory(path: string): string {
  const source = stripWindowsVerbatimPrefix(path)
  const windowsPath = isWindowsPath(source)
  const normalized = source.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')

  if (index < 0) return source
  if (index === 0) return windowsPath ? '\\' : '/'

  const dir = normalized.slice(0, index)
  if (!windowsPath) return dir

  if (/^[a-zA-Z]:$/.test(dir)) {
    return `${dir}\\`
  }

  return dir.replace(/\//g, '\\')
}

export function getFileNameWithoutExt(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const file = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dotIndex = file.lastIndexOf('.')
  if (dotIndex <= 0) return file
  return file.slice(0, dotIndex)
}

export function toOutputPdfPath(inputPath: string): string {
  const dir = getFileDirectory(inputPath)
  const base = getFileNameWithoutExt(inputPath)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return joinPath(dir, `${base}_selected_${stamp}.pdf`)
}

export function toMergedPdfPath(directory: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return joinPath(directory, `merged_${stamp}.pdf`)
}

export function toCustomNamePdfPath(directory: string, fileName: string): string {
  const trimmedName = fileName
    .trim()
    .replace(/[\\/]/g, '_')
    .replace(/\0/g, '')
    .trim()
  const safeName = trimmedName.length > 0 ? trimmedName : 'output'
  const name = /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`
  return joinPath(directory, name)
}

function encodePathSegment(segment: string): string {
  if (!segment) return segment
  try {
    return encodeURIComponent(decodeURIComponent(segment))
  } catch {
    return encodeURIComponent(segment)
  }
}

export function encodeFileSrcUrl(url: string): string {
  if (!url) return url

  try {
    const parsed = new URL(url)

    const normalizedPath = parsed.pathname
      .split('/')
      .map(encodePathSegment)
      .join('/')

    const normalizedSearch = parsed.search
      ? `%3F${encodePathSegment(parsed.search.slice(1))}`
      : ''
    const normalizedHash = parsed.hash
      ? `%23${encodePathSegment(parsed.hash.slice(1))}`
      : ''

    parsed.search = ''
    parsed.hash = ''
    parsed.pathname = `${normalizedPath}${normalizedSearch}${normalizedHash}`

    return parsed.toString()
  } catch {
    return url
  }
}
