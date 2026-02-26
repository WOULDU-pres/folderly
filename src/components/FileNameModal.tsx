import { useEffect, useRef, useState } from 'react'

type FileNameModalProps = {
  open: boolean
  title: string
  defaultName: string
  onConfirm: (name: string) => void
  onCancel: () => void
}

export function FileNameModal({ open, title, defaultName, onConfirm, onCancel }: FileNameModalProps) {
  const [name, setName] = useState(defaultName)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setName(defaultName)
      setTimeout(() => {
        const input = inputRef.current
        if (input) {
          input.focus()
          const dotIndex = defaultName.lastIndexOf('.')
          input.setSelectionRange(0, dotIndex > 0 ? dotIndex : defaultName.length)
        }
      }, 50)
    }
  }, [open, defaultName])

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  if (!open) return null

  const trimmed = name.trim()
  const canConfirm = trimmed.length > 0

  const handleSubmit = () => {
    if (canConfirm) {
      onConfirm(trimmed)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title} style={{ zIndex: 40 }}>
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
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
        <input
          ref={inputRef}
          type="text"
          value={name}
          aria-label={title}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSubmit()
            }
          }}
          style={{
            height: 38,
            borderRadius: 8,
            border: '1px solid var(--border)',
            padding: '0 12px',
            fontSize: 14,
            fontFamily: 'inherit',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="ghost" onClick={onCancel}>
            취소
          </button>
          <button className="primary" onClick={handleSubmit} disabled={!canConfirm}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
