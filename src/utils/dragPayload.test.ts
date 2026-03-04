import { describe, expect, it } from 'vitest'
import { encodeDragPayload, normalizeDragPaths, parseDragPayload } from './dragPayload'

describe('drag payload helpers', () => {
  it('normalizes drag paths by trimming and deduplicating', () => {
    expect(normalizeDragPaths([' C:\\Docs\\A.pdf ', '', 'C:\\Docs\\A.pdf', 'D:\\Work\\B.pdf'])).toEqual([
      'C:\\Docs\\A.pdf',
      'D:\\Work\\B.pdf',
    ])
  })

  it('encodes payloads with uri-list for browser-compatible drops', () => {
    const payload = encodeDragPayload(['C:\\Users\\Alice\\A&B #1.pdf'])

    expect(payload.mimePayload).toBe('["C:\\\\Users\\\\Alice\\\\A&B #1.pdf"]')
    expect(payload.plainPayload).toBe('C:\\Users\\Alice\\A&B #1.pdf')
    expect(payload.uriListPayload).toContain('file:///C:/Users/Alice/A&B%20#1.pdf')
  })

  it('parses uri-list payload lines back to normalized windows paths', () => {
    const payload = [
      '# browser comment',
      'file:///C:/Users/Alice/Reports/2026%20Plan.pdf',
      'file:///D:/Shared/Specs/alpha%231.txt',
    ].join('\n')

    expect(parseDragPayload(payload)).toEqual([
      'C:\\Users\\Alice\\Reports\\2026 Plan.pdf',
      'D:\\Shared\\Specs\\alpha#1.txt',
    ])
  })
})
