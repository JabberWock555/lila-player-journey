/**
 * Density fields rendered to an offscreen canvas.
 *
 * Approach: accumulate points into a coarse float grid, blur it with a
 * separable box pass (cheap approximation of a Gaussian), normalise against a
 * high percentile so a handful of extreme cells cannot flatten the rest, then
 * map through a colour ramp into ImageData. The canvas is drawn scaled up over
 * the minimap, which gives smooth falloff without per-point compositing.
 */

export type Ramp = 'traffic' | 'kill' | 'death' | 'loot' | 'storm'

const RAMPS: Record<Ramp, [number, number, number][]> = {
  // dark blue -> cyan -> lime -> amber -> white
  traffic: [[8, 20, 60], [16, 90, 160], [30, 190, 190], [150, 230, 90], [255, 220, 90], [255, 255, 245]],
  // deep red -> orange -> white hot
  kill: [[40, 0, 10], [130, 10, 40], [220, 40, 60], [255, 130, 60], [255, 230, 160], [255, 255, 255]],
  // violet -> magenta -> pale
  death: [[24, 6, 44], [78, 20, 120], [150, 44, 190], [214, 100, 224], [244, 190, 250], [255, 255, 255]],
  // dark green -> lime -> pale
  loot: [[4, 30, 16], [12, 84, 44], [30, 150, 70], [110, 210, 90], [200, 245, 150], [255, 255, 235]],
  // brown -> yellow -> white
  storm: [[40, 30, 0], [110, 84, 6], [190, 150, 20], [235, 200, 60], [250, 235, 160], [255, 255, 255]],
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
  const ramp = RAMPS[opts.ramp ?? 'traffic']

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
 * "Cold spots": areas of the playable map that see (almost) no traffic.
 * Playable area is approximated as the convex-ish footprint of all traffic —
 * we mark a cell cold when it is empty but sits within `reach` cells of
 * somewhere that was visited, which keeps the off-map void out of the result.
 */
export function buildColdmap(
  us: ArrayLike<number>,
  vs: ArrayLike<number>,
  count: number,
  opts: { size?: number; reach?: number; opacity?: number } = {},
): { canvas: HTMLCanvasElement; coldCells: number; playableCells: number } {
  const size = opts.size ?? 96
  const reach = opts.reach ?? 6
  const opacity = opts.opacity ?? 0.55

  const hits = new Float32Array(size * size)
  for (let i = 0; i < count; i++) {
    const u = us[i]
    const v = vs[i]
    if (u < 0 || u > 1 || v < 0 || v > 1) continue
    const gx = Math.min(size - 1, (u * size) | 0)
    const gy = Math.min(size - 1, ((1 - v) * size) | 0)
    hits[gy * size + gx] += 1
  }

  // Dilate the visited mask to estimate the playable footprint.
  const reachable = new Float32Array(hits.length)
  for (let i = 0; i < hits.length; i++) reachable[i] = hits[i] > 0 ? 1 : 0
  blur(reachable, size, reach)

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)

  let coldCells = 0
  let playableCells = 0
  for (let i = 0; i < hits.length; i++) {
    const inPlayable = reachable[i] > 0.02
    if (!inPlayable) {
      img.data[i * 4 + 3] = 0
      continue
    }
    playableCells++
    if (hits[i] > 0) {
      img.data[i * 4 + 3] = 0
      continue
    }
    coldCells++
    img.data[i * 4] = 90
    img.data[i * 4 + 1] = 120
    img.data[i * 4 + 2] = 255
    img.data[i * 4 + 3] = 255 * opacity
  }

  ctx.putImageData(img, 0, 0)
  return { canvas, coldCells, playableCells }
}
