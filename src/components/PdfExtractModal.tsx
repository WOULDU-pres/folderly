import { useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { FileItem, ExtractResult } from '../types'
import { toOutputPdfPath } from '../utils/path'

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

;(pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

type PdfDocumentProxy = {
  numPages: number
  destroy: () => void
  getPage: (pageNumber: number) => Promise<{
    getViewport: (params: { scale: number }) => { width: number; height: number }
    render: (params: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => {
      promise: Promise<void>
    }
  }>
}

type Props = {
  open: boolean
  file: FileItem | null
  onClose: () => void
}

export function PdfExtractModal({ open, file, onClose }: Props) {
  const [loading, setLoading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const [selectedPages, setSelectedPages] = useState<number[]>([])

  const isPdf = file?.ext.toLowerCase() === 'pdf'
  const pdfDocRef = useRef<PdfDocumentProxy | null>(null)

  useEffect(() => {
    if (!open) {
      pdfDocRef.current?.destroy()
      pdfDocRef.current = null
      setThumbs({})
      setSelectedPages([])
      setPageCount(0)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open || !file || !isPdf) return

    const targetFile = file
    let cancelled = false

    async function loadPdf() {
      setLoading(true)
      setError(null)
      setSuccess(null)
      setThumbs({})
      setSelectedPages([])

      try {
        const sourceUrl = convertFileSrc(targetFile.path)
        const task = (pdfjs as unknown as { getDocument: (source: string) => { promise: Promise<PdfDocumentProxy> } }).getDocument(sourceUrl)
        const pdfDocument = await task.promise

        if (cancelled) {
          pdfDocument.destroy()
          return
        }

        pdfDocRef.current = pdfDocument
        setPageCount(pdfDocument.numPages)
        setSelectedPages(Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1))

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
        setError(e instanceof Error ? e.message : 'PDF preview failed')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadPdf()

    return () => {
      cancelled = true
      pdfDocRef.current?.destroy()
      pdfDocRef.current = null
    }
  }, [open, file, isPdf])

  const canExtract = selectedPages.length > 0 && !!file && !extracting

  const selectedCountLabel = useMemo(() => `${selectedPages.length} selected`, [selectedPages.length])

  const togglePage = (page: number) => {
    setSelectedPages((prev) => {
      if (prev.includes(page)) {
        return prev.filter((p) => p !== page)
      }
      return [...prev, page].sort((a, b) => a - b)
    })
  }

  const selectAll = () => {
    setSelectedPages(Array.from({ length: pageCount }, (_, index) => index + 1))
  }

  const clearSelection = () => {
    setSelectedPages([])
  }

  const handleExtract = async () => {
    if (!file || !canExtract) return

    setExtracting(true)
    setError(null)
    setSuccess(null)

    try {
      const outputPath = toOutputPdfPath(file.path)
      const result = await invoke<ExtractResult>('extract_pdf_pages', {
        inputPath: file.path,
        pages: selectedPages,
        outputPath,
      })
      setSuccess(`Saved ${result.pageCount} pages to ${result.outputPath}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Extraction failed')
    } finally {
      setExtracting(false)
    }
  }

  if (!open) return null

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="PDF page extraction modal">
      <div className="modal-card">
        <header className="modal-header">
          <div>
            <h2>PDF 페이지 추출</h2>
            <p>{file?.name ?? '파일 없음'}</p>
          </div>
          <button className="ghost" onClick={onClose}>
            닫기
          </button>
        </header>

        {!isPdf && <p className="error">PDF 파일을 선택해 주세요.</p>}

        {isPdf && (
          <>
            <div className="modal-toolbar">
              <button className="ghost" onClick={selectAll} disabled={loading || pageCount === 0}>
                전체 선택
              </button>
              <button className="ghost" onClick={clearSelection} disabled={loading || pageCount === 0}>
                선택 해제
              </button>
              <span className="meta-pill">{selectedCountLabel}</span>
            </div>

            {loading && <p className="loading">PDF 미리보기를 생성하는 중...</p>}

            <div className="pdf-grid">
              {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => {
                const selected = selectedPages.includes(pageNumber)
                return (
                  <button
                    key={pageNumber}
                    className={`pdf-page-card ${selected ? 'selected' : ''}`}
                    onClick={() => togglePage(pageNumber)}
                  >
                    <div className="pdf-thumb">
                      {thumbs[pageNumber] ? <img src={thumbs[pageNumber]} alt={`Page ${pageNumber}`} /> : <span>Loading...</span>}
                    </div>
                    <span>Page {pageNumber}</span>
                  </button>
                )
              })}
            </div>

            <footer className="modal-footer">
              <button className="ghost" onClick={onClose}>
                취소
              </button>
              <button className="primary" onClick={handleExtract} disabled={!canExtract}>
                {extracting ? '추출 중...' : '선택 페이지 PDF로 저장'}
              </button>
            </footer>
          </>
        )}

        {error && <p className="error">{error}</p>}
        {success && <p className="success">{success}</p>}
      </div>
    </div>
  )
}
