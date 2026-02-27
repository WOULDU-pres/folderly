import { useEffect, useMemo, useRef, useState } from 'react'
import { findKeywordSuggestion } from '../utils/keywordSuggestion'
import { withPreservedExtension } from '../utils/path'

type FileNameModalProps = {
  open: boolean
  title: string
  defaultName: string
  onConfirm: (name: string) => void
  onCancel: () => void
  preserveExtension?: boolean
  keywords?: readonly string[]
}

function getTrailingExtension(fileName: string): string {
  const trimmed = fileName.trim()
  const dotIndex = trimmed.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === trimmed.length - 1) return ''
  return trimmed.slice(dotIndex)
}

function splitNameAndExtension(name: string): { base: string; extension: string } {
  const trimmed = name.trim()
  const dotIndex = trimmed.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === trimmed.length - 1) {
    return { base: trimmed, extension: '' }
  }

  return {
    base: trimmed.slice(0, dotIndex),
    extension: trimmed.slice(dotIndex),
  }
}

export function FileNameModal({
  open,
  title,
  defaultName,
  onConfirm,
  onCancel,
  preserveExtension = false,
  keywords,
}: FileNameModalProps) {
  const [name, setName] = useState(defaultName)
  const inputRef = useRef<HTMLInputElement>(null)

  const lockedExtension = useMemo(
    () => (preserveExtension ? getTrailingExtension(defaultName) : ''),
    [defaultName, preserveExtension],
  )

  const suggestion = useMemo(() => {
    if (!keywords?.length) return null

    const { base } = splitNameAndExtension(name)
    const matched = findKeywordSuggestion(base, keywords)
    if (!matched) return null

    return preserveExtension ? withPreservedExtension(matched, defaultName) : matched
  }, [name, keywords, preserveExtension, defaultName])

  const resolvedName = useMemo(() => {
    const trimmed = name.trim()
    if (!trimmed) return ''
    return preserveExtension ? withPreservedExtension(trimmed, defaultName) : trimmed
  }, [name, preserveExtension, defaultName])

  useEffect(() => {
    if (open) {
      setName(defaultName)
      setTimeout(() => {
        const input = inputRef.current
        if (input) {
          input.focus()

          const selectionEnd = lockedExtension
            ? Math.max(defaultName.length - lockedExtension.length, 0)
            : (() => {
                const dotIndex = defaultName.lastIndexOf('.')
                return dotIndex > 0 ? dotIndex : defaultName.length
              })()

          input.setSelectionRange(0, selectionEnd)
        }
      }, 50)
    }
  }, [open, defaultName, lockedExtension])

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

  const canConfirm = resolvedName.length > 0

  const handleSubmit = () => {
    if (canConfirm) {
      onConfirm(resolvedName)
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
        <div style={{ position: 'relative' }}>
          {suggestion && suggestion !== name && (
            <span
              aria-hidden
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                padding: '0 12px',
                color: 'rgba(0, 0, 0, 0.35)',
                pointerEvents: 'none',
                borderRadius: 8,
                fontSize: 14,
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {suggestion}
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={name}
            aria-label={title}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && suggestion) {
                e.preventDefault()
                setName(suggestion)
                requestAnimationFrame(() => {
                  const input = inputRef.current
                  if (!input) return
                  const selectionEnd = lockedExtension
                    ? Math.max(suggestion.length - lockedExtension.length, 0)
                    : suggestion.length
                  input.setSelectionRange(selectionEnd, selectionEnd)
                })
                return
              }

              if (e.key === 'Enter') {
                e.preventDefault()
                handleSubmit()
              }
            }}
            style={{
              position: 'relative',
              zIndex: 1,
              height: 38,
              borderRadius: 8,
              border: '1px solid var(--border)',
              padding: '0 12px',
              fontSize: 14,
              fontFamily: 'inherit',
              width: '100%',
              background: 'transparent',
              color: 'inherit',
            }}
          />
        </div>
        {suggestion && suggestion !== name && (
          <span style={{ marginTop: -6, color: 'var(--muted)', fontSize: 12 }}>Tab 키로 추천 이름 적용</span>
        )}
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
