import { describe, expect, it, vi } from 'vitest'
import {
  encodeFileSrcUrl,
  getFileDirectory,
  isSameOrDescendantPath,
  normalizePathForComparison,
  toCustomNamePdfPath,
  toMergedPdfPath,
  toOutputPdfPath,
} from './path'

describe('path utils edge cases', () => {
  it('resolves directory for root-level unix and windows file paths', () => {
    expect(getFileDirectory('/report.pdf')).toBe('/')
    expect(getFileDirectory('C:\\report.pdf')).toBe('C:\\')
  })

  it('handles windows verbatim prefix paths', () => {
    expect(getFileDirectory('\\\\?\\C:\\Users\\한글\\report.pdf')).toBe('C:\\Users\\한글')
  })

  it('joins output paths without duplicate separators and keeps pdf extension case-insensitively', () => {
    expect(toCustomNamePdfPath('/tmp/', 'summary')).toBe('/tmp/summary.pdf')
    expect(toCustomNamePdfPath('C:\\', 'draft.PDF')).toBe('C:\\draft.PDF')
  })

  it('sanitizes custom PDF names with separators or empty input', () => {
    expect(toCustomNamePdfPath('/tmp', 'report/2026')).toBe('/tmp/report_2026.pdf')
    expect(toCustomNamePdfPath('/tmp', '  ')).toBe('/tmp/output.pdf')
  })

  it('builds output and merged pdf paths for root directories', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-26T12:34:56.789Z'))

    expect(toOutputPdfPath('/report.pdf')).toBe('/report_selected_2026-02-26T12-34-56-789Z.pdf')
    expect(toMergedPdfPath('/')).toBe('/merged_2026-02-26T12-34-56-789Z.pdf')

    vi.useRealTimers()
  })
})

describe('encodeFileSrcUrl', () => {
  it('encodes special characters that could break URL parsing', () => {
    const encoded = encodeFileSrcUrl('asset://localhost/C:/Users/A&B #1?.png')
    expect(encoded).toContain('%23')
    expect(encoded).toContain('%3F')
    expect(encoded).not.toContain('#1?.png')
  })

  it('keeps already encoded file source URLs intact', () => {
    const url = 'asset://localhost/C%3A%5CUsers%5C%ED%95%9C%EA%B8%80%20%23sample.png'
    expect(encodeFileSrcUrl(url)).toBe(url)
  })
})

describe('path comparison helpers', () => {
  it('normalizes windows and WSL paths consistently for safety checks', () => {
    expect(normalizePathForComparison('C:\\Users\\Alice\\Docs\\')).toBe('c:/users/alice/docs')
    expect(normalizePathForComparison('/mnt/C/Users/Alice/Docs')).toBe('/mnt/c/users/alice/docs')
  })

  it('detects same or descendant destination paths', () => {
    expect(isSameOrDescendantPath('/tmp/source', '/tmp/source')).toBe(true)
    expect(isSameOrDescendantPath('/tmp/source', '/tmp/source/child')).toBe(true)
    expect(isSameOrDescendantPath('/tmp/source', '/tmp/other')).toBe(false)
  })

  it('treats windows paths case-insensitively for descendant detection', () => {
    expect(isSameOrDescendantPath('C:\\Work\\Data', 'c:\\work\\data\\child')).toBe(true)
    expect(isSameOrDescendantPath('C:\\Work\\Data', 'C:\\Work\\Other')).toBe(false)
  })
})
