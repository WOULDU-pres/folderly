import { describe, expect, it } from 'vitest'
import { FileItem, FolderItem } from '../types'
import { mergeManualOrder, sortFiles, sortFolders } from './folderOrder'

const sample: FolderItem[] = [
  { id: 'a', name: 'Beta', path: 'a', modifiedAt: 100, isHidden: false },
  { id: 'b', name: 'Alpha', path: 'b', modifiedAt: 300, isHidden: true },
  { id: 'c', name: 'Gamma', path: 'c', modifiedAt: 200, isHidden: false },
]

const fileSample: FileItem[] = [
  { id: 'f1', name: 'zeta.txt', path: 'f1', ext: 'txt', size: 1, modifiedAt: 10, isHidden: false },
  { id: 'f2', name: 'alpha.pdf', path: 'f2', ext: 'pdf', size: 2, modifiedAt: 40, isHidden: false },
  { id: 'f3', name: 'beta.jpg', path: 'f3', ext: 'jpg', size: 3, modifiedAt: 20, isHidden: true },
]

const numericFolderSample: FolderItem[] = [
  { id: 'n10', name: '10-folder', path: 'n10', modifiedAt: 1, isHidden: false },
  { id: 'n2', name: '2-folder', path: 'n2', modifiedAt: 1, isHidden: false },
  { id: 'n1', name: '1-folder', path: 'n1', modifiedAt: 1, isHidden: false },
  { id: 'n11', name: '11-folder', path: 'n11', modifiedAt: 1, isHidden: false },
  { id: 'n0', name: '0-folder', path: 'n0', modifiedAt: 1, isHidden: false },
]

const numericFileSample: FileItem[] = [
  { id: 'nf10', name: '10.pdf', path: 'nf10', ext: 'pdf', size: 10, modifiedAt: 10, isHidden: false },
  { id: 'nf2', name: '2.pdf', path: 'nf2', ext: 'pdf', size: 20, modifiedAt: 10, isHidden: false },
  { id: 'nf1', name: '1.pdf', path: 'nf1', ext: 'pdf', size: 30, modifiedAt: 10, isHidden: false },
  { id: 'nf11', name: '11.pdf', path: 'nf11', ext: 'pdf', size: 40, modifiedAt: 10, isHidden: false },
  { id: 'nf0', name: '0.pdf', path: 'nf0', ext: 'pdf', size: 50, modifiedAt: 10, isHidden: false },
]

describe('sortFolders', () => {
  it('sorts by name', () => {
    const sorted = sortFolders(sample, 'name')
    expect(sorted.map((folder) => folder.id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by modifiedAt desc', () => {
    const sorted = sortFolders(sample, 'modifiedAt')
    expect(sorted.map((folder) => folder.id)).toEqual(['b', 'c', 'a'])
  })

  it('falls back to name order for size mode', () => {
    const sorted = sortFolders(sample, 'size')
    expect(sorted.map((folder) => folder.id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts numeric-leading folder names in natural order', () => {
    const sorted = sortFolders(numericFolderSample, 'name')
    expect(sorted.map((folder) => folder.name)).toEqual([
      '0-folder',
      '1-folder',
      '2-folder',
      '10-folder',
      '11-folder',
    ])
  })
})

describe('mergeManualOrder', () => {
  it('applies manual ordering and appends unmapped folders', () => {
    const merged = mergeManualOrder(sample, ['c', 'a'])
    expect(merged.map((folder) => folder.id)).toEqual(['c', 'a', 'b'])
  })

  it('ignores unknown ids in manual ordering', () => {
    const merged = mergeManualOrder(sample, ['z', 'b'])
    expect(merged.map((folder) => folder.id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts files by mode and applies manual file order', () => {
    const byName = sortFiles(fileSample, 'name')
    expect(byName.map((file) => file.id)).toEqual(['f2', 'f3', 'f1'])

    const byDate = sortFiles(fileSample, 'modifiedAt')
    expect(byDate.map((file) => file.id)).toEqual(['f2', 'f3', 'f1'])

    const bySize = sortFiles(fileSample, 'size')
    expect(bySize.map((file) => file.id)).toEqual(['f3', 'f2', 'f1'])

    const manual = mergeManualOrder(byName, ['f1', 'f2'])
    expect(manual.map((file) => file.id)).toEqual(['f1', 'f2', 'f3'])
  })

  it('sorts numeric-leading file names in natural order', () => {
    const sorted = sortFiles(numericFileSample, 'name')
    expect(sorted.map((file) => file.name)).toEqual(['0.pdf', '1.pdf', '2.pdf', '10.pdf', '11.pdf'])
  })
})
