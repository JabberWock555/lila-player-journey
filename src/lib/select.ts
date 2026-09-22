/**
 * Turns the UI filter state into concrete index sets over a map's event arrays.
 * Everything downstream (heatmaps, paths, markers, stats) reads these.
 */

import {
  DEATH_CODES, EV, KILL_CODES, LAYER_OF_CODE, POSITION_CODES,
  type Layer, type MapBundle, type JourneyMeta,
} from './types'

export interface Filters {
  /** ISO dates to keep; empty = all */
  days: Set<string>
  /** match ids to keep; empty = all */
  matchIds: Set<string>
  showHumans: boolean
  showBots: boolean
  layers: Record<Layer, boolean>
}

export const defaultFilters = (): Filters => ({
  days: new Set(),
  matchIds: new Set(),
  showHumans: true,
  showBots: true,
  layers: { kill: true, death: true, loot: true, storm: true },
})

export interface Selection {
  /** journeys passing the match/day/actor filters */
  journeys: JourneyMeta[]
  /** all event indices belonging to those journeys */
  indices: Uint32Array
  /** position-sample indices only (traffic heatmap + paths) */
  positions: Uint32Array
  /** discrete event indices by semantic layer */
  byLayer: Record<Layer, Uint32Array>
  /** inclusive match-time bounds across the selection */
  tMin: number
  tMax: number
  stats: SelectionStats
}

export interface SelectionStats {
  journeys: number
  humanJourneys: number
  botJourneys: number
  matches: number
  events: number
  kills: number
  deaths: number
  loot: number
  storm: number
  /** share of human journeys that end in a death of any kind */
  deathRate: number
  medianDurationSec: number
}

const EMPTY = new Uint32Array(0)

export function selectEvents(bundle: MapBundle, f: Filters): Selection {
  const { meta, events } = bundle
  const matchOk = (m: number) => {
    const match = meta.matches[m]
    if (!match) return false
    if (f.days.size && !f.days.has(match.day)) return false
    if (f.matchIds.size && !f.matchIds.has(match.id)) return false
    return true
  }

  const journeys = meta.journeys.filter((j) => {
    if (!matchOk(j.m)) return false
    const isBot = meta.players[j.p]?.bot ?? false
    return isBot ? f.showBots : f.showHumans
  })

  let total = 0
  for (const j of journeys) total += j.n

  const indices = new Uint32Array(total)
  let k = 0
  for (const j of journeys) {
    for (let i = 0; i < j.n; i++) indices[k++] = j.o + i
  }

  // Split into position samples and the discrete layers in one pass.
  const positions: number[] = []
  const buckets: Record<Layer, number[]> = { kill: [], death: [], loot: [], storm: [] }
  let tMin = Infinity
  let tMax = -Infinity

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    const code = events.ev[idx]
    const t = events.t[idx]
    if (t < tMin) tMin = t
    if (t > tMax) tMax = t
    if (POSITION_CODES.has(code)) {
      positions.push(idx)
      continue
    }
    const layer = LAYER_OF_CODE[code]
    if (layer && f.layers[layer]) buckets[layer].push(idx)
  }

  const durations: number[] = []
  let humanJourneys = 0
  let botJourneys = 0
  let deaths = 0
  const matchSet = new Set<number>()
  for (const j of journeys) {
    matchSet.add(j.m)
    const isBot = meta.players[j.p]?.bot ?? false
    if (isBot) botJourneys++
    else {
      humanJourneys++
      durations.push(j.t1 - j.t0)
      if (j.died) deaths++
    }
  }
  durations.sort((a, b) => a - b)

  const stats: SelectionStats = {
    journeys: journeys.length,
    humanJourneys,
    botJourneys,
    matches: matchSet.size,
    events: indices.length,
    kills: buckets.kill.length,
    deaths: buckets.death.length + buckets.storm.length,
    loot: buckets.loot.length,
    storm: buckets.storm.length,
    deathRate: humanJourneys ? deaths / humanJourneys : 0,
    medianDurationSec: durations.length ? durations[durations.length >> 1] : 0,
  }

  return {
    journeys,
    indices,
    positions: positions.length ? Uint32Array.from(positions) : EMPTY,
    byLayer: {
      kill: buckets.kill.length ? Uint32Array.from(buckets.kill) : EMPTY,
      death: buckets.death.length ? Uint32Array.from(buckets.death) : EMPTY,
      loot: buckets.loot.length ? Uint32Array.from(buckets.loot) : EMPTY,
      storm: buckets.storm.length ? Uint32Array.from(buckets.storm) : EMPTY,
    },
    tMin: Number.isFinite(tMin) ? tMin : 0,
    tMax: Number.isFinite(tMax) ? tMax : 0,
    stats,
  }
}

/** Gather u/v pairs for an index set, for the heatmap builder. */
export function gatherUV(bundle: MapBundle, idx: ArrayLike<number>) {
  const n = idx.length
  const u = new Float32Array(n)
  const v = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    u[i] = bundle.events.u[idx[i]]
    v[i] = bundle.events.v[idx[i]]
  }
  return { u, v, n }
}

/** Human-readable label for a single event index (tooltips). */
export function describeEvent(bundle: MapBundle, idx: number) {
  const { meta, events } = bundle
  const code = events.ev[idx]
  const name = (Object.keys(EV) as (keyof typeof EV)[]).find((k) => EV[k] === code) ?? 'Event'
  const player = meta.players[events.pi[idx]]
  const match = meta.matches[events.mi[idx]]
  return {
    name: name as string,
    isKill: KILL_CODES.has(code),
    isDeath: DEATH_CODES.has(code),
    player,
    match,
    t: events.t[idx],
    x: events.x[idx],
    y: events.y[idx],
    z: events.z[idx],
  }
}
