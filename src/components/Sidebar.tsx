import { useMemo, useState } from 'react'
import type { Manifest, MapMeta, Layer } from '../lib/types'
import type { Filters, MatchFilters } from '../lib/select'
import { filterMatches } from '../lib/select'
import { ACTOR_COLORS } from '../lib/render'
import { Section, Toggle, fmtDuration, fmtNum, shortId } from './ui'

interface Props {
  manifest: Manifest
  map: MapMeta
  onMap: (id: string) => void
  filters: Filters
  /** Accepts an updater so rapid clicks cannot read stale state. */
  onFilters: (f: Filters | ((prev: Filters) => Filters)) => void
  matchFilters: MatchFilters
  onMatchFilters: (f: MatchFilters | ((prev: MatchFilters) => MatchFilters)) => void
  loading: boolean
  onOpenStudio: () => void
}

const OUTCOMES: { id: MatchFilters['outcome']; label: string }[] = [
  { id: 'any', label: 'Any' },
  { id: 'died', label: 'Died' },
  { id: 'survived', label: 'Survived' },
]

const SORTS: { id: MatchFilters['sort']; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'longest', label: 'Longest' },
  { id: 'kills', label: 'Kills' },
  { id: 'loot', label: 'Loot' },
]

const MAX_LISTED = 400

