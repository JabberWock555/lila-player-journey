/** Shapes emitted by etl/build_data.py. Keep in sync with that script. */

export const EVENT_TYPES = [
  'Position', 'BotPosition', 'Loot',
  'Kill', 'Killed', 'BotKill', 'BotKilled', 'KilledByStorm',
] as const

export type EventName = (typeof EVENT_TYPES)[number]

/** Codes stored in the `ev` column of the binary. */
export const EV = Object.fromEntries(
  EVENT_TYPES.map((n, i) => [n, i]),
) as Record<EventName, number>

export const POSITION_CODES = new Set([EV.Position, EV.BotPosition])
export const KILL_CODES = new Set([EV.Kill, EV.BotKill])
export const DEATH_CODES = new Set([EV.Killed, EV.BotKilled, EV.KilledByStorm])

/** Semantic buckets the UI filters and colours by. */
export type Layer = 'kill' | 'death' | 'loot' | 'storm'

export const LAYER_OF_CODE: Record<number, Layer> = {
  [EV.Kill]: 'kill',
  [EV.BotKill]: 'kill',
  [EV.Killed]: 'death',
  [EV.BotKilled]: 'death',
  [EV.KilledByStorm]: 'storm',
  [EV.Loot]: 'loot',
}

export interface MatchMeta {
  id: string
  t0: number
  t1: number
  day: string
  humans: number
  bots: number
  events: number
  kills: number
  deaths: number
  loot: number
  storm: number
}

export interface JourneyMeta {
  /** match index */ m: number
  /** player index */ p: number
  /** offset into the map's arrays */ o: number
  /** number of events */ n: number
  t0: number
  t1: number
  loot: number
  kills: number
  died: number
  storm: number
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
  eventTypes: EventName[]
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

export interface MapBundle {
  meta: MapMeta
  events: MapEvents
  image: HTMLImageElement
}
