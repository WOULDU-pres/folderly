export type NormalizedPoint = {
  x: number
  y: number
}

// 10% margin on both sides => visible line spans 80% of page width
export const HIGHLIGHT_LINE_MARGIN = 0.1
// Doubled from the previous 9px thickness.
export const HIGHLIGHT_STROKE_WIDTH = 18
// Keep text readable under marker strokes.
export const HIGHLIGHT_STROKE_OPACITY = 0.35

function normalizeQuarterTurnRotation(rotation: number): 0 | 90 | 180 | 270 {
  const normalized = ((rotation % 360) + 360) % 360
  if (normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized
  }
  return 0
}

export function composePdfRotation(intrinsicRotation: number, userRotation: number): 0 | 90 | 180 | 270 {
  return normalizeQuarterTurnRotation(intrinsicRotation + userRotation)
}

export function toRelativePointFromRect(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): NormalizedPoint {
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 }
  }

  const x = (clientX - rect.left) / rect.width
  const y = (clientY - rect.top) / rect.height

  return {
    x: Math.min(Math.max(x, 0), 1),
    y: Math.min(Math.max(y, 0), 1),
  }
}

export function rotatePointToCanonical(point: NormalizedPoint, rotation: number): NormalizedPoint {
  const normalizedRotation = normalizeQuarterTurnRotation(rotation)

  switch (normalizedRotation) {
    case 90:
      return { x: point.y, y: 1 - point.x }
    case 180:
      return { x: 1 - point.x, y: 1 - point.y }
    case 270:
      return { x: 1 - point.y, y: point.x }
    default:
      return point
  }
}

export function rotatePointFromCanonical(point: NormalizedPoint, rotation: number): NormalizedPoint {
  const normalizedRotation = normalizeQuarterTurnRotation(rotation)

  switch (normalizedRotation) {
    case 90:
      return { x: 1 - point.y, y: point.x }
    case 180:
      return { x: 1 - point.x, y: 1 - point.y }
    case 270:
      return { x: point.y, y: 1 - point.x }
    default:
      return point
  }
}
