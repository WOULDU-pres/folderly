export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** power
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[power]}`
}

export function formatDate(timestamp: number): string {
  if (!timestamp) return '-'
  return new Date(timestamp * 1000).toLocaleString()
}

export function extLabel(ext: string): string {
  return ext ? ext.toUpperCase() : 'FILE'
}
