import { useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'

type SearchBarProps = {
  value: string
  onChange: (query: string) => void
  placeholder?: string
}

export function SearchBar({ value, onChange, placeholder = '파일 검색 (Ctrl+F)' }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 36,
        borderRadius: 8,
        border: '1px solid var(--border, #e1e4ea)',
        background: 'var(--bg-pane, #ffffff)',
        padding: '0 10px',
        minWidth: 160,
        maxWidth: 300,
        flex: '1 1 210px',
        fontSize: 14,
      }}
    >
      <Search size={16} style={{ color: 'var(--muted, #5d636f)', flexShrink: 0 }} />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="파일 검색"
        style={{
          border: 'none',
          background: 'transparent',
          outline: 'none',
          font: 'inherit',
          fontSize: 15,
          color: 'var(--text, #1f1f1f)',
          flex: 1,
          minWidth: 0,
          padding: 0,
        }}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          aria-label="검색 초기화"
          style={{
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: 2,
            display: 'inline-flex',
            alignItems: 'center',
            color: 'var(--muted, #5d636f)',
          }}
        >
          <X size={15} />
        </button>
      )}
    </div>
  )
}
