/**
 * Canvas 2D renderer for the minimap view.
 *
 * All drawing happens in "map space": a unit square that matches the minimap
 * image, with (0,0) at the top-left pixel. World -> map space is
 *
 *     mx = (x - originX) / scale
 *     my = 1 - (z - originZ) / scale      // image Y grows downward
 *
 * A single view transform (pan + zoom) then maps that unit square onto the
 * canvas, so every layer stays registered no matter how the user navigates.
 */

import type { MapBundle, MarkerShape } from './types'
import type { Selection } from './select'

export interface View {
  /** zoom factor; 1 = map fits the canvas */
  zoom: number
  /** pan offset in map-space units */
  panX: number
  panY: number
}

export const IDENTITY_VIEW: View = { zoom: 1, panX: 0, panY: 0 }

/** Actor colours are structural (human vs bot), not per-layer, so they stay here. */
export const ACTOR_COLORS = { human: '#38bdf8', bot: '#f59e0b' }

/** Square of canvas pixels the unit map square occupies, given the view. */
export function mapRect(width: number, height: number, view: View) {
  const size = Math.min(width, height) * view.zoom
  const left = (width - size) / 2 + view.panX * size
  const top = (height - size) / 2 + view.panY * size
  return { left, top, size }
}

export function mapToCanvas(mx: number, my: number, r: ReturnType<typeof mapRect>) {
  return [r.left + mx * r.size, r.top + my * r.size] as const
}

export function canvasToMap(cx: number, cy: number, r: ReturnType<typeof mapRect>) {
  return [(cx - r.left) / r.size, (cy - r.top) / r.size] as const
}

export interface RenderLayers {
  heat?: HTMLCanvasElement | null
  cold?: HTMLCanvasElement | null
}

export interface RenderOpts {
  bundle: MapBundle
  selection: Selection
  view: View
  layers: RenderLayers
  /** dim the base minimap so overlays read clearly */
  mapBrightness: number
  showPaths: boolean
  pathOpacity: number
  showMarkers: boolean
  markerScale: number
  /** draw every position sample as an actor-coloured dot */
  showPositions: boolean
  positionScale: number
  /** playback cursor, in unix seconds; null = show everything */
  playhead: number | null
  /** trail length behind the playhead, in seconds */
  trailSec: number
  /** journey index highlighted by hover/selection, or null */
  focusJourney: number | null
  hoverIndex: number | null
}

