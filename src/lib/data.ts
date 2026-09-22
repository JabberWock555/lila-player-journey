import type { DatasetConfig, Manifest, MapBundle, MapEvents, MapMeta } from './types'

const BASE = import.meta.env.BASE_URL

/**
 * Fields the app cannot run without. The data files sit at stable paths (unlike
 * Vite's content-hashed assets), so a browser holding a cached copy from an
 * older deploy can pair an old manifest with new code. `must-revalidate` in
 * vercel.json prevents that, but a stale intermediary proxy still could — so
 * fail with something a person can act on rather than a bare TypeError.
 */
const REQUIRED_KEYS = ['eventTypes', 'events', 'layers', 'maps', 'totals'] as const

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${BASE}data/manifest.json`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`manifest: ${res.status}`)
  const json = await res.json()

  const missing = REQUIRED_KEYS.filter((k) => json?.[k] == null)
  if (missing.length) {
    throw new Error(
      `manifest is missing ${missing.join(', ')} — this usually means a cached ` +
      `copy from an older build. A hard reload (Cmd/Ctrl+Shift+R) should fix it.`,
    )
  }
  return json as Manifest
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
  // 21 bytes per event: 4+4+4 (xyz) + 4 (t) + 1 (ev) + 2+2 (mi,pi).
  const expected = n * 21
  if (buf.byteLength !== expected) {
    throw new Error(
      `${meta.id}.bin is ${buf.byteLength} bytes but the manifest describes ` +
      `${n} events (${expected} bytes) — binary and manifest are from different builds.`,
    )
  }
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
      // `no-cache` (revalidate, not re-download): the byte offsets in the
      // manifest only describe *this* build's binary, so a cached one from an
      // older deploy would render silently wrong data rather than fail.
      fetch(`${BASE}${meta.bin}`, { cache: 'no-cache' }).then((r) => {
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
