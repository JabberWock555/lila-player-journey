import { useEffect, useRef, useState } from 'react'
import type { MapBundle } from '../lib/types'
import type { Selection } from '../lib/select'
import { describeEvent } from '../lib/select'
import {
  canvasToMap, mapRect, pickEvent, render,
  type RenderLayers, type View,
} from '../lib/render'
import { fmtClock, shortId } from './ui'

interface Props {
  bundle: MapBundle
  selection: Selection
  layers: RenderLayers
  view: View
  onView: (v: View) => void
  mapBrightness: number
  showPaths: boolean
  pathOpacity: number
  showMarkers: boolean
  markerScale: number
  showPositions: boolean
  positionScale: number
  playhead: number | null
  trailSec: number
  focusJourney: number | null
}

export function MapView(props: Props) {
  const { bundle, selection, view, onView } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ idx: number; cx: number; cy: number } | null>(null)
  const [cursorWorld, setCursorWorld] = useState<{ x: number; z: number } | null>(null)
  const [tick, setTick] = useState(0)
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const onViewRef = useRef(onView)
  onViewRef.current = onView

  // Redraw whenever anything visual changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    render(canvas, {
      bundle, selection, view,
      layers: props.layers,
      mapBrightness: props.mapBrightness,
      showPaths: props.showPaths,
      pathOpacity: props.pathOpacity,
      showMarkers: props.showMarkers,
      markerScale: props.markerScale,
      showPositions: props.showPositions,
      positionScale: props.positionScale,
      playhead: props.playhead,
      trailSec: props.trailSec,
      focusJourney: props.focusJourney,
      hoverIndex: hover?.idx ?? null,
    })
  }, [bundle, selection, view, props.layers, props.mapBrightness, props.showPaths,
      props.pathOpacity, props.showMarkers, props.markerScale, props.showPositions,
      props.positionScale, props.playhead, props.trailSec, props.focusJourney,
      hover, tick])

  // Redraw on resize. `tick` just forces the render effect above to re-run.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTick((t) => t + 1))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // React attaches onWheel as a *passive* listener, so preventDefault there is
  // rejected and the page scrolls instead of the map zooming. Bind natively.
  const viewRef = useRef(view)
  viewRef.current = view
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = viewRef.current
      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top

      const next = Math.max(1, Math.min(14, v.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      if (next === v.zoom) return

      // Keep the point under the cursor pinned while zooming.
      const before = mapRect(rect.width, rect.height, v)
      const [mx, my] = canvasToMap(cx, cy, before)
      const after = mapRect(rect.width, rect.height, { ...v, zoom: next })
      const dx = (cx - (after.left + mx * after.size)) / after.size
      const dy = (cy - (after.top + my * after.size)) / after.size
      onViewRef.current({ zoom: next, panX: v.panX + dx, panY: v.panY + dy })
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top

    if (drag.current) {
      const size = Math.min(rect.width, rect.height) * view.zoom
      onView({
        zoom: view.zoom,
        panX: drag.current.panX + (e.clientX - drag.current.x) / size,
        panY: drag.current.panY + (e.clientY - drag.current.y) / size,
      })
      setHover(null)
      return
    }

    const r = mapRect(rect.width, rect.height, view)
    const [mx, my] = canvasToMap(cx, cy, r)
    if (mx >= 0 && mx <= 1 && my >= 0 && my <= 1) {
      const { scale, originX, originZ } = bundle.meta
      setCursorWorld({ x: mx * scale + originX, z: (1 - my) * scale + originZ })
    } else setCursorWorld(null)

    const idx = pickEvent(bundle, selection, cx, cy, rect.width, rect.height, view,
                          12, props.showPositions)
    setHover(idx === null ? null : { idx, cx, cy })
  }

  const endDrag = (e: React.PointerEvent) => {
    try { (e.target as Element).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    drag.current = null
  }

  const info = hover ? describeEvent(bundle, hover.idx) : null

  return (
    <div ref={wrapRef} className="relative w-full h-full bg-ink-900 overflow-hidden">
      <canvas
        ref={canvasRef}
        className={`w-full h-full block ${drag.current ? 'cursor-grabbing' : 'cursor-crosshair'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={(e) => { endDrag(e); setHover(null); setCursorWorld(null) }}
      />

      {/* zoom / reset controls */}
      <div className="absolute top-3 right-3 flex flex-col gap-1">
        {([['+', 1.4], ['−', 1 / 1.4]] as const).map(([sym, f]) => (
          <button
            key={sym}
            onClick={() => onView({ ...view, zoom: Math.max(1, Math.min(14, view.zoom * f)) })}
            className="w-7 h-7 panel grid place-items-center text-slate-300 hover:text-white hover:bg-ink-600"
            aria-label={sym === '+' ? 'Zoom in' : 'Zoom out'}
          >{sym}</button>
        ))}
        <button
          onClick={() => onView({ zoom: 1, panX: 0, panY: 0 })}
          className="w-7 h-7 panel grid place-items-center text-[9px] font-semibold text-slate-300 hover:text-white hover:bg-ink-600"
          title="Reset view"
        >FIT</button>
      </div>

      {/* world-coordinate readout — lets a designer cross-check against the editor */}
      {cursorWorld && (
        <div className="absolute bottom-3 left-3 panel px-2 py-1 text-[10px] num text-slate-400 pointer-events-none">
          x {cursorWorld.x.toFixed(1)} · z {cursorWorld.z.toFixed(1)}
          <span className="text-slate-600 ml-2">{Math.round(view.zoom * 100)}%</span>
        </div>
      )}

      {info && hover && (
        <div
          className="absolute z-20 panel bg-ink-900/95 px-2.5 py-2 text-[11px] pointer-events-none shadow-xl"
          style={{
            left: Math.min(hover.cx + 14, (wrapRef.current?.clientWidth ?? 0) - 210),
            top: Math.max(8, hover.cy - 10),
            width: 200,
          }}
        >
          <div className="flex items-center gap-1.5 font-semibold text-white">
            <span className="w-2 h-2 rounded-full" style={{ background: info.color }} />
            {info.name}
          </div>
          <dl className="mt-1.5 space-y-0.5 text-slate-400">
            <Row k="Actor" v={info.player?.bot ? 'Bot' : 'Human'} />
            <Row k="ID" v={shortId(info.player?.id ?? '—', 10)} />
            <Row k="Match" v={shortId(info.match?.id ?? '—', 10)} />
            <Row k="Time" v={fmtClock(info.t)} />
            <Row k="World" v={`${info.x.toFixed(0)}, ${info.z.toFixed(0)}`} />
            <Row k="Elev" v={info.y.toFixed(1)} />
          </dl>
        </div>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-slate-500">{k}</dt>
      <dd className="num text-slate-300 truncate">{v}</dd>
    </div>
  )
}