export function render(canvas: HTMLCanvasElement, o: RenderOpts) {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr
    canvas.height = height * dpr
  }

  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#08090c'
  ctx.fillRect(0, 0, width, height)

  const r = mapRect(width, height, o.view)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // --- base minimap -------------------------------------------------------
  ctx.globalAlpha = o.mapBrightness
  ctx.drawImage(o.bundle.image, r.left, r.top, r.size, r.size)
  ctx.globalAlpha = 1

  // --- density overlays ---------------------------------------------------
  if (o.layers.cold) {
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(o.layers.cold, r.left, r.top, r.size, r.size)
  }
  if (o.layers.heat) {
    ctx.globalCompositeOperation = 'screen'
    ctx.drawImage(o.layers.heat, r.left, r.top, r.size, r.size)
    ctx.globalCompositeOperation = 'source-over'
  }

  const { events, meta, config } = o.bundle
  const { timeOrigin } = o.selection
  const isPos = (code: number) => config.positionCodes.has(code)
  /** Event time rebased onto its own match's start when several are selected. */
  const relT = (idx: number) => events.t[idx] - timeOrigin[events.mi[idx]]
  const inWindow = (t: number) =>
    o.playhead === null || (t <= o.playhead && t >= o.playhead - o.trailSec)

  // --- journey paths ------------------------------------------------------
  if (o.showPaths) {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (let ji = 0; ji < o.selection.journeys.length; ji++) {
      const j = o.selection.journeys[ji]
      const isBot = meta.players[j.p]?.bot ?? false
      const focused = o.focusJourney === ji
      const dimmed = o.focusJourney !== null && !focused

      ctx.strokeStyle = isBot ? ACTOR_COLORS.bot : ACTOR_COLORS.human
      ctx.globalAlpha = (dimmed ? 0.08 : o.pathOpacity) * (isBot ? 0.85 : 1)
      ctx.lineWidth = focused ? 2.6 : isBot ? 1 : 1.4
      // Bots get a dashed stroke so they stay distinguishable for anyone who
      // cannot rely on the colour difference alone.
      ctx.setLineDash(isBot ? [5, 4] : [])

      ctx.beginPath()
      let drawing = false
      let lastT = -Infinity
      for (let i = 0; i < j.n; i++) {
        const idx = j.o + i
        if (!isPos(events.ev[idx])) continue
        const t = relT(idx)
        if (!inWindow(t)) {
          drawing = false
          continue
        }
        const [cx, cy] = mapToCanvas(events.u[idx], 1 - events.v[idx], r)
        // Break the line across sampling gaps so teleports/respawns do not
        // draw a false straight line across the map.
        if (!drawing || t - lastT > 25) ctx.moveTo(cx, cy)
        else ctx.lineTo(cx, cy)
        drawing = true
        lastT = t
      }
      ctx.stroke()

      // Head marker at the player's live position during playback.
      if (o.playhead !== null && !dimmed) {
        let headIdx = -1
        for (let i = j.n - 1; i >= 0; i--) {
          const idx = j.o + i
          if (!isPos(events.ev[idx])) continue
          if (relT(idx) <= o.playhead) { headIdx = idx; break }
        }
        if (headIdx >= 0 && relT(headIdx) >= o.playhead - o.trailSec) {
          const [cx, cy] = mapToCanvas(events.u[headIdx], 1 - events.v[headIdx], r)
          ctx.setLineDash([])
          ctx.globalAlpha = 1
          ctx.beginPath()
          ctx.arc(cx, cy, focused ? 5 : 3.5, 0, Math.PI * 2)
          ctx.fillStyle = isBot ? ACTOR_COLORS.bot : ACTOR_COLORS.human
          ctx.fill()
          ctx.lineWidth = 1.5
          ctx.strokeStyle = 'rgba(0,0,0,0.65)'
          ctx.stroke()
        }
      }
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  // --- actor position markers ---------------------------------------------
  // Where players actually stood, as dots rather than a line. This is the view
  // that answers "show me every human on this map" with paths turned off.
  if (o.showPositions) {
    const r2 = o.positionScale
    for (let ji = 0; ji < o.selection.journeys.length; ji++) {
      const j = o.selection.journeys[ji]
      const isBot = meta.players[j.p]?.bot ?? false
      const dimmed = o.focusJourney !== null && o.focusJourney !== ji
      ctx.fillStyle = isBot ? ACTOR_COLORS.bot : ACTOR_COLORS.human
      ctx.globalAlpha = dimmed ? 0.06 : 0.75
      for (let i = 0; i < j.n; i++) {
        const idx = j.o + i
        if (!isPos(events.ev[idx])) continue
        if (!inWindow(relT(idx))) continue
        const [cx, cy] = mapToCanvas(events.u[idx], 1 - events.v[idx], r)
        if (cx < -10 || cy < -10 || cx > width + 10 || cy > height + 10) continue
        ctx.beginPath()
        ctx.arc(cx, cy, r2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  // --- discrete event markers --------------------------------------------
  if (o.showMarkers) {
    // Draw densest layers first so rarer, more important events land on top.
    const order = [...o.bundle.config.layerIds].sort(
      (a, b) => (o.selection.byLayer[b]?.length ?? 0) - (o.selection.byLayer[a]?.length ?? 0),
    )
    for (const layer of order) {
      const idxs = o.selection.byLayer[layer]
      if (!idxs?.length) continue
      const def = o.bundle.config.layers[layer]
      ctx.fillStyle = def?.color ?? '#94a3b8'
      ctx.strokeStyle = def?.color ?? '#94a3b8'
      const shape = def?.marker ?? 'dot'
      for (let i = 0; i < idxs.length; i++) {
        const idx = idxs[i]
        if (!inWindow(relT(idx))) continue
        const [cx, cy] = mapToCanvas(events.u[idx], 1 - events.v[idx], r)
        if (cx < -20 || cy < -20 || cx > width + 20 || cy > height + 20) continue
        drawMarker(ctx, shape, cx, cy, o.markerScale)
      }
    }
  }

  // --- hover highlight ----------------------------------------------------
  if (o.hoverIndex !== null) {
    const idx = o.hoverIndex
    const [cx, cy] = mapToCanvas(events.u[idx], 1 - events.v[idx], r)
    ctx.beginPath()
    ctx.arc(cx, cy, 11, 0, Math.PI * 2)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.globalAlpha = 0.9
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // --- map frame ----------------------------------------------------------
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 1
  ctx.strokeRect(r.left + 0.5, r.top + 0.5, r.size - 1, r.size - 1)
}

/**
 * Each layer gets a distinct *shape* as well as a distinct colour, so the map
 * stays readable in greyscale and when markers overlap. Shapes come from
 * `marker` in dataset.json; an unrecognised value falls back to a dot so a
 * newly configured layer is always visible rather than silently missing.
 */
function drawMarker(
  ctx: CanvasRenderingContext2D,
  shape: MarkerShape,
  cx: number,
  cy: number,
  scale: number,
) {
  const s = scale
  ctx.save()
  ctx.translate(cx, cy)
  ctx.globalAlpha = 0.92
  ctx.lineWidth = Math.max(1, s * 0.34)

  switch (shape) {
    case 'star': {
      ctx.beginPath()
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI / 4) * i - Math.PI / 2
        const rad = i % 2 === 0 ? s * 1.25 : s * 0.45
        const px = Math.cos(a) * rad
        const py = Math.sin(a) * rad
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'cross': {
      const d = s * 1.05
      ctx.beginPath()
      ctx.moveTo(-d, -d); ctx.lineTo(d, d)
      ctx.moveTo(d, -d); ctx.lineTo(-d, d)
      ctx.stroke()
      break
    }
    case 'diamond': {
      const d = s * 0.95
      ctx.beginPath()
      ctx.moveTo(0, -d); ctx.lineTo(d, 0); ctx.lineTo(0, d); ctx.lineTo(-d, 0)
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'triangle': {
      const d = s * 1.15
      ctx.beginPath()
      ctx.moveTo(0, -d); ctx.lineTo(d * 0.92, d * 0.72); ctx.lineTo(-d * 0.92, d * 0.72)
      ctx.closePath()
      ctx.fill()
      break
    }
    default: {
      ctx.beginPath()
      ctx.arc(0, 0, s * 0.9, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
}

/**
 * Nearest event to a canvas point, within `radius` px. Discrete events always
 * win over position samples — a kill marker sitting on the path that produced
 * it should be what you get when you hover it.
 */
export function pickEvent(
  bundle: MapBundle,
  selection: Selection,
  cx: number,
  cy: number,
  width: number,
  height: number,
  view: View,
  radius = 12,
  includePositions = false,
): number | null {
  const r = mapRect(width, height, view)
  const { events } = bundle
  let best: number | null = null
  let bestDist = radius * radius

  // Rarest layers first: a storm death under a pile of loot should still win.
  const order = [...bundle.config.layerIds].sort(
    (a, b) => (selection.byLayer[a]?.length ?? 0) - (selection.byLayer[b]?.length ?? 0),
  )
  for (const layer of order) {
    const idxs = selection.byLayer[layer]
    if (!idxs?.length) continue
    for (let i = 0; i < idxs.length; i++) {
      const idx = idxs[i]
      const [px, py] = mapToCanvas(events.u[idx], 1 - events.v[idx], r)
      const dx = px - cx
      const dy = py - cy
      const d = dx * dx + dy * dy
      if (d < bestDist) {
        bestDist = d
        best = idx
      }
    }
  }
  if (best !== null || !includePositions) return best

  // Nothing discrete nearby — fall back to position samples so a player dot is
  // identifiable on hover. Tighter radius, since these are dense.
  let posDist = (radius * 0.6) ** 2
  const idxs = selection.positions
  for (let i = 0; i < idxs.length; i++) {
    const idx = idxs[i]
    const [px, py] = mapToCanvas(events.u[idx], 1 - events.v[idx], r)
    const dx = px - cx
    const dy = py - cy
    const d = dx * dx + dy * dy
    if (d < posDist) {
      posDist = d
      best = idx
    }
  }
  return best
}
