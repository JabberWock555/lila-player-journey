import { useMemo, useState } from 'react'
import type { Manifest, MapMeta, Layer } from '../lib/types'
import type { Filters } from '../lib/select'
import { ACTOR_COLORS } from '../lib/render'
import { Section, Toggle, fmtDuration, fmtNum, shortId } from './ui'

interface Props {
  manifest: Manifest
  map: MapMeta
  onMap: (id: string) => void
  filters: Filters
  onFilters: (f: Filters) => void
  loading: boolean
}

export function Sidebar({ manifest, map, onMap, filters, onFilters, loading }: Props) {
  const [query, setQuery] = useState('')

  const days = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of map.matches) counts.set(m.day, (counts.get(m.day) ?? 0) + 1)
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [map])

  // Match list respects the day filter so the two controls compose naturally.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return map.matches
      .filter((m) => !filters.days.size || filters.days.has(m.day))
      .filter((m) => !q || m.id.toLowerCase().includes(q))
      .sort((a, b) => b.t0 - a.t0)
  }, [map, filters.days, query])

  const patch = (p: Partial<Filters>) => onFilters({ ...filters, ...p })

  const toggleDay = (day: string) => {
    const next = new Set(filters.days)
    next.has(day) ? next.delete(day) : next.add(day)
    // Changing the day scope can orphan a match selection; clear it.
    patch({ days: next, matchIds: new Set() })
  }

  const selectMatch = (id: string | null) => {
    patch({ matchIds: id ? new Set([id]) : new Set() })
  }

  return (
    <aside className="w-[268px] shrink-0 bg-ink-800 border-r border-edge/60 flex flex-col overflow-y-auto">
      <div className="px-3 py-3 border-b border-edge/50">
        <h1 className="text-[13px] font-bold tracking-tight text-white leading-none">
          LILA BLACK
        </h1>
        <p className="text-[10px] text-muted mt-1">Player Journey Explorer</p>
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
                  src={`${import.meta.env.BASE_URL}${m.image}`}
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
          filters.matchIds.size > 0 && (
            <button className="text-[10px] text-slate-500 hover:text-slate-300"
                    onClick={() => selectMatch(null)}>
              clear
            </button>
          )
        }
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search match id…"
          className="w-full mb-2 px-2 py-1.5 rounded-md bg-ink-900 border border-edge/70
                     text-[11px] text-slate-200 placeholder:text-slate-600
                     focus:outline-none focus:border-sky-500/50"
        />

        <div className="space-y-0.5 overflow-y-auto -mr-1 pr-1" style={{ maxHeight: 340 }}>
          {loading && <p className="text-[11px] text-slate-500 py-2">Loading…</p>}
          {!loading && matches.length === 0 && (
            <p className="text-[11px] text-slate-500 py-2">No matches for this filter.</p>
          )}
          {matches.slice(0, 400).map((m) => {
            const on = filters.matchIds.has(m.id)
            return (
              <button
                key={m.id}
                onClick={() => selectMatch(on ? null : m.id)}
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
          {matches.length > 400 && (
            <p className="text-[10px] text-slate-600 py-1.5 px-2">
              showing first 400 — narrow by date or search
            </p>
          )}
        </div>
      </Section>
    </aside>
  )
}
