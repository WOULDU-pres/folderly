import { describe, expect, it } from 'vitest'
import { resolvePasteTarget } from './transfer'

describe('resolvePasteTarget', () => {
  it('prefers a single selected folder target', () => {
    const resolved = resolvePasteTarget(
      [
        { kind: 'folder', path: '/root/target' },
        { kind: 'file', path: '/root/sample.txt' },
      ],
      '/root/preview',
      '/root/current',
    )

    expect(resolved).toEqual({ ok: true, destinationPath: '/root/target' })
  })

  it('blocks paste when multiple folder targets are selected', () => {
    const resolved = resolvePasteTarget(
      [
        { kind: 'folder', path: '/root/a' },
        { kind: 'folder', path: '/root/b' },
      ],
      '/root/preview',
      '/root/current',
    )

    expect(resolved.ok).toBe(false)
  })

  it('falls back to preview then current path', () => {
    expect(resolvePasteTarget([], '/root/preview', '/root/current')).toEqual({
      ok: true,
      destinationPath: '/root/preview',
    })

    expect(resolvePasteTarget([], '', '/root/current')).toEqual({
      ok: true,
      destinationPath: '/root/current',
    })
  })
})
