import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'

type RequiredDocumentsModalProps = {
  open: boolean
  folderName: string
  initialDocuments: string[]
  onConfirm: (documents: string[]) => void
  onCancel: () => void
}

function normalizeRequiredDocumentName(name: string): string {
  return name.trim()
}

function dedupeDocumentNames(names: string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []

  for (const name of names) {
    const trimmed = normalizeRequiredDocumentName(name)
    if (!trimmed) continue
    const normalized = trimmed.toLocaleLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    next.push(trimmed)
  }

  return next
}

export function RequiredDocumentsModal({
  open,
  folderName,
  initialDocuments,
  onConfirm,
  onCancel,
}: RequiredDocumentsModalProps) {
  const [documents, setDocuments] = useState<string[]>([])
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return

    setDocuments(dedupeDocumentNames(initialDocuments))
    setInputValue('')
    window.setTimeout(() => {
      inputRef.current?.focus()
    }, 30)
  }, [open, initialDocuments])

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  const hasInput = useMemo(() => inputValue.trim().length > 0, [inputValue])

  if (!open) return null

  const addDocument = () => {
    const trimmed = normalizeRequiredDocumentName(inputValue)
    if (!trimmed) return

    setDocuments((prev) => dedupeDocumentNames([...prev, trimmed]))
    setInputValue('')
    inputRef.current?.focus()
  }

  const removeDocument = (name: string) => {
    setDocuments((prev) => prev.filter((item) => item !== name))
  }

  const handleSave = () => {
    const trimmedInput = normalizeRequiredDocumentName(inputValue)
    const nextDocuments = trimmedInput
      ? dedupeDocumentNames([...documents, trimmedInput])
      : dedupeDocumentNames(documents)
    onConfirm(nextDocuments)
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="필수 문서 설정" style={{ zIndex: 41 }}>
      <div className="required-docs-modal-card">
        <div className="required-docs-modal-head">
          <h3>필수 문서 설정</h3>
          <p title={folderName}>{folderName}</p>
        </div>

        <div className="required-docs-input-row">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            placeholder="예: 계약서.pdf"
            aria-label="필수 문서 이름"
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addDocument()
              }
            }}
          />
          <button type="button" className="win-btn" disabled={!hasInput} onClick={addDocument}>
            추가
          </button>
        </div>

        <p className="required-docs-help">파일명 기준으로 자동 매칭됩니다.</p>

        <ul className="required-docs-chip-list">
          {documents.length === 0 && <li className="required-docs-empty">설정된 필수 문서가 없습니다.</li>}
          {documents.map((name) => (
            <li key={name} className="required-docs-chip">
              <span title={name}>{name}</span>
              <button type="button" onClick={() => removeDocument(name)} aria-label={`${name} 삭제`}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>

        <div className="modal-footer">
          <button type="button" className="ghost" onClick={onCancel}>
            취소
          </button>
          <button type="button" className="primary" onClick={handleSave}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
