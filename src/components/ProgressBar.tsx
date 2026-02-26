type ProgressBarProps = {
  current: number
  total: number
  label?: string
}

export function ProgressBar({ current, total, label }: ProgressBarProps) {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: 'var(--border, #e1e4ea)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${percentage}%`,
            background: 'var(--accent, #0b57d0)',
            borderRadius: 3,
            transition: 'width 200ms ease',
          }}
        />
      </div>
      <span style={{ fontSize: 12, color: 'var(--muted, #5d636f)', whiteSpace: 'nowrap', minWidth: 60, textAlign: 'right' }}>
        {label ?? `${current}/${total} (${percentage}%)`}
      </span>
    </div>
  )
}
