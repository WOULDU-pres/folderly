export function getFileDirectory(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return path
  const dir = normalized.slice(0, index)
  return path.includes('\\') ? dir.replace(/\//g, '\\') : dir
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
  const sep = inputPath.includes('\\') ? '\\' : '/'
  return `${dir}${sep}${base}_selected_${stamp}.pdf`
}

export function toMergedPdfPath(directory: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sep = directory.includes('\\') ? '\\' : '/'
  return `${directory}${sep}merged_${stamp}.pdf`
}

export function toCustomNamePdfPath(directory: string, fileName: string): string {
  const sep = directory.includes('\\') ? '\\' : '/'
  const name = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`
  return `${directory}${sep}${name}`
}
