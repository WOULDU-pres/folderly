import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ExtractAndRemoveResult, ExtractResult, FileItem } from '../types'
import { getFileDirectory, getFileNameWithoutExt, toCustomNamePdfPath } from '../utils/path'
import { FileNameModal } from './FileNameModal'
import { ProgressBar } from './ProgressBar'

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

;(pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

type PdfDocumentProxy = {
  numPages: number
  destroy: () => Promise<void>
  getPage: (pageNumber: number) => Promise<{
    getViewport: (params: { scale: number }) => { width: number; height: number }
    render: (params: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => {
      promise: Promise<void>
    }
  }>
}

type PdfViewerProps = {
  open: boolean
  file: FileItem | null
  currentDir: string
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

export function PdfViewer({ open, file, currentDir, onClose, onExtracted, onRenamed, onBusyChange }: PdfViewerProps) {
  const [loading, setLoading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCause, setErrorCause] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const [largePreviews, setLargePreviews] = useState<Record<number, string>>({})
  const [selectedPages, setSelectedPages] = useState<number[]>([])
  const [activePage, setActivePage] = useState(1)
  const [loadVersion, setLoadVersion] = useState(0)
  const [pendingScrollPage, setPendingScrollPage] = useState<number | null>(null)
  const [fileNameModalOpen, setFileNameModalOpen] = useState(false)
  const [renameModalOpen, setRenameModalOpen] = useState(false)
  const [zoom, setZoom] = useState(600)
  const [pendingExtract, setPendingExtract] = useState<{ fileName: string; pages: number[] } | null>(null)

  // Internal file state - survives temporary null prop during rename/refresh
  const [viewerFile, setViewerFile] = useState<FileItem | null>(null)
  const skipReloadRef = useRef(false)

  const rightPaneRef = useRef<HTMLDivElement>(null)
  const thumbRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const largePageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const observerRef = useRef<IntersectionObserver | null>(null)
  const pdfDocRef = useRef<PdfDocumentProxy | null>(null)

  // Sync viewerFile from prop: only update when prop is non-null
  useEffect(() => {
    if (open && file) {
      setViewerFile(file)
    }
    if (!open) {
      setViewerFile(null)
      setPendingScrollPage(null)
    }
  }, [open, file])

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
  }, [extracting, renaming, loading])

  const interactionLocked = extracting || renaming

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

  // Load PDF thumbnails - depends on viewerFile path
  useEffect(() => {
    if (skipReloadRef.current) {
      skipReloadRef.current = false
      return
    }

    if (!open || !viewerFile || !isPdf) return

    const targetFile = viewerFile
    let cancelled = false

    async function loadPdf() {
      setLoading(true)
      setError(null)
      setErrorCause(null)
      setSuccess(null)
      setThumbs({})
      setLargePreviews({})
      setSelectedPages([])
      setActivePage(1)
      setFileNameModalOpen(false)
      setPendingExtract(null)
      setZoom(600)

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
        setPageCount(pdfDocument.numPages)

        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
          if (cancelled) break
          const page = await pdfDocument.getPage(pageNumber)
          const viewport = page.getViewport({ scale: 0.35 })
          const canvas = window.document.createElement('canvas')
          const context = canvas.getContext('2d')
          if (!context) continue

          canvas.width = viewport.width
          canvas.height = viewport.height

          await page.render({ canvasContext: context, viewport }).promise
          if (cancelled) break

          setThumbs((prev) => ({ ...prev, [pageNumber]: canvas.toDataURL('image/png') }))
        }
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
    }
  }, [open, viewerFile?.path, loadVersion, setResolvedError])

  // Render large preview lazily via IntersectionObserver
  const renderLargePage = useCallback(async (pageNumber: number) => {
    const doc = pdfDocRef.current
    if (!doc) return
    try {
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 2.0 })
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
  }, [])

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

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !fileNameModalOpen && !renameModalOpen && !pendingExtract && !interactionLocked) {
        onClose()
      }
      if (e.key === 'Escape' && pendingExtract) {
        setPendingExtract(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, fileNameModalOpen, renameModalOpen, pendingExtract, interactionLocked])

  // Ctrl+Scroll to zoom
  useEffect(() => {
    const pane = rightPaneRef.current
    if (!open || !pane) return

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom((prev) => {
        const delta = e.deltaY > 0 ? -50 : 50
        return Math.min(1400, Math.max(200, prev + delta))
      })
    }

    pane.addEventListener('wheel', handleWheel, { passive: false })
    return () => pane.removeEventListener('wheel', handleWheel)
  }, [open])

  const togglePage = (page: number) => {
    if (interactionLocked) return
    setSelectedPages((prev) => {
      if (prev.includes(page)) {
        return prev.filter((p) => p !== page)
      }
      return [...prev, page]
    })
  }

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

  const doExtract = async (fileName: string, sortedPages: number[], destructive: boolean) => {
    if (!viewerFile) return

    setPendingExtract(null)
    setExtracting(true)
    setError(null)
    setErrorCause(null)
    setSuccess(null)

    try {
      const dir = currentDir || getFileDirectory(viewerFile.path)
      const outputPath = toCustomNamePdfPath(dir, fileName)

      if (destructive) {
        const totalPagesBeforeExtract = pageCount > 0 ? pageCount : Math.max(activePage, ...sortedPages)
        const nextPage = getAdjustedPageAfterRemoval(activePage, sortedPages, totalPagesBeforeExtract)
        const result = await invoke<ExtractAndRemoveResult>('extract_and_remove_pdf_pages', {
          inputPath: viewerFile.path,
          pages: sortedPages,
          outputPath,
        })
        if (result.remainingPath !== viewerFile.path) {
          const nextName = result.remainingPath.split(/[\\/]/).pop() ?? viewerFile.name
          setViewerFile((prev) => (prev ? { ...prev, id: result.remainingPath, path: result.remainingPath, name: nextName } : prev))
          onRenamed(viewerFile.path, result.remainingPath)
        }
        setSuccess(
          appendWarningsMessage(
            `${result.extractedCount}개 페이지를 추출하고, 원본에 ${result.remainingCount}개 페이지가 남았습니다.`,
            result.warnings,
          ),
        )
        setPendingScrollPage(nextPage)
        setLoadVersion((prev) => prev + 1)
        onExtracted()
      } else {
        const result = await invoke<ExtractResult>('extract_pdf_pages', {
          inputPath: viewerFile.path,
          pages: sortedPages,
          outputPath,
        })
        setErrorCause(null)
        setSuccess(appendWarningsMessage(`${result.pageCount}개 페이지를 추출했습니다: ${fileName}`, result.warnings))
      }
    } catch (e) {
      setResolvedError(e, destructive ? '페이지 추출 및 원본 수정에 실패했습니다.' : '페이지 추출에 실패했습니다.')
    } finally {
      setExtracting(false)
    }
  }

  const defaultExtractName = viewerFile ? `${getFileNameWithoutExt(viewerFile.path)}_selected.pdf` : 'extracted.pdf'

  const handleRenameConfirm = async (newName: string) => {
    if (!viewerFile) return
    setRenameModalOpen(false)
    setRenaming(true)
    setError(null)
    setErrorCause(null)
    try {
      const finalName = newName.toLowerCase().endsWith('.pdf') ? newName : `${newName}.pdf`
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
      <div className="pdf-viewer-card">
        {/* Header */}
        <div className="pdf-viewer-header">
          <div>
            <h2>{viewerFile?.name ?? 'PDF Viewer'}</h2>
            <p className="file-subtitle">{pageCount > 0 ? `${pageCount}페이지` : 'Loading...'}</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
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
            <button className="ghost" onClick={selectAll} disabled={loading || pageCount === 0 || interactionLocked}>
              전체 선택
            </button>
            <button className="ghost" onClick={clearSelection} disabled={loading || selectedPages.length === 0 || interactionLocked}>
              선택 해제
            </button>
            <span className="meta-pill">{selectedCountLabel}</span>

            <div style={{ flex: 1 }} />

            {loading && pageCount > 0 && (
              <div style={{ minWidth: 150 }}>
                <ProgressBar current={Object.keys(thumbs).length} total={pageCount} label={`썸네일 ${Object.keys(thumbs).length}/${pageCount}`} />
              </div>
            )}

            <button className="ghost" onClick={() => setZoom((z) => Math.max(200, z - 50))} disabled={interactionLocked}>-</button>
            <span className="meta-pill">{Math.round(zoom / 6)}%</span>
            <button className="ghost" onClick={() => setZoom((z) => Math.min(1400, z + 50))} disabled={interactionLocked}>+</button>

            <button className="primary" onClick={handleExtractClick} disabled={!canExtract}>
              {extracting ? '추출 중...' : '선택 추출'}
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
                    onClick={() => {
                      togglePage(pageNumber)
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

                return (
                  <div
                    key={pageNumber}
                    data-page={pageNumber}
                    ref={(el) => { largePageRefs.current[pageNumber] = el }}
                    className={`pdf-large-page ${selected ? 'selected' : ''}`}
                    style={{ width: `${zoom}px` }}
                  >
                    {largePreviews[pageNumber] ? (
                      <img src={largePreviews[pageNumber]} alt={`Page ${pageNumber}`} />
                    ) : (
                      <div className="pdf-page-skeleton" style={{ width: `${zoom}px` }} />
                    )}
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
        onConfirm={handleExtractConfirm}
        onCancel={() => setFileNameModalOpen(false)}
      />

      <FileNameModal
        open={renameModalOpen}
        title="PDF 이름 바꾸기"
        defaultName={viewerFile?.name ?? ''}
        onConfirm={(name) => void handleRenameConfirm(name)}
        onCancel={() => setRenameModalOpen(false)}
      />

      {pendingExtract && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="추출 확인" style={{ zIndex: 50 }}>
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
