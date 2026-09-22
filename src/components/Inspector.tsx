import type { MapBundle } from '../lib/types'
import type { Selection } from '../lib/select'
import { ACTOR_COLORS } from '../lib/render'
import { Section, Slider, Stat, Toggle, fmtDuration, fmtNum, shortId } from './ui'
import type { HeatMode } from '../App'

interface Props {
  bundle: MapBundle
  selection: Selection
  heatMode: HeatMode
  onHeatMode: (m: HeatMode) => void
  heatRadius: number
  onHeatRadius: (v: number) => void
  heatOpacity: number
  onHeatOpacity: (v: number) => void
  mapBrightness: number
  onMapBrightness: (v: number) => void
  showPaths: boolean
  onShowPaths: (v: boolean) => void
  pathOpacity: number
  onPathOpacity: (v: number) => void
  showMarkers: boolean
  onShowMarkers: (v: boolean) => void
  markerScale: number
  onMarkerScale: (v: number) => void
  coverage: { coldCells: number; playableCells: number } | null
  focusJourney: number | null
  onFocusJourney: (i: number | null) => void
}

export function Inspector(p: Props) {
  const { selection, bundle } = p
  const s = selection.stats
  const { layers, layerIds } = bundle.config

  // Heatmap modes: the two structural ones plus one per configured layer, so a
  // new layer in dataset.json gets its own density view for free.
  const heatModes: { id: HeatMode; label: string; hint: string }[] = [
    { id: 'none', label: 'Off', hint: 'No density overlay' },
    { id: 'traffic', label: 'Traffic', hint: 'Where players spend time' },
    ...layerIds.map((id) => ({
      id: id as HeatMode,
      label: layers[id].heatLabel,
      hint: layers[id].heatHint,
    })),
    { id: 'cold', label: 'Dead space', hint: 'Playable areas nobody visits' },
  ]

  const singleMatch = s.matches === 1
  const match = singleMatch
    ? bundle.meta.matches[selection.journeys[0]?.m ?? -1]
    : null

  return (
    <aside className="w-[250px] shrink-0 bg-ink-800 border-l border-edge/60 flex flex-col overflow-y-auto">
      <Section title="Selection">
        <div className="grid grid-cols-2 gap-1.5">
          <Stat label="Matches" value={fmtNum(s.matches)} />
          <Stat label="Journeys" value={fmtNum(s.journeys)}
                hint={`${s.humanJourneys}H · ${s.botJourneys}B`} />
          <Stat label="Events" value={fmtNum(s.events)} />
          <Stat label="Median run" value={fmtDuration(s.medianDurationSec)} />
          {layerIds.map((id) => (
            <Stat key={id} label={layers[id].label}
                  value={fmtNum(s.byLayer[id] ?? 0)} accent={layers[id].color} />
          ))}
        </div>
        {s.humanJourneys > 0 && (
          <div className="mt-1.5 panel px-2.5 py-2">
            <div className="label">Human death rate</div>
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 h-1.5 rounded-full bg-ink-900 overflow-hidden">
                <div className="h-full rounded-full"
                     style={{ width: `${s.deathRate * 100}%`, background: layers.death?.color ?? '#a855f7' }} />
              </div>
              <span className="num text-xs text-slate-300">{(s.deathRate * 100).toFixed(0)}%</span>
            </div>
            <div className="text-[10px] text-slate-500 mt-1">
              share of runs ending in death (vs. surviving/extracting)
            </div>
          </div>
        )}
      </Section>

      {match && (
        <Section title="Match detail">
          <div className="panel px-2.5 py-2 space-y-1">
            <Row k="ID" v={shortId(match.id, 14)} />
            <Row k="Date" v={match.day} />
            <Row k="Length" v={fmtDuration(match.t1 - match.t0)} />
            <Row k="Humans" v={String(match.humans)} color={ACTOR_COLORS.human} />
            <Row k="Bots" v={String(match.bots)} color={ACTOR_COLORS.bot} />
          </div>
          {selection.journeys.length > 1 && (
            <div className="mt-1.5 space-y-0.5">
              <div className="label mb-1">Isolate a journey</div>
              {selection.journeys.map((j, i) => {
                const player = bundle.meta.players[j.p]
                const on = p.focusJourney === i
                return (
                  <button
                    key={`${j.m}-${j.p}`}
                    onMouseEnter={() => p.onFocusJourney(i)}
                    onMouseLeave={() => p.onFocusJourney(null)}
                    onClick={() => p.onFocusJourney(on ? null : i)}
                    className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-[10px] num
                                border transition-colors ${
                      on ? 'bg-ink-500 border-slate-500/60' : 'border-transparent hover:bg-ink-700'
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: player?.bot ? ACTOR_COLORS.bot : ACTOR_COLORS.human }} />
                    <span className="truncate flex-1 text-left text-slate-300">
                      {shortId(player?.id ?? '?', 11)}
                    </span>
                    <span className="text-slate-500">{fmtDuration(j.t1 - j.t0)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </Section>
      )}

      <Section title="Heatmap">
        <div className="grid grid-cols-3 gap-1">
          {heatModes.map((m) => (
            <button
              key={m.id}
              onClick={() => p.onHeatMode(m.id)}
              title={m.hint}
              className={`chip text-[10px] py-1.5 ${p.heatMode === m.id ? 'chip-on' : ''}`}
            >{m.label}</button>
          ))}
        </div>

        {p.heatMode === 'cold' && p.coverage && (
          <div className="mt-2 panel px-2.5 py-2">
            <div className="label">Unvisited playable area</div>
            <div className="text-lg num font-semibold text-sky-300 mt-0.5">
              {((p.coverage.coldCells / Math.max(1, p.coverage.playableCells)) * 100).toFixed(0)}%
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              {p.coverage.coldCells} of {p.coverage.playableCells} grid cells saw zero traffic
            </div>
          </div>
        )}

        {p.heatMode !== 'none' && p.heatMode !== 'cold' && (
          <div className="mt-2.5 space-y-2.5">
            <Slider label="Blur radius" value={p.heatRadius} min={1} max={18}
                    onChange={p.onHeatRadius} format={(v) => `${v}`} />
            <Slider label="Intensity" value={p.heatOpacity} min={0.15} max={1} step={0.05}
                    onChange={p.onHeatOpacity} format={(v) => `${Math.round(v * 100)}%`} />
          </div>
        )}
      </Section>

      <Section title="Layers">
        <div className="space-y-2.5">
          <div className="flex gap-1">
            <Toggle on={p.showPaths} onClick={() => p.onShowPaths(!p.showPaths)}>Paths</Toggle>
            <Toggle on={p.showMarkers} onClick={() => p.onShowMarkers(!p.showMarkers)}>Markers</Toggle>
          </div>
          {p.showPaths && (
            <Slider label="Path opacity" value={p.pathOpacity} min={0.05} max={1} step={0.05}
                    onChange={p.onPathOpacity} format={(v) => `${Math.round(v * 100)}%`} />
          )}
          {p.showMarkers && (
            <Slider label="Marker size" value={p.markerScale} min={1.5} max={8} step={0.5}
                    onChange={p.onMarkerScale} format={(v) => `${v}`} />
          )}
          <Slider label="Minimap brightness" value={p.mapBrightness} min={0.1} max={1} step={0.05}
                  onChange={p.onMapBrightness} format={(v) => `${Math.round(v * 100)}%`} />
        </div>
      </Section>

      <Section title="Legend">
        <div className="space-y-1.5 text-[10px]">
          <LegendRow color={ACTOR_COLORS.human} label="Human path" shape="line" />
          <LegendRow color={ACTOR_COLORS.bot} label="Bot path (dashed)" shape="dash" />
          {layerIds.map((id) => (
            <LegendRow
              key={id}
              color={layers[id].color}
              label={`${layers[id].label} (${GLYPH[layers[id].marker] ?? '●'})`}
              shape={layers[id].marker}
            />
          ))}
        </div>
      </Section>
    </aside>
  )
}

function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="flex justify-between gap-2 text-[11px]">
      <span className="text-slate-500">{k}</span>
      <span className="num truncate" style={{ color: color ?? '#cbd5e1' }}>{v}</span>
    </div>
  )
}

/** Text stand-ins for the canvas marker shapes, used in the legend. */
const GLYPH: Record<string, string> = {
  star: '★', cross: '✕', diamond: '◆', triangle: '▲', dot: '●',
}

function LegendRow({ color, label, shape }: { color: string; label: string; shape: string }) {
  return (
    <div className="flex items-center gap-2 text-slate-400">
      <span className="w-5 flex justify-center shrink-0">
        {shape === 'line' && <span className="block w-5 h-[2px] rounded" style={{ background: color }} />}
        {shape === 'dash' && (
          <span className="block w-5 h-[2px] rounded"
                style={{ backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` }} />
        )}
        {shape !== 'line' && shape !== 'dash' && (
          <span style={{ color }}>{GLYPH[shape] ?? '●'}</span>
        )}
      </span>
      {label}
    </div>
  )
}
