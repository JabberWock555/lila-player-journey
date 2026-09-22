/**
 * In-browser telemetry import.
 *
 * Parses dropped `.nakama-0` parquet files and applies exactly the same
 * normalisation rules as `etl/build_data.py`, so an imported day behaves
 * identically to a day that went through the pipeline:
 *
 *   · `ts` is a Unix timestamp in *seconds* stored in a millisecond column
 *   · bots are identified by `user_id` shape, never by event name
 *   · the `.nakama-N` server-instance suffix is stripped from `match_id`
 *   · only redundant duplicate *position* samples are dropped; repeated
 *     discrete events are real (a container yielding several items)
 *
 * hyparquet is loaded on demand so its ~300 kB never reaches anyone who does
 * not open the import panel.
 */

import type { DatasetConfig, MapBundle, MapMeta, MatchMeta, JourneyMeta } from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RawEvent {
  user_id: string
  match_id: string
  map_id: string
  x: number
  y: number
  z: number
  /** Unix seconds */
  t: number
  event: string
}

export interface ImportReport {
  files: number
  filesFailed: { name: string; error: string }[]
  rows: number
  dropped: number
  unknownEvents: string[]
  unmappedMaps: string[]
  byMap: Record<string, number>
  days: string[]
  outOfBounds: number
}

export interface ImportResult {
  report: ImportReport
  /** normalised events grouped by map id */
  byMap: Map<string, RawEvent[]>
}

const decodeText = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder().decode(v)
  return String(v ?? '')
}

/** The `ts` column decodes to a Date whose epoch-ms value is really seconds. */
const toUnixSeconds = (v: unknown): number => {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'number') return v
  return Number(v)
}

export async function parseFiles(
  files: File[],
  config: DatasetConfig,
  maps: Record<string, MapMeta>,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const { parquetReadObjects } = await import('hyparquet')
  const { compressors } = await import('hyparquet-compressors')

  const known = new Set(config.eventTypes)
  const unknownEvents = new Set<string>()
  const unmappedMaps = new Set<string>()
  const filesFailed: { name: string; error: string }[] = []
  const all: RawEvent[] = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    try {
      const buf = await file.arrayBuffer()
      const rows = (await parquetReadObjects({ file: buf, compressors })) as Record<string, unknown>[]
      for (const r of rows) {
        const event = decodeText(r.event)
        if (!known.has(event)) { unknownEvents.add(event); continue }
        const map_id = decodeText(r.map_id)
        if (!maps[map_id]) { unmappedMaps.add(map_id); continue }
        all.push({
          user_id: decodeText(r.user_id),
          // strip the server-instance suffix so ids join with the filename
          match_id: decodeText(r.match_id).replace(/\.nakama-\d+$/, ''),
          map_id,
          x: Number(r.x), y: Number(r.y), z: Number(r.z),
          t: toUnixSeconds(r.ts),
          event,
        })
      }
    } catch (e) {
      filesFailed.push({ name: file.name, error: e instanceof Error ? e.message : String(e) })
    }
    onProgress?.(i + 1, files.length)
    // Yield so the progress bar can paint between files.
    if (i % 12 === 0) await new Promise((r) => setTimeout(r, 0))
  }

  const rawRows = all.length

  // Drop only redundant position samples — see the module docstring.
  const seen = new Set<string>()
  const kept: RawEvent[] = []
  for (const e of all) {
    if (config.positionCodes.has(config.eventTypes.indexOf(e.event))) {
      const key = `${e.user_id}|${e.match_id}|${e.t}|${e.event}|${e.x}|${e.y}|${e.z}`
      if (seen.has(key)) continue
      seen.add(key)
    }
    kept.push(e)
  }

  kept.sort((a, b) =>
    a.map_id.localeCompare(b.map_id) ||
    a.match_id.localeCompare(b.match_id) ||
    a.user_id.localeCompare(b.user_id) ||
    a.t - b.t)

  const byMap = new Map<string, RawEvent[]>()
  const days = new Set<string>()
  let outOfBounds = 0
  for (const e of kept) {
    let list = byMap.get(e.map_id)
    if (!list) { list = []; byMap.set(e.map_id, list) }
    list.push(e)
    days.add(new Date(e.t * 1000).toISOString().slice(0, 10))
    const m = maps[e.map_id]
    const u = (e.x - m.originX) / m.scale
    const v = (e.z - m.originZ) / m.scale
    if (u < 0 || u > 1 || v < 0 || v > 1) outOfBounds++
  }

  return {
    report: {
      files: files.length - filesFailed.length,
      filesFailed,
      rows: kept.length,
      dropped: rawRows - kept.length,
      unknownEvents: [...unknownEvents],
      unmappedMaps: [...unmappedMaps],
      byMap: Object.fromEntries([...byMap].map(([k, v]) => [k, v.length])),
      days: [...days].sort(),
      outOfBounds: kept.length ? outOfBounds / kept.length : 0,
    },
    byMap,
  }
}

