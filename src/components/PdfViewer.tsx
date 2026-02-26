import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ExtractAndRemoveResult, FileItem } from '../types'
import { getFileDirectory, getFileNameWithoutExt, toCustomNamePdfPath } from '../utils/path'
import { FileNameModal } from './FileNameModal'

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
}

export function PdfViewer({ open, file, currentDir, onClose, onExtracted, onRenamed }: PdfViewerProps) {
  const [loading, setLoading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const [largePreviews, setLargePreviews] = useState<Record<number, string>>({})
  const [selectedPages, setSelectedPages] = useState<number[]>([])
  const [activePage, setActivePage] = useState(1)
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
    }
  }, [open, file])

  const isPdf = viewerFile?.ext.toLowerCase() === 'pdf'

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
        if (!cancelled) setError(e instanceof Error ? e.message : 'PDF 미리보기 실패')
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
  }, [open, viewerFile?.path])

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
      if (e.key === 'Escape' && !fileNameModalOpen && !renameModalOpen && !pendingExtract) {
        onClose()
      }
      if (e.key === 'Escape' && pendingExtract) {
        setPendingExtract(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, fileNameModalOpen, renameModalOpen, pendingExtract])

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
    setSelectedPages((prev) => {
      if (prev.includes(page)) {
        return prev.filter((p) => p !== page)
      }
      return [...prev, page]
    })
  }

  const selectAll = () => {
    setSelectedPages(Array.from({ length: pageCount }, (_, i) => i + 1))
  }

  const clearSelection = () => {
    setSelectedPages([])
  }

  const scrollToPage = (pageNum: number) => {
    const pane = rightPaneRef.current
    if (!pane) return
    const el = pane.querySelector(`[data-page="${pageNum}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const selectionIndex = useCallback(
    (page: number) => {
      const idx = selectedPages.indexOf(page)
      return idx >= 0 ? idx + 1 : 0
    },
    [selectedPages],
  )

  const canExtract = selectedPages.length > 0 && !!viewerFile && !extracting

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
    setSuccess(null)

    try {
      const dir = currentDir || getFileDirectory(viewerFile.path)
      const outputPath = toCustomNamePdfPath(dir, fileName)

      if (destructive) {
        const result = await invoke<ExtractAndRemoveResult>('extract_and_remove_pdf_pages', {
          inputPath: viewerFile.path,
          pages: sortedPages,
          outputPath,
        })
        setSuccess(`${result.extractedCount}개 페이지를 추출하고, 원본에 ${result.remainingCount}개 페이지가 남았습니다.`)
        onExtracted()
      } else {
        await invoke('extract_pdf_pages', {
          inputPath: viewerFile.path,
          pages: sortedPages,
          outputPath,
        })
        setSuccess(`${sortedPages.length}개 페이지를 추출했습니다: ${fileName}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExtracting(false)
    }
  }

  const defaultExtractName = viewerFile ? `${getFileNameWithoutExt(viewerFile.path)}_selected.pdf` : 'extracted.pdf'

  const handleRenameConfirm = async (newName: string) => {
    if (!viewerFile) return
    setRenameModalOpen(false)
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
      setError(e instanceof Error ? e.message : '이름 변경에 실패했습니다.')
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
            <button className="ghost" onClick={() => setRenameModalOpen(true)} disabled={!viewerFile}>
              이름 바꾸기
            </button>
            <button className="ghost" onClick={onClose}>
              닫기
            </button>
          </div>
        </div>

        {/* Toolbar */}
        {isPdf && (
          <div className="modal-toolbar" style={{ padding: '0 16px 4px', gap: '8px', flexWrap: 'wrap' }}>
            <button className="ghost" onClick={selectAll} disabled={loading || pageCount === 0}>
              전체 선택
            </button>
            <button className="ghost" onClick={clearSelection} disabled={loading || selectedPages.length === 0}>
              선택 해제
            </button>
            <span className="meta-pill">{selectedCountLabel}</span>

            <div style={{ flex: 1 }} />

            <button className="ghost" onClick={() => setZoom((z) => Math.max(200, z - 50))}>-</button>
            <span className="meta-pill">{Math.round(zoom / 6)}%</span>
            <button className="ghost" onClick={() => setZoom((z) => Math.min(1400, z + 50))}>+</button>

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
          <span style={{ color: error ? 'var(--danger)' : success ? '#0f7e4f' : 'var(--muted)', fontSize: 13 }}>
            {error ?? success ?? ''}
          </span>
          <button className="ghost" onClick={onClose}>
            닫기
          </button>
        </div>
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
