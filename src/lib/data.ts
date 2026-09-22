import type { DatasetConfig, Manifest, MapBundle, MapEvents, MapMeta } from './types'

const BASE = import.meta.env.BASE_URL

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${BASE}data/manifest.json`)
  if (!res.ok) throw new Error(`manifest: ${res.status}`)
  return res.json()
}

/**
 * Decode a map's `.bin` into typed-array views.
 *
 * Layout is seven contiguous blocks written in this order by the ETL:
 *   x,y,z : Float32[n]   t : Uint32[n]   ev : Uint8[n]   mi,pi : Uint16[n]
 *
 * Uint16Array/Uint32Array require their byte offset to be a multiple of the
 * element size. x/y/z/t are 4-byte blocks so everything stays aligned up to
 * `ev`, which is n bytes and can leave an odd offset — hence the copy below
 * for the two Uint16 blocks when n is odd.
 */
function decode(buf: ArrayBuffer, meta: MapMeta): MapEvents {
  const n = meta.count
  let off = 0
  const take = <T>(ctor: new (b: ArrayBuffer, o: number, l: number) => T, bytes: number): T => {
    const view = new ctor(buf, off, n)
    off += bytes * n
    return view
  }

  const x = take(Float32Array, 4)
  const y = take(Float32Array, 4)
  const z = take(Float32Array, 4)
  const t = take(Uint32Array, 4)
  const ev = take(Uint8Array, 1)

  const u16 = (start: number): Uint16Array =>
    start % 2 === 0
      ? new Uint16Array(buf, start, n)
      : new Uint16Array(buf.slice(start, start + n * 2))

  const mi = u16(off)
  const pi = u16(off + n * 2)

  // Precompute minimap-space coordinates once so render loops stay cheap.
  const u = new Float32Array(n)
  const v = new Float32Array(n)
  const { scale, originX, originZ } = meta
  for (let i = 0; i < n; i++) {
    u[i] = (x[i] - originX) / scale
    v[i] = (z[i] - originZ) / scale
  }

  return { n, x, y, z, t, ev, mi, pi, u, v }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`image: ${src}`))
    img.src = src
  })
}

const cache = new Map<string, Promise<MapBundle>>()

export function loadMap(meta: MapMeta, config: DatasetConfig): Promise<MapBundle> {
  const hit = cache.get(meta.id)
  if (hit) return hit

  const task = (async () => {
    const [buf, image] = await Promise.all([
      fetch(`${BASE}${meta.bin}`).then((r) => {
        if (!r.ok) throw new Error(`bin: ${r.status}`)
        return r.arrayBuffer()
      }),
      loadImage(`${BASE}${meta.image}`),
    ])
    return { meta, events: decode(buf, meta), image, config }
  })()

  cache.set(meta.id, task)
  return task
}
