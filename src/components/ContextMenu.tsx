import { useEffect, useRef } from 'react'

export type ContextMenuItem = {
  label: string
  icon?: React.ReactNode
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}

type ContextMenuProps = {
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export function ContextMenu({ open, x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    // Use setTimeout to avoid catching the same click that opened the menu
    setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleKeyDown)
    }, 0)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  // Adjust position to keep menu within viewport
  useEffect(() => {
    if (!open || !menuRef.current) return
    const menu = menuRef.current
    const rect = menu.getBoundingClientRect()

    if (rect.right > window.innerWidth) {
      menu.style.left = `${x - rect.width}px`
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${y - rect.height}px`
    }
  }, [open, x, y])

  if (!open) return null

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 50,
        minWidth: 200,
        background: 'var(--bg-pane, #ffffff)',
        border: '1px solid var(--border, #e1e4ea)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
        padding: '4px 0',
        fontFamily: 'inherit',
        fontSize: 13,
      }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            item.onClick()
            onClose()
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '7px 12px',
            border: 'none',
            background: 'transparent',
            color: item.danger ? 'var(--danger, #b4232f)' : item.disabled ? 'var(--muted, #999)' : 'var(--text, #1f1f1f)',
            cursor: item.disabled ? 'not-allowed' : 'pointer',
            textAlign: 'left',
            font: 'inherit',
            opacity: item.disabled ? 0.5 : 1,
          }}
          onMouseEnter={(e) => {
            if (!item.disabled) (e.currentTarget.style.background = 'var(--bg-hover, #f3f5f8)')
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
        >
          {item.icon && <span style={{ display: 'inline-flex', width: 16, justifyContent: 'center' }}>{item.icon}</span>}
          <span style={{ flex: 1 }}>{item.label}</span>
          {item.shortcut && <span style={{ color: 'var(--muted, #999)', fontSize: 11 }}>{item.shortcut}</span>}
        </button>
      ))}
    </div>
  )
}
