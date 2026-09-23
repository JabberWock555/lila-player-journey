/**
 * Density fields rendered to an offscreen canvas.
 *
 * Approach: accumulate points into a coarse float grid, blur it with a
 * separable box pass (cheap approximation of a Gaussian), normalise against a
 * high percentile so a handful of extreme cells cannot flatten the rest, then
 * map through a colour ramp into ImageData. The canvas is drawn scaled up over
 * the minimap, which gives smooth falloff without per-point compositing.
 */

/** A colour ramp is a list of hex stops, dark -> hot, from dataset.json. */
export type Ramp = string[]

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const rampCache = new Map<string, [number, number, number][]>()

/** Hex stops -> RGB triples, memoised since ramps are stable per session. */
function rgbStops(ramp: Ramp): [number, number, number][] {
  const key = ramp.join(',')
  let hit = rampCache.get(key)
  if (!hit) {
    hit = ramp.length ? ramp.map(hexToRgb) : [[0, 0, 0], [255, 255, 255]]
    rampCache.set(key, hit)
  }
  return hit
}

function sample(ramp: [number, number, number][], t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t))
  const pos = clamped * (ramp.length - 1)
  const i = Math.min(ramp.length - 2, Math.floor(pos))
  const f = pos - i
  const a = ramp[i]
  const b = ramp[i + 1]
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ]
}

/** In-place separable box blur over a square float grid. */
function blur(grid: Float32Array, size: number, radius: number) {
  if (radius < 1) return
  const tmp = new Float32Array(grid.length)
  const width = radius * 2 + 1

  for (let y = 0; y < size; y++) {
    const row = y * size
    let acc = 0
    for (let x = -radius; x <= radius; x++) acc += grid[row + Math.min(size - 1, Math.max(0, x))]
    for (let x = 0; x < size; x++) {
      tmp[row + x] = acc / width
      const out = row + Math.min(size - 1, Math.max(0, x - radius))
      const inc = row + Math.min(size - 1, Math.max(0, x + radius + 1))
      acc += grid[inc] - grid[out]
    }
  }

  for (let x = 0; x < size; x++) {
    let acc = 0
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(size - 1, Math.max(0, y)) * size + x]
    for (let y = 0; y < size; y++) {
      grid[y * size + x] = acc / width
      const out = Math.min(size - 1, Math.max(0, y - radius)) * size + x
      const inc = Math.min(size - 1, Math.max(0, y + radius + 1)) * size + x
      acc += tmp[inc] - tmp[out]
    }
  }
}

export interface HeatOptions {
  /** grid resolution; 256 is a good balance of detail and speed */
  size?: number
  /** blur radius in grid cells */
  radius?: number
  /** percentile used as the top of the colour range (0..1) */
  clip?: number
  /** gamma < 1 lifts low-density areas so faint traffic stays visible */
  gamma?: number
  /** colour stops; defaults to greyscale if omitted */
  ramp?: Ramp
  /** hide cells below this fraction of max, so empty map stays transparent */
  floor?: number
  opacity?: number
}

export interface HeatResult {
  canvas: HTMLCanvasElement
  /** peak density per grid cell, for the legend */
  peak: number
  /** number of points accumulated */
  count: number
}

/**
 * @param us normalised x in 0..1
 * @param vs normalised y in 0..1 (world-space; flipped here for the image)
 */
export function buildHeatmap(
  us: ArrayLike<number>,
  vs: ArrayLike<number>,
  count: number,
  opts: HeatOptions = {},
): HeatResult {
  const size = opts.size ?? 256
  const radius = opts.radius ?? 6
  const clip = opts.clip ?? 0.99
  const gamma = opts.gamma ?? 0.55
  const floor = opts.floor ?? 0.04
  const opacity = opts.opacity ?? 1
  const ramp = rgbStops(opts.ramp ?? [])

  const grid = new Float32Array(size * size)
  for (let i = 0; i < count; i++) {
    const u = us[i]
    const v = vs[i]
    if (u < 0 || u > 1 || v < 0 || v > 1) continue
    // v is world-space (up); the image origin is top-left, so flip here.
    const gx = Math.min(size - 1, (u * size) | 0)
    const gy = Math.min(size - 1, ((1 - v) * size) | 0)
    grid[gy * size + gx] += 1
  }

  blur(grid, size, radius)

  // Normalise against a high percentile rather than the raw max: one very hot
  // spawn cell would otherwise wash the whole field out to near-zero.
  const nonZero: number[] = []
  let peak = 0
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > 0) nonZero.push(grid[i])
    if (grid[i] > peak) peak = grid[i]
  }
  nonZero.sort((a, b) => a - b)
  const top = nonZero.length
    ? nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * clip))]
    : 1
  const scale = top > 0 ? top : 1

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)

  for (let i = 0; i < grid.length; i++) {
    const norm = Math.min(1, grid[i] / scale)
    const p = i * 4
    if (norm <= floor) {
      img.data[p + 3] = 0
      continue
    }
    const t = Math.pow((norm - floor) / (1 - floor), gamma)
    const [r, g, b] = sample(ramp, t)
    img.data[p] = r
    img.data[p + 1] = g
    img.data[p + 2] = b
    // Ramp alpha in over the low end so hot cores read as solid.
    img.data[p + 3] = Math.min(255, 255 * Math.min(1, t * 1.6) * opacity)
  }

  ctx.putImageData(img, 0, 0)
  return { canvas, peak, count }
}

