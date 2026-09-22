/**
 * Turns the UI filter state into concrete index sets over a map's event arrays.
 * Everything downstream (heatmaps, paths, markers, stats) reads these.
 *
 * Layers are whatever `etl/config/dataset.json` declares — nothing here names a
 * specific one, so adding a layer needs no change in this file.
 */

import type { JourneyMeta, Layer, MapBundle, MatchMeta } from './types'

/** Extra predicates applied to the match list, independent of the map/date scope. */
export interface MatchFilters {
  /** free-text match on the match id */
  query: string
  /** 'any' | 'died' | 'survived' — outcome of the match's human runs */
  outcome: 'any' | 'died' | 'survived'
  /** only matches containing at least one storm death */
  stormOnly: boolean
  /** only matches with at least one bot journey recorded */
  withBots: boolean
  minKills: number
  minLoot: number
  /** seconds; 0 = no floor */
  minDuration: number
  sort: 'recent' | 'longest' | 'kills' | 'loot'
}

export const defaultMatchFilters = (): MatchFilters => ({
  query: '',
  outcome: 'any',
  stormOnly: false,
  withBots: false,
  minKills: 0,
  minLoot: 0,
  minDuration: 0,
  sort: 'recent',
})

export interface Filters {
  /** ISO dates to keep; empty = all */
  days: Set<string>
  /** match ids to keep; empty = all. More than one enables synced playback. */
  matchIds: Set<string>
  showHumans: boolean
  showBots: boolean
  /** layer id -> visible. Missing keys are treated as visible. */
  layers: Record<Layer, boolean>
}

export const defaultFilters = (layerIds: Layer[] = []): Filters => ({
  days: new Set(),
  matchIds: new Set(),
  showHumans: true,
  showBots: true,
  layers: Object.fromEntries(layerIds.map((id) => [id, true])),
})

/**
 * Apply the match-list predicates. Kept here rather than in the component so the
 * "select all visible" action and the rendered list can never disagree.
 */
export function filterMatches(
  matches: MatchMeta[],
  days: Set<string>,
  f: MatchFilters,
  diedByMatch: Set<string>,
): MatchMeta[] {
  const q = f.query.trim().toLowerCase()
  const out = matches.filter((m) => {
    if (days.size && !days.has(m.day)) return false
    if (q && !m.id.toLowerCase().includes(q)) return false
    if (f.stormOnly && !(m.layers?.storm ?? 0)) return false
    if (f.withBots && m.bots === 0) return false
    if ((m.layers?.kill ?? 0) < f.minKills) return false
    if ((m.layers?.loot ?? 0) < f.minLoot) return false
    if (m.t1 - m.t0 < f.minDuration) return false
    if (f.outcome === 'died' && !diedByMatch.has(m.id)) return false
    if (f.outcome === 'survived' && diedByMatch.has(m.id)) return false
    return true
  })

  const by: Record<MatchFilters['sort'], (a: MatchMeta, b: MatchMeta) => number> = {
    recent: (a, b) => b.t0 - a.t0,
    longest: (a, b) => (b.t1 - b.t0) - (a.t1 - a.t0),
    kills: (a, b) => (b.layers?.kill ?? 0) - (a.layers?.kill ?? 0),
    loot: (a, b) => (b.layers?.loot ?? 0) - (a.layers?.loot ?? 0),
  }
  return out.sort(by[f.sort])
}

export interface Selection {
  /** journeys passing the match/day/actor filters */
  journeys: JourneyMeta[]
  /**
   * Per-match time origin, indexed by match index. Zero in absolute mode; the
   * match's own start when several matches are selected, so unrelated
   * wall-clock timelines line up and can be played together.
   */
  timeOrigin: Float64Array
  /** true when times are measured from each match's own start */
  relative: boolean
  /** all event indices belonging to those journeys */
  indices: Uint32Array
  /** position-sample indices only (traffic heatmap + paths) */
  positions: Uint32Array
  /** discrete event indices by layer id */
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
  /** per-layer event counts for the current selection */
  byLayer: Record<Layer, number>
  /** share of human journeys that end in a death of any kind */
  deathRate: number
  medianDurationSec: number
}

const EMPTY = new Uint32Array(0)

export function selectEvents(bundle: MapBundle, f: Filters): Selection {
  const { meta, events, config } = bundle

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

  // With more than one match in scope, absolute timestamps are meaningless to
  // compare — two matches an hour apart would sit at opposite ends of one bar.
  // Rebasing each match onto its own start makes "play them together" mean
  // "play them from their respective openings", which is what a designer wants.
  const matchSetForTime = new Set<number>()
  for (const j of journeys) matchSetForTime.add(j.m)
  const relative = matchSetForTime.size > 1
  const timeOrigin = new Float64Array(meta.matches.length)
  if (relative) {
    for (const mi of matchSetForTime) timeOrigin[mi] = meta.matches[mi]?.t0 ?? 0
  }

  let total = 0
  for (const j of journeys) total += j.n

  const indices = new Uint32Array(total)
  let k = 0
  for (const j of journeys) {
    for (let i = 0; i < j.n; i++) indices[k++] = j.o + i
  }

  // Split into position samples and the discrete layers in one pass.
  const positions: number[] = []
  const buckets: Record<Layer, number[]> = {}
  for (const id of config.layerIds) buckets[id] = []

  let tMin = Infinity
  let tMax = -Infinity

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    const code = events.ev[idx]
    const t = events.t[idx] - timeOrigin[events.mi[idx]]
    if (t < tMin) tMin = t
    if (t > tMax) tMax = t
    if (config.positionCodes.has(code)) {
      positions.push(idx)
      continue
    }
    const layer = config.layerOfCode[code]
    if (layer && f.layers[layer] !== false && buckets[layer]) buckets[layer].push(idx)
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

  const byLayer: Record<Layer, Uint32Array> = {}
  const counts: Record<Layer, number> = {}
  for (const id of config.layerIds) {
    const b = buckets[id]
    byLayer[id] = b.length ? Uint32Array.from(b) : EMPTY
    counts[id] = b.length
  }

  const stats: SelectionStats = {
    journeys: journeys.length,
    humanJourneys,
    botJourneys,
    matches: matchSet.size,
    events: indices.length,
    byLayer: counts,
    deathRate: humanJourneys ? deaths / humanJourneys : 0,
    medianDurationSec: durations.length ? durations[durations.length >> 1] : 0,
  }

  return {
    journeys,
    timeOrigin,
    relative,
    indices,
    positions: positions.length ? Uint32Array.from(positions) : EMPTY,
    byLayer,
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

/** Human-readable detail for a single event index (tooltips). */
export function describeEvent(bundle: MapBundle, idx: number) {
  const { meta, events, config } = bundle
  const code = events.ev[idx]
  const layer = config.layerOfCode[code] ?? null
  return {
    name: config.eventTypes[code] ?? 'Event',
    layer,
    color: layer ? config.colorOf[layer] : '#94a3b8',
    player: meta.players[events.pi[idx]],
    match: meta.matches[events.mi[idx]],
    t: events.t[idx],
    x: events.x[idx],
    y: events.y[idx],
    z: events.z[idx],
  }
}