export function Sidebar({
  manifest, map, onMap, filters, onFilters, matchFilters, onMatchFilters,
  loading, onOpenStudio,
}: Props) {
  const [showFilters, setShowFilters] = useState(false)

  const days = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of map.matches) counts.set(m.day, (counts.get(m.day) ?? 0) + 1)
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [map])

  // Outcome is a property of the human journeys, not the match row, so resolve
  // it once per map rather than per render of each row.
  const diedByMatch = useMemo(() => {
    const out = new Set<string>()
    for (const j of map.journeys) {
      if (!j.died) continue
      if (map.players[j.p]?.bot) continue
      const id = map.matches[j.m]?.id
      if (id) out.add(id)
    }
    return out
  }, [map])

  const matches = useMemo(
    () => filterMatches(map.matches, filters.days, matchFilters, diedByMatch),
    [map, filters.days, matchFilters, diedByMatch],
  )

  const patch = (p: Partial<Filters>) => onFilters((prev) => ({ ...prev, ...p }))
  const patchMF = (p: Partial<MatchFilters>) => onMatchFilters((prev) => ({ ...prev, ...p }))

  const toggleDay = (day: string) => {
    onFilters((prev) => {
      const next = new Set(prev.days)
      next.has(day) ? next.delete(day) : next.add(day)
      return { ...prev, days: next, matchIds: new Set() }
    })
  }

  /** Plain click selects only this match; ctrl/cmd/shift adds or removes. */
  const clickMatch = (id: string, additive: boolean) => {
    onFilters((prev) => {
      const next = new Set(prev.matchIds)
      if (additive) {
        next.has(id) ? next.delete(id) : next.add(id)
      } else if (next.size === 1 && next.has(id)) {
        next.clear()
      } else {
        next.clear()
        next.add(id)
      }
      return { ...prev, matchIds: next }
    })
  }

  const selectAllVisible = () => {
    patch({ matchIds: new Set(matches.slice(0, MAX_LISTED).map((m) => m.id)) })
  }

  const activeFilterCount =
    (matchFilters.outcome !== 'any' ? 1 : 0) +
    (matchFilters.stormOnly ? 1 : 0) +
    (matchFilters.withBots ? 1 : 0) +
    (matchFilters.minKills > 0 ? 1 : 0) +
    (matchFilters.minLoot > 0 ? 1 : 0) +
    (matchFilters.minDuration > 0 ? 1 : 0)

  return (
    <aside className="w-[268px] shrink-0 bg-ink-800 border-r border-edge/60 flex flex-col overflow-y-auto">
      <div className="px-3 py-3 border-b border-edge/50 flex items-start justify-between gap-2">
        <div>
          <h1 className="text-[13px] font-bold tracking-tight text-white leading-none">
            LILA BLACK
          </h1>
          <p className="text-[10px] text-muted mt-1">Player Journey Explorer</p>
        </div>
        <button className="btn text-[10px] px-2 py-1" onClick={onOpenStudio}
                title="Add a map or import telemetry">
          + Data
        </button>
      </div>

      <Section title="Map">
        <div className="space-y-1">
          {manifest.maps.map((m) => {
            const on = m.id === map.id
            return (
              <button
                key={m.id}
                onClick={() => onMap(m.id)}
                className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md border text-left transition-colors ${
                  on ? 'bg-ink-500 border-slate-500/60' : 'bg-ink-700 border-edge/60 hover:bg-ink-600'
                }`}
              >
                <img
                  src={m.image.startsWith('blob:') || m.image.startsWith('data:')
                    ? m.image : `${import.meta.env.BASE_URL}${m.image}`}
                  alt="" width={26} height={26} loading="lazy"
                  className="w-[26px] h-[26px] rounded object-cover shrink-0 border border-edge/60"
                />
                <span className="min-w-0 flex-1">
                  <span className={`block text-xs font-medium truncate ${on ? 'text-white' : 'text-slate-300'}`}>
                    {m.label}
                  </span>
                  <span className="block text-[10px] num text-slate-500">
                    {m.matches.length} matches · {fmtNum(m.count)} events
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </Section>

      <Section
        title="Date"
        right={
          filters.days.size > 0 && (
            <button className="text-[10px] text-slate-500 hover:text-slate-300"
                    onClick={() => patch({ days: new Set(), matchIds: new Set() })}>
              clear
            </button>
          )
        }
      >
        <div className="flex flex-wrap gap-1">
          {days.map(([day, count]) => (
            <Toggle
              key={day}
              on={filters.days.size === 0 || filters.days.has(day)}
              onClick={() => toggleDay(day)}
              title={`${count} matches`}
            >
              {day.slice(5).replace('-', '/')}
              <span className="num text-[9px] opacity-60 ml-0.5">{count}</span>
            </Toggle>
          ))}
        </div>
      </Section>

      <Section title="Show">
        <div className="flex flex-wrap gap-1 mb-2">
          <Toggle on={filters.showHumans} dot={ACTOR_COLORS.human}
                  onClick={() => patch({ showHumans: !filters.showHumans })}>
            Humans
          </Toggle>
          <Toggle on={filters.showBots} dot={ACTOR_COLORS.bot}
                  onClick={() => patch({ showBots: !filters.showBots })}>
            Bots
          </Toggle>
        </div>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(manifest.layers) as Layer[]).map((layer) => (
            <Toggle
              key={layer}
              on={filters.layers[layer] !== false}
              dot={manifest.layers[layer].color}
              onClick={() => patch({
                layers: { ...filters.layers, [layer]: filters.layers[layer] === false },
              })}
            >
              {manifest.layers[layer].label}
            </Toggle>
          ))}
        </div>
      </Section>

      <Section
        title={`Matches (${matches.length})`}
        className="flex-1 min-h-0 flex flex-col"
        right={
          <div className="flex items-center gap-2">
            <button
              className={`text-[10px] ${showFilters || activeFilterCount ? 'text-sky-300' : 'text-slate-500'} hover:text-slate-200`}
              onClick={() => setShowFilters((v) => !v)}
            >
              filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
            </button>
            {filters.matchIds.size > 0 && (
              <button className="text-[10px] text-slate-500 hover:text-slate-300"
                      onClick={() => patch({ matchIds: new Set() })}>
                clear
              </button>
            )}
          </div>
        }
      >
        <input
          value={matchFilters.query}
          onChange={(e) => patchMF({ query: e.target.value })}
          placeholder="Search match id…"
          className="w-full mb-2 px-2 py-1.5 rounded-md bg-ink-900 border border-edge/70
                     text-[11px] text-slate-200 placeholder:text-slate-600
                     focus:outline-none focus:border-sky-500/50"
        />

        {showFilters && (
          <div className="mb-2 p-2 rounded-md bg-ink-900/70 border border-edge/60 space-y-2">
            <div>
              <div className="label mb-1">Outcome</div>
              <div className="flex gap-1">
                {OUTCOMES.map((o) => (
                  <button key={o.id}
                          onClick={() => patchMF({ outcome: o.id })}
                          className={`chip text-[10px] flex-1 ${matchFilters.outcome === o.id ? 'chip-on' : ''}`}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-1">
              <Toggle on={matchFilters.stormOnly}
                      onClick={() => patchMF({ stormOnly: !matchFilters.stormOnly })}>
                Storm death
              </Toggle>
              <Toggle on={matchFilters.withBots}
                      onClick={() => patchMF({ withBots: !matchFilters.withBots })}>
                Has bots
              </Toggle>
            </div>

            <NumFilter label="Min kills" value={matchFilters.minKills} max={40}
                       onChange={(v) => patchMF({ minKills: v })} />
            <NumFilter label="Min loot" value={matchFilters.minLoot} max={80}
                       onChange={(v) => patchMF({ minLoot: v })} />
            <NumFilter label="Min length" value={matchFilters.minDuration} max={900} step={30}
                       format={(v) => (v ? fmtDuration(v) : 'any')}
                       onChange={(v) => patchMF({ minDuration: v })} />

            <div>
              <div className="label mb-1">Sort by</div>
              <div className="flex gap-1">
                {SORTS.map((o) => (
                  <button key={o.id}
                          onClick={() => patchMF({ sort: o.id })}
                          className={`chip text-[10px] flex-1 ${matchFilters.sort === o.id ? 'chip-on' : ''}`}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {activeFilterCount > 0 && (
              <button className="text-[10px] text-slate-500 hover:text-slate-200 w-full text-left"
                      onClick={() => patchMF({
                        outcome: 'any', stormOnly: false, withBots: false,
                        minKills: 0, minLoot: 0, minDuration: 0,
                      })}>
                reset filters
              </button>
            )}
          </div>
        )}

        <div className="flex items-center justify-between mb-1.5 text-[10px]">
          <span className="text-slate-500">
            {filters.matchIds.size > 0
              ? `${filters.matchIds.size} selected`
              : 'all matches'}
          </span>
          <button className="text-slate-500 hover:text-sky-300"
                  onClick={selectAllVisible}
                  title="Select every match currently listed, and play them together">
            select all listed
          </button>
        </div>

        <div className="space-y-0.5 overflow-y-auto -mr-1 pr-1" style={{ maxHeight: 300 }}>
          {loading && <p className="text-[11px] text-slate-500 py-2">Loading…</p>}
          {!loading && matches.length === 0 && (
            <p className="text-[11px] text-slate-500 py-2">No matches for this filter.</p>
          )}
          {matches.slice(0, MAX_LISTED).map((m) => {
            const on = filters.matchIds.has(m.id)
            return (
              <button
                key={m.id}
                onClick={(e) => clickMatch(m.id, e.ctrlKey || e.metaKey || e.shiftKey)}
                className={`w-full text-left px-2 py-1.5 rounded-md border transition-colors ${
                  on ? 'bg-sky-500/15 border-sky-400/40' : 'border-transparent hover:bg-ink-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[11px] num truncate ${on ? 'text-sky-200' : 'text-slate-300'}`}>
                    {shortId(m.id, 13)}
                  </span>
                  <span className="text-[10px] num text-slate-500 shrink-0">
                    {fmtDuration(m.t1 - m.t0)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-[9px] num text-slate-500">
                  <span>{m.day.slice(5)}</span>
                  <span className="text-human">{m.humans}H</span>
                  <span className="text-bot">{m.bots}B</span>
                  {(Object.keys(manifest.layers) as Layer[]).map((layer) => {
                    const count = m.layers?.[layer] ?? 0
                    if (!count) return null
                    const def = manifest.layers[layer]
                    return (
                      <span key={layer} style={{ color: def.color }} title={def.label}>
                        {count}{def.badge}
                      </span>
                    )
                  })}
                </div>
              </button>
            )
          })}
          {matches.length > MAX_LISTED && (
            <p className="text-[10px] text-slate-600 py-1.5 px-2">
              showing first {MAX_LISTED} — narrow by date, search or filters
            </p>
          )}
        </div>

        <p className="text-[9px] text-slate-600 mt-1.5 leading-snug">
          Click to isolate a match · ⌘/Ctrl-click to add more and play them together.
        </p>
      </Section>
    </aside>
  )
}

function NumFilter({
  label, value, max, step = 1, onChange, format,
}: {
  label: string; value: number; max: number; step?: number
  onChange: (v: number) => void; format?: (v: number) => string
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-400">{label}</span>
        <span className="text-[10px] num text-slate-500">
          {format ? format(value) : value || 'any'}
        </span>
      </div>
      <input type="range" min={0} max={max} step={step} value={value}
             onChange={(e) => onChange(Number(e.target.value))}
             className="w-full mt-0.5" />
    </label>
  )
}
