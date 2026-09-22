import { useEffect, useMemo, useRef } from 'react'
import type { Layer, MapBundle } from '../lib/types'
import type { Selection } from '../lib/select'
import { fmtDuration } from './ui'

interface Props {
  bundle: MapBundle
  selection: Selection
  playhead: number | null
  onPlayhead: (t: number | null) => void
  playing: boolean
  onPlaying: (p: boolean) => void
  speed: number
  onSpeed: (s: number) => void
  trailSec: number
  onTrail: (s: number) => void
  /** true when a single match is selected — playback only makes sense then */
  enabled: boolean
}

const SPEEDS = [1, 2, 4, 8, 16]

export function Timeline(p: Props) {
  const { selection, playhead, onPlayhead, playing, onPlaying, enabled } = p
  const span = Math.max(1, selection.tMax - selection.tMin)
  const barRef = useRef<HTMLDivElement>(null)
  const raf = useRef<number>()
  const last = useRef<number>(0)

  // Drive playback off rAF so speed is wall-clock accurate.
  useEffect(() => {
    if (!playing || !enabled) return
    last.current = performance.now()
    const tick = (now: number) => {
      const dt = (now - last.current) / 1000
      last.current = now
      const cur = playhead ?? selection.tMin
      const next = cur + dt * p.speed
      if (next >= selection.tMax) {
        onPlayhead(selection.tMax)
        onPlaying(false)
        return
      }
      onPlayhead(next)
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [playing, playhead, p.speed, selection.tMin, selection.tMax, enabled, onPlayhead, onPlaying])

  // Event-density strip: where in the match things actually happen.
  const histogram = useMemo(() => {
    const BINS = 180
    const { layerIds } = p.bundle.config
    const traffic = new Float32Array(BINS)
    const rows: Record<Layer, Float32Array> = {}
    for (const id of layerIds) rows[id] = new Float32Array(BINS)

    const bin = (t: number) =>
      Math.min(BINS - 1, Math.max(0, Math.floor(((t - selection.tMin) / span) * BINS)))

    const { t } = p.bundle.events
    for (let i = 0; i < selection.positions.length; i++) traffic[bin(t[selection.positions[i]])]++
    for (const id of layerIds) {
      const idxs = selection.byLayer[id]
      if (!idxs) continue
      for (let i = 0; i < idxs.length; i++) rows[id][bin(t[idxs[i]])]++
    }
    const max = (a: Float32Array) => a.reduce((m, v) => (v > m ? v : m), 0)
    return {
      traffic, rows, layerIds, BINS,
      maxTraffic: max(traffic) || 1,
      maxEvent: Math.max(1, ...layerIds.map((id) => max(rows[id]))),
    }
  }, [selection, span, p.bundle])

  const scrub = (clientX: number) => {
    const el = barRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    onPlayhead(selection.tMin + frac * span)
  }

  const pct = playhead === null ? 100 : ((playhead - selection.tMin) / span) * 100
  const elapsed = playhead === null ? span : playhead - selection.tMin

  return (
    <div className="border-t border-edge/60 bg-ink-800 px-3 py-2.5 select-none">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <button
            className="btn btn-primary w-[62px]"
            disabled={!enabled}
            onClick={() => {
              if (!playing && (playhead === null || playhead >= selection.tMax)) {
                onPlayhead(selection.tMin)
              }
              onPlaying(!playing)
            }}
          >{playing ? '❚❚ Pause' : '▶ Play'}</button>
          <button
            className="btn"
            disabled={!enabled}
            onClick={() => { onPlaying(false); onPlayhead(selection.tMin) }}
            title="Restart"
          >↺</button>
          <button
            className="btn"
            onClick={() => { onPlaying(false); onPlayhead(null) }}
            title="Show the whole match at once"
          >Show all</button>
        </div>

        <div className="flex-1 min-w-0">
          {/* density strip + scrubber */}
          <div
            ref={barRef}
            className={`relative h-11 rounded-md overflow-hidden bg-ink-900 border border-edge/60 ${enabled ? 'cursor-pointer' : 'cursor-default opacity-60'}`}
            onPointerDown={(e) => {
              if (!enabled) return
              ;(e.target as Element).setPointerCapture(e.pointerId)
              onPlaying(false)
              scrub(e.clientX)
            }}
            onPointerMove={(e) => { if (e.buttons === 1 && enabled) scrub(e.clientX) }}
          >
            {/* traffic area */}
            <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none"
                 viewBox={`0 0 ${histogram.BINS} 100`}>
              <path
                d={areaPath(histogram.traffic, histogram.maxTraffic, histogram.BINS)}
                fill="rgba(56,189,248,0.16)" stroke="rgba(56,189,248,0.5)" strokeWidth="0.6"
                vectorEffect="non-scaling-stroke"
              />
              {histogram.layerIds.map((layer) => (
                <g key={layer}>
                  {Array.from(histogram.rows[layer]).map((v, i) =>
                    v > 0 ? (
                      <rect
                        key={i} x={i} y={100 - (v / histogram.maxEvent) * 62}
                        width={1} height={(v / histogram.maxEvent) * 62}
                        fill={p.bundle.config.colorOf[layer]} opacity={0.75}
                      />
                    ) : null,
                  )}
                </g>
              ))}
            </svg>

            {/* consumed region */}
            <div
              className="absolute inset-y-0 left-0 bg-white/[0.06] pointer-events-none"
              style={{ width: `${pct}%` }}
            />
            {playhead !== null && (
              <div
                className="absolute inset-y-0 w-px bg-white pointer-events-none"
                style={{ left: `${pct}%`, boxShadow: '0 0 8px rgba(255,255,255,.8)' }}
              />
            )}
          </div>

          <div className="flex justify-between mt-1 text-[10px] num text-slate-500">
            <span>0:00</span>
            <span className="text-slate-300">
              {fmtDuration(elapsed)} <span className="text-slate-600">/ {fmtDuration(span)}</span>
            </span>
            <span>{fmtDuration(span)}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex rounded-md overflow-hidden border border-edge/70">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => p.onSpeed(s)}
                className={`px-1.5 py-1 text-[10px] num transition-colors ${
                  p.speed === s ? 'bg-ink-500 text-white' : 'bg-ink-700 text-slate-500 hover:text-slate-300'
                }`}
              >{s}×</button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-[10px] text-slate-500" title="How much history stays drawn behind the playhead">
            trail
            <input
              type="range" min={5} max={900} step={5} value={p.trailSec}
              onChange={(e) => p.onTrail(Number(e.target.value))}
              className="w-16"
            />
            <span className="num w-10 text-slate-400">
              {p.trailSec >= 900 ? 'full' : `${p.trailSec}s`}
            </span>
          </label>
        </div>
      </div>
    </div>
  )
}

function areaPath(data: Float32Array, max: number, bins: number) {
  let d = `M 0 100`
  for (let i = 0; i < bins; i++) d += ` L ${i} ${100 - (data[i] / max) * 92}`
  return `${d} L ${bins - 1} 100 Z`
}
