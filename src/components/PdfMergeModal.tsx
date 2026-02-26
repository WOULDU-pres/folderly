import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { FileItem, MergeResult, MergeSource } from '../types'
import { toCustomNamePdfPath } from '../utils/path'
import { FileNameModal } from './FileNameModal'
import { ProgressBar } from './ProgressBar'

;(pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

type PdfDocumentProxy = {
  destroy: () => void
  getPage: (pageNumber: number) => Promise<{
    getViewport: (params: { scale: number }) => { width: number; height: number }
    render: (params: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => {
      promise: Promise<void>
    }
  }>
}

type PreviewEntry = {
  status: 'loading' | 'ready' | 'error'
  thumbnail?: string
}

type PdfMergeModalProps = {
  open: boolean
  pdfFiles: FileItem[]
  currentDir: string
  onClose: () => void
  onMerged: () => void
}

export function PdfMergeModal({ open, pdfFiles, currentDir, onClose, onMerged }: PdfMergeModalProps) {
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [previewByPath, setPreviewByPath] = useState<Record<string, PreviewEntry>>({})
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [fileNameModalOpen, setFileNameModalOpen] = useState(false)
  const loadingPreviewPathsRef = useRef(new Set<string>())
  const selectedPathSetRef = useRef(new Set<string>())
  const previewByPathRef = useRef<Record<string, PreviewEntry>>({})
  const fileByPath = useMemo(() => new Map(pdfFiles.map((file) => [file.path, file])), [pdfFiles])

  useEffect(() => {
    if (open) {
      setSelectedPaths([])
      setPreviewByPath({})
      setError(null)
      setSuccess(null)
      setMerging(false)
      setFileNameModalOpen(false)
      loadingPreviewPathsRef.current.clear()
      selectedPathSetRef.current.clear()
      previewByPathRef.current = {}
    }
  }, [open])

  useEffect(() => {
    previewByPathRef.current = previewByPath
  }, [previewByPath])

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !fileNameModalOpen) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, fileNameModalOpen])

  useEffect(() => {
    if (!open) {
      selectedPathSetRef.current.clear()
      loadingPreviewPathsRef.current.clear()
      setPreviewByPath({})
      return
    }

    const selectedSet = new Set(selectedPaths)
    selectedPathSetRef.current = selectedSet

    for (const loadingPath of Array.from(loadingPreviewPathsRef.current)) {
      if (!selectedSet.has(loadingPath)) {
        loadingPreviewPathsRef.current.delete(loadingPath)
      }
    }

    setPreviewByPath((prev) => {
      const next: Record<string, PreviewEntry> = {}
      for (const path of selectedPaths) {
        if (prev[path]) next[path] = prev[path]
      }
      return next
    })

    const loadPreview = async (path: string) => {
      let pdfDocument: PdfDocumentProxy | null = null
      try {
        const bytes = await invoke<number[]>('read_file_bytes', { path })
        const data = new Uint8Array(bytes)
        const task = (
          pdfjs as unknown as { getDocument: (source: { data: Uint8Array }) => { promise: Promise<PdfDocumentProxy> } }
        ).getDocument({ data })
        pdfDocument = await task.promise
        const page = await pdfDocument.getPage(1)
        const viewport = page.getViewport({ scale: 0.22 })

        const canvas = window.document.createElement('canvas')
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas context unavailable')

        canvas.width = viewport.width
        canvas.height = viewport.height
        await page.render({ canvasContext: context, viewport }).promise

        if (!selectedPathSetRef.current.has(path)) return

        setPreviewByPath((prev) => ({ ...prev, [path]: { status: 'ready', thumbnail: canvas.toDataURL('image/png') } }))
      } catch {
        if (!selectedPathSetRef.current.has(path)) return
        setPreviewByPath((prev) => ({ ...prev, [path]: { status: 'error' } }))
      } finally {
        pdfDocument?.destroy()
        loadingPreviewPathsRef.current.delete(path)
      }
    }

    for (const path of selectedPaths) {
      if (previewByPathRef.current[path] || loadingPreviewPathsRef.current.has(path)) continue

      loadingPreviewPathsRef.current.add(path)
      setPreviewByPath((prev) => ({ ...prev, [path]: { status: 'loading' } }))
      void loadPreview(path)
    }
  }, [open, selectedPaths])

  const toggleFile = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      if (prev.includes(path)) {
        return prev.filter((p) => p !== path)
      }
      return [...prev, path]
    })
  }, [])

  const selectionIndex = useCallback(
    (path: string) => {
      const idx = selectedPaths.indexOf(path)
      return idx >= 0 ? idx + 1 : 0
    },
    [selectedPaths],
  )

  const handleMergeClick = () => {
    if (selectedPaths.length < 2) return
    setFileNameModalOpen(true)
  }

  const handleMergeConfirm = async (fileName: string) => {
    setFileNameModalOpen(false)
    setMerging(true)
    setError(null)
    setSuccess(null)

    try {
      const sources: MergeSource[] = selectedPaths.map((p) => ({ path: p, pages: [] }))
      const outputPath = toCustomNamePdfPath(currentDir, fileName)

      const result = await invoke<MergeResult>('merge_pdf_pages', { sources, outputPath })
      setSuccess(`${result.totalPages}개 페이지로 병합 완료: ${fileName}`)
      onMerged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setMerging(false)
    }
  }

  if (!open) return null

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="PDF 병합">
      <div
        className="modal-card"
        style={{ height: 'min(85vh, 700px)', gridTemplateRows: 'auto 1fr auto auto' }}
      >
        <header className="modal-header">
          <div>
            <h2>PDF 병합</h2>
            <p>병합할 PDF 파일을 클릭 순서대로 선택하세요 ({selectedPaths.length}개 선택)</p>
          </div>
          <button className="ghost" onClick={onClose}>
            닫기
          </button>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(320px, 1fr)', gap: 12, padding: '8px 14px 10px', minHeight: 0 }}>
          <section style={{ border: '1px solid var(--border)', borderRadius: 10, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>PDF 목록</div>
            <div
              style={{
                overflow: 'auto',
                padding: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {pdfFiles.length === 0 && (
                <p style={{ color: 'var(--muted)', margin: 10 }}>현재 폴더에 PDF 파일이 없습니다.</p>
              )}
              {pdfFiles.map((file) => {
                const order = selectionIndex(file.path)
                const selected = order > 0

                return (
                  <button
                    key={file.id}
                    onClick={() => toggleFile(file.path)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: selected ? '1px solid var(--accent)' : '1px solid var(--border)',
                      background: selected ? 'var(--accent-soft)' : 'var(--bg-card, #fff)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 150ms ease',
                      fontFamily: 'inherit',
                      fontSize: 14,
                    }}
                  >
                    {selected && (
                      <span
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: '50%',
                          background: 'var(--accent)',
                          color: '#fff',
                          fontSize: 12,
                          fontWeight: 700,
                          display: 'grid',
                          placeItems: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {order}
                      </span>
                    )}
                    {!selected && (
                      <span
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: '50%',
                          border: '2px solid var(--border)',
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {file.name}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <section style={{ border: '1px solid var(--border)', borderRadius: 10, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>선택된 PDF 미리보기</div>
            <div style={{ overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {selectedPaths.length === 0 && (
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>좌측 목록에서 PDF를 선택하면 첫 페이지 썸네일이 표시됩니다.</p>
              )}

              {selectedPaths.map((path, index) => {
                const preview = previewByPath[path]
                const fileName = fileByPath.get(path)?.name ?? path.split(/[\\/]/).pop() ?? path

                return (
                  <article key={path} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          background: 'var(--accent)',
                          color: '#fff',
                          fontSize: 12,
                          fontWeight: 700,
                          display: 'grid',
                          placeItems: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {index + 1}
                      </span>
                      <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
                    </div>

                    <div
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        minHeight: 150,
                        background: '#f5f6f8',
                        display: 'grid',
                        placeItems: 'center',
                        padding: 8,
                      }}
                    >
                      {preview?.status === 'ready' && preview.thumbnail ? (
                        <img
                          src={preview.thumbnail}
                          alt={`${fileName} 첫 페이지`}
                          style={{ width: '100%', maxWidth: 190, objectFit: 'contain', borderRadius: 4, boxShadow: '0 2px 6px rgba(0, 0, 0, 0.08)' }}
                        />
                      ) : preview?.status === 'error' ? (
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>미리보기를 불러오지 못했습니다.</span>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', color: 'var(--muted)', fontSize: 12 }}>
                          <div style={{ width: 120, aspectRatio: '210 / 297', borderRadius: 4, border: '1px dashed var(--border)', background: '#eceff2' }} />
                          <span>미리보기 로딩 중...</span>
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        </div>

        <footer className="modal-footer" style={{ padding: '10px 14px' }}>
          {merging ? (
            <div style={{ flex: 1, maxWidth: 300 }}>
              <ProgressBar current={0} total={1} label="병합 중..." />
            </div>
          ) : (
            <span style={{ color: error ? 'var(--danger)' : success ? 'var(--success, #0f7e4f)' : 'var(--muted)', fontSize: 13, flex: 1 }}>
              {error ?? success ?? ''}
            </span>
          )}
          <button className="ghost" onClick={onClose}>
            취소
          </button>
          <button
            className="primary"
            onClick={handleMergeClick}
            disabled={selectedPaths.length < 2 || merging}
          >
            {merging ? '병합 중...' : `병합 (${selectedPaths.length}개 파일)`}
          </button>
        </footer>
      </div>

      <FileNameModal
        open={fileNameModalOpen}
        title="병합 파일 이름"
        defaultName="merged.pdf"
        onConfirm={(name) => void handleMergeConfirm(name)}
        onCancel={() => setFileNameModalOpen(false)}
      />
    </div>
  )
}