/**
 * Which grid cells are land, read from the minimap itself: not the near-black
 * void around the island and not open water. Cached per image.
 *
 * This replaced an earlier "within N cells of anywhere visited" proxy, which
 * counted a halo over the void and Lockdown's whole sea as unvisited playable
 * area — it nearly doubled Ambrose Valley's figure (41% vs 22%).
 * Mirrors land_mask() in the analysis scripts; keep the thresholds in step.
 */
const landCache = new WeakMap<HTMLImageElement, Map<number, Uint8Array>>()
const SUB = 8

export function landMaskFromImage(image: HTMLImageElement, size: number): Uint8Array {
  let bySize = landCache.get(image)
  const hit = bySize?.get(size)
  if (hit) return hit

  const px = size * SUB
  const c = document.createElement('canvas')
  c.width = px
  c.height = px
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0, px, px)
  const d = ctx.getImageData(0, 0, px, px).data

  const landCount = new Uint16Array(size * size)
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const i = (y * px + x) * 4
      const r = d[i], g = d[i + 1], b = d[i + 2]
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      const voidPx = lum < 28
      const water = b > r + 35 && g > r + 25 && lum > 40
      if (!voidPx && !water) landCount[((y / SUB) | 0) * size + ((x / SUB) | 0)]++
    }
  }
  const mask = new Uint8Array(size * size)
  const half = (SUB * SUB) / 2
  let land = 0
  for (let i = 0; i < mask.length; i++) {
    if (landCount[i] > half) { mask[i] = 1; land++ }
  }
  // A minimap without a dark background would classify as all-land or none;
  // signal that so the caller can fall back rather than report nonsense.
  const frac = land / mask.length
  const result = frac < 0.1 || frac > 0.95 ? new Uint8Array(0) : mask

  if (!bySize) { bySize = new Map(); landCache.set(image, bySize) }
  bySize.set(size, result)
  return result
}

/** Shrink a mask by `k` cells, so what remains is at least `k` cells from its edge. */
function erode(mask: Uint8Array, size: number, k: number): Uint8Array {
  let cur = mask
  for (let n = 0; n < k; n++) {
    const next = new Uint8Array(cur.length)
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x
        next[i] = cur[i] & cur[i - 1] & cur[i + 1] & cur[i - size] & cur[i + size]
      }
    }
    cur = next
  }
  return cur
}

export interface Coverage {
  canvas: HTMLCanvasElement
  /** walkable cells with zero traffic */
  coldCells: number
  /** walkable cells: land on the minimap, plus anywhere someone actually stood */
  playableCells: number
  /** same ratio for cells at least `coastCells` from the coastline */
  interiorCold: number
  interiorCells: number
  /** how walkable area was determined */
  basis: 'minimap' | 'traffic-footprint'
}

/**
 * "Dead space": walkable parts of the map nobody entered.
 *
 * Walkable = land on the minimap (void and open water excluded) plus any cell
 * someone actually stood in — traffic proves walkability even where the image
 * is dark. The interior figure drops cells near the coastline, which is often
 * cliff or decorative edge rather than reachable ground, so the two numbers
 * bracket the real value.
 *
 * Falls back to the old traffic-footprint proxy when the minimap cannot be
 * read as land vs. background.
 */
export function buildColdmap(
  us: ArrayLike<number>,
  vs: ArrayLike<number>,
  count: number,
  opts: { size?: number; reach?: number; opacity?: number; image?: HTMLImageElement; coastCells?: number } = {},
): Coverage {
  const size = opts.size ?? 96
  const reach = opts.reach ?? 6
  const opacity = opts.opacity ?? 0.55
  const coast = opts.coastCells ?? 3

  const visited = new Uint8Array(size * size)
  for (let i = 0; i < count; i++) {
    const u = us[i]
    const v = vs[i]
    if (u < 0 || u > 1 || v < 0 || v > 1) continue
    const gx = Math.min(size - 1, (u * size) | 0)
    const gy = Math.min(size - 1, ((1 - v) * size) | 0)
    visited[gy * size + gx] = 1
  }

  let walkable: Uint8Array
  let basis: Coverage['basis'] = 'minimap'
  const land = opts.image ? landMaskFromImage(opts.image, size) : new Uint8Array(0)
  if (land.length) {
    walkable = new Uint8Array(size * size)
    for (let i = 0; i < walkable.length; i++) walkable[i] = land[i] | visited[i]
  } else {
    basis = 'traffic-footprint'
    const reachable = new Float32Array(size * size)
    for (let i = 0; i < reachable.length; i++) reachable[i] = visited[i]
    blur(reachable, size, reach)
    walkable = new Uint8Array(size * size)
    for (let i = 0; i < walkable.length; i++) walkable[i] = reachable[i] > 0.02 ? 1 : 0
  }
  const interior = erode(walkable, size, coast)

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)

  let coldCells = 0, playableCells = 0, interiorCold = 0, interiorCells = 0
  for (let i = 0; i < walkable.length; i++) {
    if (!walkable[i]) continue
    playableCells++
    if (interior[i]) interiorCells++
    if (visited[i]) continue
    coldCells++
    if (interior[i]) interiorCold++
    img.data[i * 4] = 90
    img.data[i * 4 + 1] = 120
    img.data[i * 4 + 2] = 255
    // Coastal rim drawn fainter: it is the less certain part of the figure.
    img.data[i * 4 + 3] = 255 * opacity * (interior[i] ? 1 : 0.45)
  }

  ctx.putImageData(img, 0, 0)
  return { canvas, coldCells, playableCells, interiorCold, interiorCells, basis }
}
