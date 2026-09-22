/**
 * Data contracts shared with etl/build_data.py.
 *
 * Nothing about event types or layers is hardcoded here — the ETL copies
 * `etl/config/dataset.json` into the manifest, and `buildDatasetConfig` below
 * turns it into the lookups the render/selection code uses. Adding an event
 * type or a layer is therefore a config change, not a code change.
 */

/** A semantic bucket an event belongs to ("kill", "death", "loot", "storm", …). */
export type Layer = string

/** Marker glyphs `render.ts` knows how to draw. Unknown values fall back to a dot. */
export type MarkerShape = 'star' | 'cross' | 'diamond' | 'triangle' | 'dot'

export interface EventDef {
  name: string
  /** null for position samples, which are drawn as paths rather than markers */
  layer: Layer | null
}

export interface LayerDef {
  label: string
  /** one-letter suffix used in the compact match list */
  badge: string
  color: string
  marker: MarkerShape
  heatLabel: string
  heatHint: string
  /** colour ramp for this layer's heatmap, dark → hot */
  ramp: string[]
}

export interface MatchMeta {
  id: string
  t0: number
  t1: number
  day: string
  humans: number
  bots: number
  events: number
  /** per-layer event counts; absent layers mean zero */
  layers: Record<Layer, number>
}

export interface JourneyMeta {
  /** match index */ m: number
  /** player index */ p: number
  /** offset into the map's arrays */ o: number
  /** number of events */ n: number
  t0: number
  t1: number
  /** 1 if this journey ends in a death of any kind */ died: number
}

export interface PlayerMeta {
  id: string
  bot: boolean
}

export interface MapMeta {
  id: string
  label: string
  scale: number
  originX: number
  originZ: number
  image: string
  bin: string
  count: number
  elevation: [number, number]
  sourceImageSize: [number, number]
  matches: MatchMeta[]
  players: PlayerMeta[]
  journeys: JourneyMeta[]
}

export interface Manifest {
  generatedAt: string
  eventTypes: string[]
  events: EventDef[]
  layers: Record<Layer, LayerDef>
  trafficRamp: string[]
  maps: MapMeta[]
  totals: {
    events: number
    matches: number
    players: number
    bots: number
    days: string[]
    eventCounts: Record<string, number>
    medianSessionSec: number
  }
}

/** Struct-of-arrays view over a map's `.bin` payload. */
export interface MapEvents {
  n: number
  x: Float32Array
  y: Float32Array
  z: Float32Array
  t: Uint32Array
  ev: Uint8Array
  mi: Uint16Array
  pi: Uint16Array
  /** normalised 0..1 minimap coords, precomputed once at load */
  u: Float32Array
  v: Float32Array
}

/**
 * Manifest config flattened into the lookups the hot paths need. Built once per
 * session; the `ev` column in the binary indexes straight into `layerOfCode`.
 */
export interface DatasetConfig {
  eventTypes: string[]
  /** event code -> layer id, or null for position samples */
  layerOfCode: (Layer | null)[]
  /** event codes that are position samples */
  positionCodes: Set<number>
  /** ordered layer ids, as declared in the config */
  layerIds: Layer[]
  layers: Record<Layer, LayerDef>
  trafficRamp: string[]
  /** convenience: layer id -> colour */
  colorOf: Record<Layer, string>
}

export function buildDatasetConfig(m: Manifest): DatasetConfig {
  const layerOfCode = m.events.map((e) => e.layer ?? null)
  const positionCodes = new Set<number>()
  layerOfCode.forEach((layer, code) => {
    if (layer === null) positionCodes.add(code)
  })
  const layerIds = Object.keys(m.layers)
  const colorOf: Record<Layer, string> = {}
  for (const id of layerIds) colorOf[id] = m.layers[id].color

  return {
    eventTypes: m.eventTypes,
    layerOfCode,
    positionCodes,
    layerIds,
    layers: m.layers,
    trafficRamp: m.trafficRamp,
    colorOf,
  }
}

export interface MapBundle {
  meta: MapMeta
  events: MapEvents
  image: HTMLImageElement
  config: DatasetConfig
}
