import type { ReactNode } from 'react'

export function Section({
  title, children, right, className = '',
}: { title: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`px-3 py-3 border-b border-edge/50 ${className}`}>
      <header className="flex items-center justify-between mb-2">
        <h3 className="label">{title}</h3>
        {right}
      </header>
      {children}
    </section>
  )
}

export function Toggle({
  on, onClick, children, dot, title,
}: { on: boolean; onClick: () => void; children: ReactNode; dot?: string; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`chip flex items-center gap-1.5 ${on ? 'chip-on' : 'opacity-60'}`}
    >
      {dot && (
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: dot, boxShadow: on ? `0 0 6px ${dot}` : 'none' }}
        />
      )}
      {children}
    </button>
  )
}

export function Slider({
  label, value, min, max, step = 1, onChange, format,
}: {
  label: string; value: number; min: number; max: number; step?: number
  onChange: (v: number) => void; format?: (v: number) => string
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-slate-400">{label}</span>
        <span className="text-[11px] num text-slate-500">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </label>
  )
}

export function Stat({
  label, value, hint, accent,
}: { label: string; value: string | number; hint?: string; accent?: string }) {
  return (
    <div className="panel px-2.5 py-2">
      <div className="label truncate" title={label}>{label}</div>
      <div className="text-lg num font-semibold leading-tight mt-0.5" style={{ color: accent }}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-slate-500 mt-0.5 truncate">{hint}</div>}
    </div>
  )
}

export function fmtDuration(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function fmtClock(unixSec: number) {
  return new Date(unixSec * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC',
  })
}

export function fmtNum(n: number) {
  return n.toLocaleString()
}

export function shortId(id: string, n = 8) {
  return id.length > n ? `${id.slice(0, n)}…` : id
}