/**
 * Turn normalised events into the same struct-of-arrays bundle the ETL emits,
 * so imported data flows through selection and rendering unchanged.
 */
export function buildBundle(
  mapMeta: MapMeta,
  events: RawEvent[],
  config: DatasetConfig,
  image: HTMLImageElement,
): MapBundle {
  const matchIds: string[] = []
  const matchIndex = new Map<string, number>()
  const playerIds: string[] = []
  const playerIndex = new Map<string, number>()

  for (const e of events) {
    if (!matchIndex.has(e.match_id)) {
      matchIndex.set(e.match_id, matchIds.length)
      matchIds.push(e.match_id)
    }
    if (!playerIndex.has(e.user_id)) {
      playerIndex.set(e.user_id, playerIds.length)
      playerIds.push(e.user_id)
    }
  }

  const n = events.length
  const x = new Float32Array(n)
  const y = new Float32Array(n)
  const z = new Float32Array(n)
  const t = new Uint32Array(n)
  const ev = new Uint8Array(n)
  const mi = new Uint16Array(n)
  const pi = new Uint16Array(n)
  const u = new Float32Array(n)
  const v = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const e = events[i]
    x[i] = e.x; y[i] = e.y; z[i] = e.z
    t[i] = e.t
    ev[i] = config.eventTypes.indexOf(e.event)
    mi[i] = matchIndex.get(e.match_id)!
    pi[i] = playerIndex.get(e.user_id)!
    u[i] = (e.x - mapMeta.originX) / mapMeta.scale
    v[i] = (e.z - mapMeta.originZ) / mapMeta.scale
  }

  // Journeys: events are already sorted by (match, player, time).
  const journeys: JourneyMeta[] = []
  let start = 0
  const deathLayers = new Set(['death', 'storm'])
  for (let i = 1; i <= n; i++) {
    const boundary = i === n || mi[i] !== mi[start] || pi[i] !== pi[start]
    if (!boundary) continue
    let died = 0
    for (let k = start; k < i; k++) {
      const layer = config.layerOfCode[ev[k]]
      if (layer && deathLayers.has(layer)) { died = 1; break }
    }
    journeys.push({ m: mi[start], p: pi[start], o: start, n: i - start, t0: t[start], t1: t[i - 1], died })
    start = i
  }

  // Match summaries.
  const matches: MatchMeta[] = matchIds.map((id, index) => {
    const layers: Record<string, number> = {}
    let t0 = Infinity, t1 = -Infinity, count = 0
    const humans = new Set<number>(), bots = new Set<number>()
    for (let i = 0; i < n; i++) {
      if (mi[i] !== index) continue
      count++
      if (t[i] < t0) t0 = t[i]
      if (t[i] > t1) t1 = t[i]
      const layer = config.layerOfCode[ev[i]]
      if (layer) layers[layer] = (layers[layer] ?? 0) + 1
      ;(UUID_RE.test(playerIds[pi[i]]) ? humans : bots).add(pi[i])
    }
    return {
      id, t0, t1,
      day: new Date(t0 * 1000).toISOString().slice(0, 10),
      humans: humans.size,
      bots: bots.size,
      events: count,
      layers,
    }
  })

  const meta: MapMeta = {
    ...mapMeta,
    count: n,
    matches,
    journeys,
    players: playerIds.map((id) => ({ id, bot: !UUID_RE.test(id) })),
    elevation: [Math.min(...y), Math.max(...y)],
  }

  return { meta, events: { n, x, y, z, t, ev, mi, pi, u, v }, image, config }
}
