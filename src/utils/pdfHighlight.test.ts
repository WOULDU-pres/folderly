import { describe, expect, it } from 'vitest'
import {
  composePdfRotation,
  HIGHLIGHT_LINE_MARGIN,
  rotatePointFromCanonical,
  rotatePointToCanonical,
  toRelativePointFromRect,
  type NormalizedPoint,
} from './pdfHighlight'

function expectPointClose(actual: NormalizedPoint, expected: NormalizedPoint) {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
}

describe('pdfHighlight rotation mapping', () => {
  const samplePoint: NormalizedPoint = { x: 0.27, y: 0.64 }

  it.each([0, 90, 180, 270])(
    'keeps canonical/display conversions inverse at %d°',
    (rotation) => {
      const canonical = rotatePointToCanonical(samplePoint, rotation)
      const displayAgain = rotatePointFromCanonical(canonical, rotation)
      expectPointClose(displayAgain, samplePoint)
    },
  )

  it.each([0, 90, 180, 270])(
    'preserves a drawn horizontal display line after round-trip at %d°',
    (rotation) => {
      const y = 0.42
      const displayStart = { x: HIGHLIGHT_LINE_MARGIN, y }
      const displayEnd = { x: 1 - HIGHLIGHT_LINE_MARGIN, y }

      const canonicalStart = rotatePointToCanonical(displayStart, rotation)
      const canonicalEnd = rotatePointToCanonical(displayEnd, rotation)

      const renderedStart = rotatePointFromCanonical(canonicalStart, rotation)
      const renderedEnd = rotatePointFromCanonical(canonicalEnd, rotation)

      expectPointClose(renderedStart, displayStart)
      expectPointClose(renderedEnd, displayEnd)
      expect(renderedStart.y).toBeCloseTo(renderedEnd.y, 6)
    },
  )

  it('normalizes out-of-range rotations to quarter-turns', () => {
    const point = { x: 0.1, y: 0.9 }
    expectPointClose(rotatePointToCanonical(point, 450), rotatePointToCanonical(point, 90))
    expectPointClose(rotatePointFromCanonical(point, -90), rotatePointFromCanonical(point, 270))
  })

  it('composes intrinsic rotation with user rotation', () => {
    expect(composePdfRotation(0, 90)).toBe(90)
    expect(composePdfRotation(90, 90)).toBe(180)
    expect(composePdfRotation(180, 180)).toBe(0)
    expect(composePdfRotation(270, 90)).toBe(0)
    expect(composePdfRotation(-90, 0)).toBe(270)
  })

  it('converts client coordinates to clamped relative point', () => {
    const point = toRelativePointFromRect(230, 470, { left: 30, top: 70, width: 100, height: 200 })
    expectPointClose(point, { x: 1, y: 1 })

    const insidePoint = toRelativePointFromRect(80, 170, { left: 30, top: 70, width: 100, height: 200 })
    expectPointClose(insidePoint, { x: 0.5, y: 0.5 })

    const zeroSizePoint = toRelativePointFromRect(80, 170, { left: 30, top: 70, width: 0, height: 0 })
    expectPointClose(zeroSizePoint, { x: 0, y: 0 })
  })
})
