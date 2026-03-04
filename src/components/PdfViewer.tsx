import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ExtractAndRemoveResult, ExtractResult, FileItem, SavePdfHighlightsResult } from '../types'
import { getFileDirectory, getFileNameWithoutExt, toCustomNamePdfPath, withPreservedExtension } from '../utils/path'
import {
  composePdfRotation,
  HIGHLIGHT_LINE_MARGIN,
  HIGHLIGHT_STROKE_OPACITY,
  HIGHLIGHT_STROKE_WIDTH,
  rotatePointFromCanonical,
  rotatePointToCanonical,
  toRelativePointFromRect,
  type NormalizedPoint,
} from '../utils/pdfHighlight'
import { FileNameModal } from './FileNameModal'
import { ProgressBar } from './ProgressBar'
import { PDF_EXTRACT_KEYWORD_SUGGESTIONS } from '../utils/keywordSuggestion'
import { popLastHighlight, type HighlightUndoHistoryEntry } from '../utils/highlightUndo'

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

;(pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

type PdfDocumentProxy = {
  numPages: number
  destroy: () => Promise<void>
  getPage: (pageNumber: number) => Promise<{
    rotate?: number
    getViewport: (params: { scale: number; rotation?: number }) => { width: number; height: number }
    render: (params: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => {
      promise: Promise<void>
    }
  }>
}

type PdfViewerProps = {
  open: boolean
  file: FileItem | null
  currentDir: string
  canMergePdf: boolean
  onOpenMerge: () => void
  onClose: () => void
  onExtracted: () => void
  onRenamed: (oldPath: string, newPath: string) => void
  onBusyChange?: (message: string | null) => void
}

type ResolvedPdfError = {
  message: string
  cause: string | null
}

type ErrorWithCause = Error & { cause?: unknown }

type PageSourceMap = Record<number, number>

type HighlightLine = {
  id: string
  page: number
  color: string
  start: NormalizedPoint
  end: NormalizedPoint
}

type HighlightHistoryEntry = HighlightUndoHistoryEntry

const ZOOM_MIN = 200
const ZOOM_MAX = 1400
const ZOOM_DEFAULT = 600
const ZOOM_STEP = 25
const HIGHLIGHT_COLORS = ['#fde047', '#38bdf8', '#f97316', '#34d399', '#f43f5e', '#a78bfa'] as const

function isClientPointInsideElement(
  element: HTMLElement,
  clientPoint: { x: number; y: number },
): boolean {
  const rect = element.getBoundingClientRect()
  return (
    clientPoint.x >= rect.left &&
    clientPoint.x <= rect.right &&
    clientPoint.y >= rect.top &&
    clientPoint.y <= rect.bottom
  )
}

function createPageSourceMap(pageCount: number): PageSourceMap {
  const map: PageSourceMap = {}
  for (let page = 1; page <= pageCount; page += 1) {
    map[page] = page
  }
  return map
}

function normalizeRemovedPages(pages: number[], maxPage: number): number[] {
  const normalized = new Set<number>()
  for (const page of pages) {
    if (!Number.isFinite(page) || page < 1 || page > maxPage) continue
    normalized.add(Math.trunc(page))
  }
  return [...normalized].sort((a, b) => a - b)
}

function resolvePdfError(errorValue: unknown, fallback: string): ResolvedPdfError {
  let rawMessage: unknown = null
  let rawCause: unknown = null

  if (errorValue instanceof Error) {
    rawMessage = errorValue.message
    rawCause = (errorValue as ErrorWithCause).cause
  } else if (typeof errorValue === 'string') {
    rawMessage = errorValue
  } else if (typeof errorValue === 'object' && errorValue !== null) {
    const errorObject = errorValue as {
      message?: unknown
      error?: unknown
      cause?: unknown
      details?: unknown
    }
    rawMessage = errorObject.message ?? errorObject.error ?? null
    rawCause = errorObject.cause ?? errorObject.details ?? null
  }

  let message = typeof rawMessage === 'string' ? rawMessage.trim() : ''
  let cause = typeof rawCause === 'string' ? rawCause.trim() : null

  if (!message) {
    message = fallback
  }

  message = message.replace(/^error while invoking [^:]+:\s*/i, '').trim()

  if (!cause) {
    const causedByMatch = message.match(/(?:caused by|원인)\s*:?\s*(.+)$/i)
    if (causedByMatch?.[1]) {
      cause = causedByMatch[1].trim()
      message = message.slice(0, causedByMatch.index).trim() || fallback
    }
  }

  if (!cause) {
    const separatorIndex = message.indexOf(': ')
    const hasWindowsPathPrefix = /^[A-Za-z]:[\\/]/.test(message)
    if (!hasWindowsPathPrefix && separatorIndex > 0 && separatorIndex < message.length - 2) {
      const summary = message.slice(0, separatorIndex).trim()
      const detail = message.slice(separatorIndex + 2).trim()
      if (summary && detail) {
        message = summary
        cause = detail
      }
    }
  }

  if (cause) {
    cause = cause.replace(/^error while invoking [^:]+:\s*/i, '').trim()
    if (!cause || cause === message) {
      cause = null
    }
  }

  return { message, cause }
}

function getAdjustedPageAfterRemoval(currentPage: number, removedPages: number[], totalPages: number): number {
  if (totalPages <= 0) return 1

  const clampedCurrent = Math.min(Math.max(currentPage, 1), totalPages)
  const normalizedRemoved = Array.from(
    new Set(removedPages.filter((page) => page >= 1 && page <= totalPages)),
  ).sort((a, b) => a - b)

  if (normalizedRemoved.length === 0) {
    return clampedCurrent
  }

  const removedSet = new Set(normalizedRemoved)
  let anchorOldPage = clampedCurrent

  if (removedSet.has(anchorOldPage)) {
    let nextCandidate = anchorOldPage + 1
    while (nextCandidate <= totalPages && removedSet.has(nextCandidate)) {
      nextCandidate += 1
    }

    if (nextCandidate <= totalPages) {
      anchorOldPage = nextCandidate
    } else {
      let prevCandidate = anchorOldPage - 1
      while (prevCandidate >= 1 && removedSet.has(prevCandidate)) {
        prevCandidate -= 1
      }
      anchorOldPage = Math.max(prevCandidate, 1)
    }
  }

  const removedBeforeAnchor = normalizedRemoved.filter((page) => page < anchorOldPage).length
  const remainingCount = Math.max(totalPages - normalizedRemoved.length, 1)
  return Math.min(remainingCount, Math.max(1, anchorOldPage - removedBeforeAnchor))
}

function appendWarningsMessage(baseMessage: string, warnings: string[]): string {
  if (!warnings.length) return baseMessage
  return `${baseMessage} (참고: ${warnings.join(' / ')})`
}

export function PdfViewer({
  open,
  file,
  currentDir,
  canMergePdf,
  onOpenMerge,
  onClose,
  onExtracted,
  onRenamed,
  onBusyChange,
}: PdfViewerProps) {
  const [loading, setLoading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCause, setErrorCause] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const [largePreviews, setLargePreviews] = useState<Record<number, string>>({})
  const [pageDisplayRotations, setPageDisplayRotations] = useState<Record<number, 0 | 90 | 180 | 270>>({})
  const [selectedPages, setSelectedPages] = useState<number[]>([])
  const [activePage, setActivePage] = useState(1)
  const [loadVersion, setLoadVersion] = useState(0)
  const [pendingScrollPage, setPendingScrollPage] = useState<number | null>(null)
  const [fileNameModalOpen, setFileNameModalOpen] = useState(false)
  const [renameModalOpen, setRenameModalOpen] = useState(false)
  const [zoom, setZoom] = useState(ZOOM_DEFAULT)
  const [rotation, setRotation] = useState(0)
  const [pendingExtract, setPendingExtract] = useState<{ fileName: string; pages: number[] } | null>(null)
  const [highlightColor, setHighlightColor] = useState<string>(HIGHLIGHT_COLORS[0])
  const [highlightLines, setHighlightLines] = useState<Record<number, HighlightLine[]>>({})
  const [highlightHistory, setHighlightHistory] = useState<HighlightHistoryEntry[]>([])
  const [savingHighlights, setSavingHighlights] = useState(false)

  // Internal file state - survives temporary null prop during rename/refresh
  const [viewerFile, setViewerFile] = useState<FileItem | null>(null)
  const skipReloadRef = useRef(false)
  const pageSourceMapRef = useRef<PageSourceMap>({})
  const lastRenderedFileSignatureRef = useRef<string | null>(null)
  const lastRenderedRotationRef = useRef(0)

  const rightPaneRef = useRef<HTMLDivElement>(null)
  const thumbRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const largePageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const pendingExtractPrimaryRef = useRef<HTMLButtonElement>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const pdfDocRef = useRef<PdfDocumentProxy | null>(null)
  const lastSelectedPageRef = useRef<number | null>(null)
  const thumbsRef = useRef<Record<number, string>>({})
  const highlightHistoryRef = useRef<HighlightHistoryEntry[]>([])
  const highlightIdSequenceRef = useRef(0)

  const setHighlightHistoryState = useCallback((nextHistory: HighlightHistoryEntry[]) => {
    highlightHistoryRef.current = nextHistory
    setHighlightHistory(nextHistory)
  }, [])

  const clearHighlightHistory = useCallback(() => {
    setHighlightHistoryState([])
  }, [setHighlightHistoryState])

  useEffect(() => {
    thumbsRef.current = thumbs
  }, [thumbs])

  useEffect(() => {
    highlightHistoryRef.current = highlightHistory
  }, [highlightHistory])

  const remapPageDataAfterRemoval = useCallback((removedPages: number[]) => {
    if (!pageCount || removedPages.length === 0) return

    const normalizedRemoved = normalizeRemovedPages(removedPages, pageCount)
    if (normalizedRemoved.length === 0) return
    const removedSet = new Set(normalizedRemoved)
    const nextPageSourceMap: PageSourceMap = {}
    const nextThumbs: Record<number, string> = {}
    const nextLargePreviews: Record<number, string> = {}
    const nextPageDisplayRotations: Record<number, 0 | 90 | 180 | 270> = {}
    let removedBefore = 0

    for (let currentPage = 1; currentPage <= pageCount; currentPage += 1) {
      if (removedSet.has(currentPage)) {
        removedBefore += 1
        continue
      }

      const nextPage = currentPage - removedBefore
      const sourcePage = pageSourceMapRef.current[currentPage] ?? currentPage
      nextPageSourceMap[nextPage] = sourcePage

      const thumbValue = thumbs[currentPage]
      if (thumbValue) {
        nextThumbs[nextPage] = thumbValue
      }

      const largeValue = largePreviews[currentPage]
      if (largeValue) {
        nextLargePreviews[nextPage] = largeValue
      }

      const pageRotationValue = pageDisplayRotations[currentPage]
      if (pageRotationValue !== undefined) {
        nextPageDisplayRotations[nextPage] = pageRotationValue
      }
    }

    setThumbs(nextThumbs)
    setLargePreviews(nextLargePreviews)
    setPageDisplayRotations(nextPageDisplayRotations)

    pageSourceMapRef.current = nextPageSourceMap
  }, [pageCount, thumbs, largePreviews, pageDisplayRotations])

  // Sync viewerFile from prop: only update when prop is non-null
  useEffect(() => {
    if (open && file) {
      setViewerFile(file)
    }
    if (!open) {
      setViewerFile(null)
      lastSelectedPageRef.current = null
      setPendingScrollPage(null)
      setSelectedPages([])
      setHighlightLines({})
      clearHighlightHistory()
      highlightIdSequenceRef.current = 0
      setPageDisplayRotations({})
      setRotation(0)
    }
  }, [open, file, clearHighlightHistory])

  const isPdf = viewerFile?.ext.toLowerCase() === 'pdf'

  const setResolvedError = useCallback((errorValue: unknown, fallback: string) => {
    const resolved = resolvePdfError(errorValue, fallback)
    setError(resolved.message)
    setErrorCause(resolved.cause)
  }, [])

  const busyOverlayContent = useMemo(() => {
    if (extracting) {
      return {
        title: 'PDF 편집 작업을 저장하는 중...',
        description: '페이지 추출/삭제 결과를 파일에 반영하고 있습니다.',
      }
    }
    if (savingHighlights) {
      return {
        title: 'PDF 하이라이트를 저장하는 중...',
        description: '하이라이트 데이터가 파일로 저장되고 있습니다.',
      }
    }
    if (renaming) {
      return {
        title: 'PDF 이름을 변경하는 중...',
        description: '파일 정보를 업데이트하고 있습니다.',
      }
    }
    if (loading) {
      return {
        title: 'PDF를 불러오는 중...',
        description: '썸네일과 미리보기를 준비하고 있습니다.',
      }
    }
    return null
  }, [extracting, savingHighlights, renaming, loading])

  const interactionLocked = extracting || renaming || savingHighlights

  const hasHighlights = useMemo(() => {
    return Object.values(highlightLines).some((lines) => lines.length > 0)
  }, [highlightLines])

  const defaultExtractName = viewerFile ? `${getFileNameWithoutExt(viewerFile.path)}_selected.pdf` : 'extracted.pdf'

  useEffect(() => {
    if (!onBusyChange) return
    if (!open || !busyOverlayContent) {
      onBusyChange(null)
      return
    }

    onBusyChange(busyOverlayContent.title)
  }, [open, busyOverlayContent, onBusyChange])

  useEffect(() => {
    return () => onBusyChange?.(null)
  }, [onBusyChange])

  // Load PDF thumbnails and rendered pages - depends on viewerFile path + rotation
  useEffect(() => {
    if (skipReloadRef.current) {
      skipReloadRef.current = false
      return
    }

    if (!open || !viewerFile || !isPdf) return

    const targetFile = viewerFile
    let cancelled = false

    async function loadPdf() {
      const signature = `${targetFile.path}#${loadVersion}`
      const isSameSession = lastRenderedFileSignatureRef.current === signature
      const canReuseThumbs =
        isSameSession &&
        lastRenderedRotationRef.current === rotation &&
        Object.keys(thumbsRef.current).length > 0
      setLoading(true)
      setError(null)
      setErrorCause(null)
      setSuccess(null)
      if (!canReuseThumbs) {
        setThumbs({})
        thumbsRef.current = {}
      }
      setLargePreviews({})
      if (!isSameSession) {
        setSelectedPages([])
        setHighlightLines({})
        clearHighlightHistory()
        setPageDisplayRotations({})
      }
      lastSelectedPageRef.current = null
      if (!isSameSession) {
        setActivePage(1)
      }
      setFileNameModalOpen(false)
      setPendingExtract(null)
      if (!isSameSession) {
        setZoom(ZOOM_DEFAULT)
        setRotation(0)
      }

      if (pdfDocRef.current) {
        await pdfDocRef.current.destroy()
        pdfDocRef.current = null
      }

      try {
        const bytes = await invoke<number[]>('read_file_bytes', { path: targetFile.path })
        const data = new Uint8Array(bytes)
        const task = (pdfjs as unknown as { getDocument: (source: { data: Uint8Array }) => { promise: Promise<PdfDocumentProxy> } }).getDocument({ data })
        const pdfDocument = await task.promise

        if (cancelled) return

        pdfDocRef.current = pdfDocument
        pageSourceMapRef.current = createPageSourceMap(pdfDocument.numPages)
        setPageCount(pdfDocument.numPages)

        if (canReuseThumbs) {
          const nextThumbs: Record<number, string> = {}
          for (let page = 1; page <= pdfDocument.numPages; page += 1) {
            const existingThumb = thumbsRef.current[page]
            if (existingThumb) {
              nextThumbs[page] = existingThumb
            }
          }
          thumbsRef.current = nextThumbs
          setThumbs(nextThumbs)
        }

        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
          if (cancelled) break
          if (thumbsRef.current[pageNumber]) continue
          const page = await pdfDocument.getPage(pageNumber)
          const effectiveRotation = composePdfRotation(page.rotate ?? 0, rotation)
          setPageDisplayRotations((prev) => (
            prev[pageNumber] === effectiveRotation
              ? prev
              : { ...prev, [pageNumber]: effectiveRotation }
          ))
          const viewport = page.getViewport({ scale: 0.35, rotation: effectiveRotation })
          const canvas = window.document.createElement('canvas')
          const context = canvas.getContext('2d')
          if (!context) continue

          canvas.width = viewport.width
          canvas.height = viewport.height

          await page.render({ canvasContext: context, viewport }).promise
          if (cancelled) break

          const renderedThumb = canvas.toDataURL('image/png')
          thumbsRef.current = { ...thumbsRef.current, [pageNumber]: renderedThumb }
          setThumbs((prev) => ({ ...prev, [pageNumber]: renderedThumb }))
        }

        lastRenderedFileSignatureRef.current = signature
        lastRenderedRotationRef.current = rotation
      } catch (e) {
        if (!cancelled) {
          setResolvedError(e, 'PDF 미리보기에 실패했습니다.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadPdf()

    return () => {
      cancelled = true
      if (pdfDocRef.current) {
        void pdfDocRef.current.destroy()
        pdfDocRef.current = null
      }
      setThumbs({})
      setLargePreviews({})
      setPageDisplayRotations({})
      thumbsRef.current = {}
      pageSourceMapRef.current = {}
    }
  }, [open, viewerFile?.path, rotation, loadVersion, setResolvedError])

  // Render large preview lazily via IntersectionObserver
  const renderLargePage = useCallback(async (pageNumber: number) => {
    const doc = pdfDocRef.current
    if (!doc) return
    const sourcePage = pageSourceMapRef.current[pageNumber]
    if (!sourcePage) return
    try {
      const page = await doc.getPage(sourcePage)
      const effectiveRotation = composePdfRotation(page.rotate ?? 0, rotation)
      setPageDisplayRotations((prev) => (
        prev[pageNumber] === effectiveRotation
          ? prev
          : { ...prev, [pageNumber]: effectiveRotation }
      ))
      const viewport = page.getViewport({ scale: 2.0, rotation: effectiveRotation })
      const canvas = window.document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) return

      canvas.width = viewport.width
      canvas.height = viewport.height

      await page.render({ canvasContext: context, viewport }).promise
      setLargePreviews((prev) => ({ ...prev, [pageNumber]: canvas.toDataURL('image/png') }))
    } catch {
      // Silently skip failed page renders
    }
  }, [rotation])

  // Setup IntersectionObserver for large pages
  useEffect(() => {
    if (!open || pageCount === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = Number(entry.target.getAttribute('data-page'))
          if (!pageNum) continue

          if (entry.isIntersecting) {
            setActivePage(pageNum)
            // Trigger lazy render if not already rendered
            setLargePreviews((prev) => {
              if (!prev[pageNum]) {
                void renderLargePage(pageNum)
              }
              return prev
            })
          }
        }
      },
      { threshold: 0.5, root: rightPaneRef.current },
    )

    observerRef.current = observer

    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [open, pageCount, renderLargePage])

  // Observe large page elements when they mount
  useEffect(() => {
    const observer = observerRef.current
    if (!observer || pageCount === 0) return

    // Observe all registered large page refs
    for (let i = 1; i <= pageCount; i++) {
      const el = largePageRefs.current[i]
      if (el) observer.observe(el)
    }

    return () => {
      observer.disconnect()
    }
  }, [pageCount, loading])

  // Auto-scroll sidebar thumb when activePage changes
  useEffect(() => {
    const thumbEl = thumbRefs.current[activePage]
    if (thumbEl) {
      thumbEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [activePage])

  // ESC to close (only when no sub-modal is open)
  useEffect(() => {
    if (!open) return

    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false
      if (target.isContentEditable) return true
      const tagName = target.tagName.toLowerCase()
      if (tagName === 'input' || tagName === 'textarea') return true
      return Boolean(target.closest('[contenteditable=\"true\"]'))
    }

    const undoLastHighlight = (): boolean => {
      const history = highlightHistoryRef.current
      const last = history[history.length - 1]
      if (!last) return false

      const nextHistory = history.slice(0, -1)
      setHighlightHistoryState(nextHistory)
      setHighlightLines((current) => popLastHighlight(history, current).nextLinesByPage)
      setError(null)
      setErrorCause(null)
      setSuccess('마지막 하이라이트를 취소했습니다.')
      return true
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      const isUndoShortcut = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z'
      if (isUndoShortcut) {
        if (interactionLocked) return
        if (fileNameModalOpen || renameModalOpen || pendingExtract) return
        if (isEditableTarget(e.target)) return

        if (undoLastHighlight()) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }

      if (e.key === 'Escape' && !fileNameModalOpen && !renameModalOpen && !pendingExtract && !interactionLocked) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, fileNameModalOpen, renameModalOpen, pendingExtract, interactionLocked, setHighlightHistoryState])

  useEffect(() => {
    if (!pendingExtract) return
    const raf = window.requestAnimationFrame(() => {
      pendingExtractPrimaryRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [pendingExtract])

  useEffect(() => {
    if (!pendingExtract || !open) return
    const handlePendingExtractShortcut = (event: KeyboardEvent) => {
      if (interactionLocked) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setPendingExtract(null)
        return
      }
      if (
        event.key === 'Enter'
        && !event.shiftKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.altKey
      ) {
        event.preventDefault()
        event.stopPropagation()
        void doExtract(pendingExtract.fileName, pendingExtract.pages, true)
      }
    }

    window.addEventListener('keydown', handlePendingExtractShortcut, true)
    return () => window.removeEventListener('keydown', handlePendingExtractShortcut, true)
  }, [pendingExtract, open, interactionLocked, doExtract])

  const viewerCardRef = useRef<HTMLDivElement>(null)

  const applyZoomWithAnchor = useCallback(
    (
      resolver: (prev: number) => number,
      anchorClientPoint?: { clientX: number; clientY: number },
    ) => {
      if (interactionLocked) return

      const pane = rightPaneRef.current
      setZoom((prev) => {
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, resolver(prev)))
        if (!pane || next === prev) return next

        const paneRect = pane.getBoundingClientRect()
        const anchorX = anchorClientPoint?.clientX ?? paneRect.left + paneRect.width / 2
        const anchorY = anchorClientPoint?.clientY ?? paneRect.top + paneRect.height / 2
        const relativeX = Math.min(Math.max(anchorX - paneRect.left, 0), pane.clientWidth)
        const relativeY = Math.min(Math.max(anchorY - paneRect.top, 0), pane.clientHeight)
        const contentX = pane.scrollLeft + relativeX
        const contentY = pane.scrollTop + relativeY
        const scale = next / prev

        window.requestAnimationFrame(() => {
          const targetLeft = contentX * scale - relativeX
          const targetTop = contentY * scale - relativeY
          const maxLeft = Math.max(0, pane.scrollWidth - pane.clientWidth)
          const maxTop = Math.max(0, pane.scrollHeight - pane.clientHeight)
          pane.scrollLeft = Math.min(maxLeft, Math.max(0, targetLeft))
          pane.scrollTop = Math.min(maxTop, Math.max(0, targetTop))
        })

        return next
      })
    },
    [interactionLocked],
  )

  const updateZoomWithAnchor = useCallback(
    (delta: number, anchorClientPoint?: { clientX: number; clientY: number }) => {
      applyZoomWithAnchor((prev) => prev + delta, anchorClientPoint)
    },
    [applyZoomWithAnchor],
  )

  const cycleRotation = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360)
  }, [])

  // Ctrl/Cmd + Scroll to zoom (capture on modal card to avoid being blocked by inner scroll targets)
  useEffect(() => {
    const container = viewerCardRef.current
    if (!open || !isPdf || !container) return

    const handleWheel = (event: WheelEvent) => {
      const shouldZoom = event.ctrlKey || event.metaKey
      if (!shouldZoom) return
      const pane = rightPaneRef.current
      if (!pane) return

      const targetNode = event.target as Node | null
      const targetInsideCard = targetNode ? container.contains(targetNode) : false
      const targetInsidePane = targetNode ? pane.contains(targetNode) : false
      const pointer = { x: event.clientX, y: event.clientY }
      const pointerInsideCard = isClientPointInsideElement(container, pointer)
      const pointerInsidePane = isClientPointInsideElement(pane, pointer)

      if (!targetInsideCard && !pointerInsideCard) return
      if (!targetInsidePane && !pointerInsidePane) return

      event.preventDefault()
      event.stopPropagation()

      const direction = Math.sign(event.deltaY)
      if (direction === 0) return
      const step = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? ZOOM_STEP * 2 : ZOOM_STEP
      const delta = direction > 0 ? -step : step
      updateZoomWithAnchor(delta, { clientX: event.clientX, clientY: event.clientY })
    }

    document.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => document.removeEventListener('wheel', handleWheel, { capture: true })
  }, [open, isPdf, interactionLocked, updateZoomWithAnchor])

  const selectAll = () => {
    if (interactionLocked) return
    setSelectedPages(Array.from({ length: pageCount }, (_, i) => i + 1))
  }

  const clearSelection = () => {
    if (interactionLocked) return
    setSelectedPages([])
  }

  const scrollToPage = useCallback((pageNum: number) => {
    const pane = rightPaneRef.current
    if (!pane) return
    const el = pane.querySelector(`[data-page="${pageNum}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  useEffect(() => {
    if (!open || loading || pendingScrollPage === null || pageCount <= 0) return
    const targetPage = Math.min(Math.max(pendingScrollPage, 1), pageCount)
    setActivePage(targetPage)
    const raf = window.requestAnimationFrame(() => {
      scrollToPage(targetPage)
    })
    setPendingScrollPage(null)
    return () => window.cancelAnimationFrame(raf)
  }, [open, loading, pendingScrollPage, pageCount, scrollToPage])

  const selectionIndex = useCallback(
    (page: number) => {
      const idx = selectedPages.indexOf(page)
      return idx >= 0 ? idx + 1 : 0
    },
    [selectedPages],
  )

  const toCanonicalPoint = useCallback(
    (point: NormalizedPoint, pageRotation: number): NormalizedPoint => rotatePointToCanonical(point, pageRotation),
    [],
  )

  const toDisplayPoint = useCallback(
    (point: NormalizedPoint, pageRotation: number): NormalizedPoint => rotatePointFromCanonical(point, pageRotation),
    [],
  )

  const createHighlightId = useCallback((pageNumber: number): string => {
    highlightIdSequenceRef.current += 1
    return `highlight-${Date.now()}-${highlightIdSequenceRef.current}-${pageNumber}`
  }, [])

  const handleLineClick = useCallback(
    (event: MouseEvent<HTMLDivElement>, pageNumber: number) => {
      if (interactionLocked) return
      if (event.detail > 1) return

      const lineCanvas = event.currentTarget.querySelector<HTMLElement>('.pdf-page-canvas')
      const clickTarget = event.target as Node | null
      if (!lineCanvas || !clickTarget || !lineCanvas.contains(clickTarget)) return

      const pageRotation = pageDisplayRotations[pageNumber] ?? composePdfRotation(0, rotation)
      const displayPoint = toRelativePointFromRect(
        event.clientX,
        event.clientY,
        lineCanvas.getBoundingClientRect(),
      )
      const line: HighlightLine = {
        id: createHighlightId(pageNumber),
        page: pageNumber,
        color: highlightColor,
        start: toCanonicalPoint({ x: HIGHLIGHT_LINE_MARGIN, y: displayPoint.y }, pageRotation),
        end: toCanonicalPoint({ x: 1 - HIGHLIGHT_LINE_MARGIN, y: displayPoint.y }, pageRotation),
      }

      setHighlightLines((current) => {
        const existing = current[pageNumber] ?? []
        return {
          ...current,
          [pageNumber]: [...existing, line],
        }
      })
      const nextHistory = [...highlightHistoryRef.current, { id: line.id, page: pageNumber }]
      setHighlightHistoryState(nextHistory)
      setTimeout(() => {
        setActivePage(pageNumber)
        scrollToPage(pageNumber)
      }, 0)
      event.preventDefault()
    },
    [
      createHighlightId,
      highlightColor,
      interactionLocked,
      pageDisplayRotations,
      rotation,
      scrollToPage,
      setHighlightHistoryState,
      toCanonicalPoint,
    ],
  )

  const getRangePages = useCallback((start: number, end: number): number[] => {
    if (start > end) {
      const temp = start
      start = end
      end = temp
    }
    const range: number[] = []
    for (let page = start; page <= end; page += 1) {
      range.push(page)
    }
    return range
  }, [])

  const clearAndSetSelection = (pages: number[]) => {
    const deduped = [...new Set(pages)]
    deduped.sort((a, b) => a - b)
    setSelectedPages(deduped)
  }

  const togglePage = (page: number, modifiers?: { shift?: boolean; ctrl?: boolean }) => {
    if (interactionLocked) return
    const hasShift = !!modifiers?.shift
    const hasCtrl = !!modifiers?.ctrl

    if (hasShift && lastSelectedPageRef.current !== null) {
      const rangePages = getRangePages(lastSelectedPageRef.current, page)
      if (hasCtrl) {
        setSelectedPages((prev) => {
          const nextSet = new Set(prev)
          rangePages.forEach((p) => nextSet.add(p))
          const next = [...nextSet]
          next.sort((a, b) => a - b)
          return next
        })
      } else {
        clearAndSetSelection(rangePages)
      }
    } else if (hasShift) {
      setSelectedPages((prev) => (prev.includes(page) ? prev.filter((p) => p !== page) : [...prev, page]))
    } else if (hasCtrl) {
      setSelectedPages((prev) => (prev.includes(page) ? prev.filter((p) => p !== page) : [...prev, page]))
    } else {
      setSelectedPages([page])
    }

    lastSelectedPageRef.current = page
  }

  const canExtract = selectedPages.length > 0 && !!viewerFile && !loading && !interactionLocked

  const selectedCountLabel = useMemo(() => `${selectedPages.length}/${pageCount} 선택`, [selectedPages.length, pageCount])

  const handleExtractClick = () => {
    if (!canExtract) return
    setFileNameModalOpen(true)
  }

  const handleExtractConfirm = (fileName: string) => {
    if (!viewerFile) return

    setFileNameModalOpen(false)
    const sortedPages = [...selectedPages].sort((a, b) => a - b)

    if (selectedPages.length < pageCount) {
      // Partial selection — show confirmation before deciding destructive vs non-destructive
      setPendingExtract({ fileName, pages: sortedPages })
    } else {
      // Full selection — always non-destructive
      void doExtract(fileName, sortedPages, false)
    }
  }

  async function doExtract(fileName: string, sortedPages: number[], destructive: boolean) {
    if (!viewerFile) return

    setPendingExtract(null)
    setExtracting(true)
    setError(null)
    setErrorCause(null)
    setSuccess(null)

    try {
      const dir = currentDir || getFileDirectory(viewerFile.path)
      const outputPath = toCustomNamePdfPath(dir, fileName, defaultExtractName)

      if (destructive) {
        const totalPagesBeforeExtract = pageCount > 0 ? pageCount : Math.max(activePage, ...sortedPages)
        const nextPage = getAdjustedPageAfterRemoval(activePage, sortedPages, totalPagesBeforeExtract)
        const result = await invoke<ExtractAndRemoveResult>('extract_and_remove_pdf_pages', {
          inputPath: viewerFile.path,
          pages: sortedPages,
          outputPath,
        })
        if (result.remainingPath === viewerFile.path) {
          remapPageDataAfterRemoval(sortedPages)
          setPageCount(result.remainingCount)
          setSelectedPages([])
          setPendingScrollPage(nextPage)
        } else {
          const nextName = result.remainingPath.split(/[\\/]/).pop() ?? viewerFile.name
          setViewerFile((prev) => (prev ? { ...prev, id: result.remainingPath, path: result.remainingPath, name: nextName } : prev))
          onRenamed(viewerFile.path, result.remainingPath)
          setLoadVersion((prev) => prev + 1)
        }
        setSuccess(
          appendWarningsMessage(
            `${result.extractedCount}개 페이지를 추출하고, 원본에 ${result.remainingCount}개 페이지가 남았습니다.`,
            result.warnings,
          ),
        )
        onExtracted()
      } else {
        const result = await invoke<ExtractResult>('extract_pdf_pages', {
          inputPath: viewerFile.path,
          pages: sortedPages,
          outputPath,
        })
        setErrorCause(null)
        setSuccess(appendWarningsMessage(`${result.pageCount}개 페이지를 추출했습니다: ${fileName}`, result.warnings))
        onExtracted()
      }
    } catch (e) {
      setResolvedError(e, destructive ? '페이지 추출 및 원본 수정에 실패했습니다.' : '페이지 추출에 실패했습니다.')
    } finally {
      setExtracting(false)
    }
  }

  const doSaveHighlights = useCallback(async () => {
    if (!viewerFile) return
    if (!hasHighlights) {
      setError('저장할 하이라이트가 없습니다.')
      setErrorCause(null)
      return
    }

    const outputPath = viewerFile.path
    const data = Object.entries(highlightLines).flatMap(([page, lines]) =>
      lines.map((line) => ({
          page: Number(page),
          start: line.start,
          end: line.end,
          color: line.color,
      })),
    )

    setError(null)
    setErrorCause(null)
    setSuccess(null)
    setSavingHighlights(true)

    try {
      const result = await invoke<SavePdfHighlightsResult>('save_pdf_highlights', {
        inputPath: viewerFile.path,
        outputPath,
        lines: data,
        overwrite: true,
      })
      setSuccess(
        `현재 파일에 하이라이트를 덮어썼습니다: ${result.outputPath} (${result.totalLines}개 선)`,
      )
      if (result.warnings.length) {
        setErrorCause(appendWarningsMessage('일부 페이지가 비어 있거나 잘못된 항목은 저장되지 않았습니다.', result.warnings))
      }
    } catch (errorValue) {
      setResolvedError(errorValue, '하이라이트 저장에 실패했습니다.')
    } finally {
      setSavingHighlights(false)
    }
  }, [highlightLines, hasHighlights, viewerFile, setResolvedError])

  const handleRenameConfirm = async (newName: string) => {
    if (!viewerFile) return
    setRenameModalOpen(false)
    setRenaming(true)
    setError(null)
    setErrorCause(null)
    try {
      const finalName = withPreservedExtension(newName, viewerFile.name)
      const oldPath = viewerFile.path
      const newPath = await invoke<string>('rename_path', { path: oldPath, newName: finalName })

      // Update internal file reference immediately - skip PDF reload since content hasn't changed
      skipReloadRef.current = true
      setViewerFile({ ...viewerFile, name: finalName, path: newPath, id: newPath })

      setSuccess(`이름이 변경되었습니다: ${finalName}`)
      onRenamed(oldPath, newPath)
    } catch (e) {
      setResolvedError(e, '이름 변경에 실패했습니다.')
    } finally {
      setRenaming(false)
    }
  }

  if (!open) return null

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="PDF viewer">
      <div className="pdf-viewer-card" ref={viewerCardRef}>
        {/* Header */}
        <div className="pdf-viewer-header">
          <div>
            <h2>{viewerFile?.name ?? 'PDF Viewer'}</h2>
            <p className="file-subtitle">{pageCount > 0 ? `${pageCount}페이지` : 'Loading...'}</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {isPdf && (
              <>
                <button className="ghost" onClick={onOpenMerge} disabled={!canMergePdf || interactionLocked}>
                  PDF 병합
                </button>
                <button className="primary" onClick={handleExtractClick} disabled={!canExtract}>
                  {extracting ? '추출 중...' : 'PDF 페이지 추출'}
                </button>
              </>
            )}
            <button className="ghost" onClick={() => setRenameModalOpen(true)} disabled={!viewerFile || loading || interactionLocked}>
              이름 바꾸기
            </button>
            <button className="ghost" onClick={onClose} disabled={interactionLocked}>
              닫기
            </button>
          </div>
        </div>

        {/* Toolbar */}
        {isPdf && (
          <div className="modal-toolbar" style={{ padding: '0 16px 4px', gap: '8px', flexWrap: 'wrap' }}>
            <div className="highlight-color-picker" aria-label="하이라이트 색상 선택">
              {HIGHLIGHT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`highlight-color-swatch ${highlightColor === color ? 'active' : ''}`}
                  style={{ background: color }}
                  onClick={() => setHighlightColor(color)}
                  title={color}
                  aria-label={`하이라이트 색상 ${color}`}
                />
              ))}
            </div>

            <button className="ghost" onClick={selectAll} disabled={loading || pageCount === 0 || interactionLocked}>
              전체 선택
            </button>
            <button className="ghost" onClick={clearSelection} disabled={loading || selectedPages.length === 0 || interactionLocked}>
              선택 해제
            </button>
            <span className="meta-pill">{selectedCountLabel}</span>
            <button className="ghost" onClick={cycleRotation} disabled={loading || interactionLocked} title="90도 회전">
              회전 {rotation}°
            </button>

            <div style={{ flex: 1 }} />

            {loading && pageCount > 0 && (
              <div style={{ minWidth: 150 }}>
                <ProgressBar current={Object.keys(thumbs).length} total={pageCount} label={`썸네일 ${Object.keys(thumbs).length}/${pageCount}`} />
              </div>
            )}

            <button className="ghost" onClick={() => updateZoomWithAnchor(-ZOOM_STEP)} disabled={interactionLocked}>-</button>
            <span className="meta-pill">{Math.round(zoom / 6)}%</span>
            <button className="ghost" onClick={() => updateZoomWithAnchor(ZOOM_STEP)} disabled={interactionLocked}>+</button>
            <span className="meta-pill">Ctrl/Cmd+휠 줌</span>
            <span className="meta-pill">Ctrl/Cmd+Z 하이라이트 취소</span>

            <button
              className="ghost"
              onClick={() => void doSaveHighlights()}
              disabled={!hasHighlights || interactionLocked || savingHighlights}
            >
              {savingHighlights ? '하이라이트 저장 중...' : '하이라이트 저장'}
            </button>
          </div>
        )}

        {/* Body: dual panel */}
        {isPdf && (
          <div className="pdf-viewer-body">
            {/* Left sidebar */}
            <div className="pdf-sidebar">
              {loading && <p style={{ margin: 8, color: 'var(--muted)', fontSize: 13 }}>썸네일 생성 중...</p>}
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNumber) => {
                const selected = selectedPages.includes(pageNumber)
                const active = activePage === pageNumber
                const orderNum = selectionIndex(pageNumber)

                return (
                  <div
                    key={pageNumber}
                    ref={(el) => { thumbRefs.current[pageNumber] = el }}
                    className={`pdf-thumb-card ${selected ? 'selected' : ''} ${active ? 'active' : ''}`}
                    tabIndex={0}
                    role="option"
                    aria-selected={selected}
                    aria-label={`페이지 ${pageNumber}`}
                    onClick={(event) => {
                      togglePage(pageNumber, { shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey })
                      scrollToPage(pageNumber)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        togglePage(pageNumber)
                        scrollToPage(pageNumber)
                      }
                    }}
                  >
                    {selected && orderNum > 0 && <span className="selection-badge">{orderNum}</span>}
                    <div className="pdf-thumb-img">
                      {thumbs[pageNumber] ? (
                        <img src={thumbs[pageNumber]} alt={`Page ${pageNumber}`} />
                      ) : (
                        <span style={{ display: 'grid', placeItems: 'center', height: 60, fontSize: 11, color: 'var(--muted)' }}>...</span>
                      )}
                    </div>
                    <span className="pdf-thumb-label">{pageNumber}</span>
                  </div>
                )
              })}
            </div>

            {/* Right reading pane */}
            <div className="pdf-reading-pane" ref={rightPaneRef}>
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((pageNumber) => {
                const selected = selectedPages.includes(pageNumber)
                const orderNum = selectionIndex(pageNumber)
                const pageLines = highlightLines[pageNumber] ?? []
                const pageRotation = pageDisplayRotations[pageNumber] ?? composePdfRotation(0, rotation)

                return (
                  <div
                    key={pageNumber}
                    data-page={pageNumber}
                    ref={(el) => { largePageRefs.current[pageNumber] = el }}
                    className={`pdf-large-page ${selected ? 'selected' : ''}`}
                    style={{ width: `${zoom}px` }}
                    onClick={(event) => {
                      handleLineClick(event, pageNumber)
                      togglePage(pageNumber, { shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey })
                      scrollToPage(pageNumber)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        togglePage(pageNumber)
                        scrollToPage(pageNumber)
                      }
                    }}
                  >
                    <div className="pdf-page-canvas">
                      {largePreviews[pageNumber] ? (
                        <img src={largePreviews[pageNumber]} alt={`Page ${pageNumber}`} />
                      ) : (
                        <div className="pdf-page-skeleton" style={{ width: `${zoom}px` }} />
                      )}
                      {pageLines.length > 0 && (
                        <svg className="pdf-highlight-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
                          {pageLines.map((line) => {
                            const start = toDisplayPoint(line.start, pageRotation)
                            const end = toDisplayPoint(line.end, pageRotation)
                            return (
                              <line
                                key={line.id}
                              x1={start.x * 100}
                              y1={start.y * 100}
                              x2={end.x * 100}
                              y2={end.y * 100}
                              className="pdf-highlight-line"
                              stroke={line.color}
                              strokeWidth={HIGHLIGHT_STROKE_WIDTH}
                              strokeOpacity={HIGHLIGHT_STROKE_OPACITY}
                            />
                          )
                        })}
                        </svg>
                      )}
                    </div>
                    <div className="page-label">Page {pageNumber}</div>
                    <span className="selection-corner-badge">{orderNum > 0 ? orderNum : ''}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {!isPdf && <p className="error" style={{ padding: '0 16px' }}>PDF 파일을 선택해 주세요.</p>}

        {/* Footer */}
        <div className="pdf-viewer-footer">
          <div className="pdf-feedback">
            <span className={`pdf-feedback-main ${error ? 'error' : success ? 'success' : 'muted'}`}>
              {error ?? success ?? ''}
            </span>
            {errorCause && <span className="pdf-feedback-cause">원인: {errorCause}</span>}
          </div>
          <button className="ghost" onClick={onClose} disabled={interactionLocked}>
            닫기
          </button>
        </div>

        {busyOverlayContent && (
          <div className="pdf-global-loading-overlay" role="status" aria-live="polite" aria-busy="true">
            <div className="pdf-global-loading-content">
              <span className="pdf-global-loading-spinner" />
              <strong>{busyOverlayContent.title}</strong>
              <span>{busyOverlayContent.description}</span>
            </div>
          </div>
        )}
      </div>

      <FileNameModal
        open={fileNameModalOpen}
        title="추출 파일 이름"
        defaultName={defaultExtractName}
        preserveExtension
        keywords={PDF_EXTRACT_KEYWORD_SUGGESTIONS}
        onConfirm={handleExtractConfirm}
        onCancel={() => setFileNameModalOpen(false)}
      />

      <FileNameModal
        open={renameModalOpen}
        title="PDF 이름 바꾸기"
        defaultName={viewerFile?.name ?? ''}
        preserveExtension
        onConfirm={(name) => void handleRenameConfirm(name)}
        onCancel={() => setRenameModalOpen(false)}
      />

      {pendingExtract && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="추출 확인"
          style={{ zIndex: 50 }}
          tabIndex={-1}
        >
          <div
            style={{
              width: 'min(440px, 90vw)',
              borderRadius: 14,
              border: '1px solid var(--border)',
              background: '#ffffff',
              boxShadow: 'var(--shadow)',
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>추출 확인</h3>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--fg)' }}>
              선택한 페이지를 추출하고 원본에서 제거하시겠습니까?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="ghost" onClick={() => setPendingExtract(null)}>
                취소
              </button>
              <button
                className="ghost"
                onClick={() => void doExtract(pendingExtract.fileName, pendingExtract.pages, false)}
              >
                추출만
              </button>
              <button
                className="primary"
                onClick={() => void doExtract(pendingExtract.fileName, pendingExtract.pages, true)}
                ref={pendingExtractPrimaryRef}
              >
                추출 및 제거
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
