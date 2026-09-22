import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadManifest, loadMap } from './lib/data'
import { buildColdmap, buildHeatmap } from './lib/heatmap'
import {
  defaultFilters, defaultMatchFilters, gatherUV, selectEvents,
  type Filters, type MatchFilters,
} from './lib/select'
import { IDENTITY_VIEW, type View } from './lib/render'
import { buildDatasetConfig, type DatasetConfig, type Manifest, type MapBundle } from './lib/types'
import { MapView } from './components/MapView'
import { Sidebar } from './components/Sidebar'
import { Inspector } from './components/Inspector'
import { Timeline } from './components/Timeline'
import { Onboarding } from './components/Onboarding'
import { Studio } from './components/Studio'

/** 'none' | 'traffic' | 'cold' are structural; anything else is a layer id. */
export type HeatMode = string

export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [config, setConfig] = useState<DatasetConfig | null>(null)
  const [mapId, setMapId] = useState<string | null>(null)
  const [bundle, setBundle] = useState<MapBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [filters, setFilters] = useState<Filters>(defaultFilters)
  const [matchFilters, setMatchFilters] = useState<MatchFilters>(defaultMatchFilters)
  const [studioOpen, setStudioOpen] = useState(
    () => new URLSearchParams(location.search).get('studio') === '1',
  )
  const [view, setView] = useState<View>(IDENTITY_VIEW)

  const [heatMode, setHeatMode] = useState<HeatMode>('traffic')
  const [heatRadius, setHeatRadius] = useState(6)
  const [heatOpacity, setHeatOpacity] = useState(0.85)
  const [mapBrightness, setMapBrightness] = useState(0.62)
  const [showPaths, setShowPaths] = useState(true)
  const [pathOpacity, setPathOpacity] = useState(0.08)
  const [showMarkers, setShowMarkers] = useState(true)
  const [markerScale, setMarkerScale] = useState(2.5)
  const [showPositions, setShowPositions] = useState(false)
  const [positionScale, setPositionScale] = useState(1.25)
  const [focusJourney, setFocusJourney] = useState<number | null>(null)

  const [playhead, setPlayhead] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(8)
  const [trailSec, setTrailSec] = useState(900)

  // --- bootstrap ----------------------------------------------------------
  useEffect(() => {
    loadManifest()
      .then((m) => {
        setManifest(m)
        const cfg = buildDatasetConfig(m)
        setConfig(cfg)
        setFilters(defaultFilters(cfg.layerIds))
        // Default to the map with the most data.
        const biggest = [...m.maps].sort((a, b) => b.count - a.count)[0]
        setMapId(biggest.id)
      })
      .catch((e) => setError(String(e)))
  }, [])

  const mapMeta = useMemo(
    () => manifest?.maps.find((m) => m.id === mapId) ?? null,
    [manifest, mapId],
  )

  useEffect(() => {
    if (!mapMeta || !config) return
    setLoading(true)
    setBundle(null)
    loadMap(mapMeta, config)
      .then((b) => {
        setBundle(b)
        setLoading(false)
        // `?match=<id-prefix>` deep-links straight to one match.
        const want = new URLSearchParams(location.search).get('match')
        if (want) {
          const hit = b.meta.matches.find((m) => m.id.startsWith(want))
          if (hit) setFilters((f) => ({ ...f, matchIds: new Set([hit.id]) }))
        }
      })
      .catch((e) => { setError(String(e)); setLoading(false) })
  }, [mapMeta, config])

  // --- derived ------------------------------------------------------------
  const selection = useMemo(
    () => (bundle ? selectEvents(bundle, filters) : null),
    [bundle, filters],
  )

  // Playback needs an explicit match selection. With several, `selectEvents`
  // rebases each onto its own start so they run together rather than being
  // smeared across hours of wall clock.
  const playable = filters.matchIds.size > 0 && (selection?.stats.matches ?? 0) > 0

  useEffect(() => {
    if (!playable) {
      setPlayhead(null)
      setPlaying(false)
    }
  }, [playable])

  // Reset the playhead when the selected match changes, and swap to the view
  // preset that suits the new scope. Aggregate views need near-transparent
  // paths (hundreds of overlaid runs otherwise bury the minimap and the
  // heatmap); a single match wants them bright and legible.
  useEffect(() => {
    setPlaying(false)
    setPlayhead(null)
    setFocusJourney(null)
    const n = filters.matchIds.size
    // A handful of runs can stay bright; hundreds overlaid need to fade back or
    // they bury the minimap underneath.
    const focused = n > 0 && n <= 12
    setPathOpacity(focused ? (n === 1 ? 0.9 : 0.55) : 0.08)
    setMarkerScale(focused ? 4.5 : 2.5)
    setHeatMode((m) => (focused && m === 'traffic' ? 'none' : m))
  }, [filters.matchIds, mapId])

  const heat = useMemo(() => {
    if (!bundle || !selection || heatMode === 'none' || heatMode === 'cold') return null
    const sparse = heatMode !== 'traffic'
    const src = sparse ? selection.byLayer[heatMode] : selection.positions
    if (!src?.length) return null
    const { u, v, n } = gatherUV(bundle, src)
    // Discrete events are far sparser than position samples, so they need a
    // wider kernel and a lower clip to read as a field rather than confetti.
    return buildHeatmap(u, v, n, {
      ramp: sparse ? bundle.config.layers[heatMode]?.ramp : bundle.config.trafficRamp,
      radius: sparse ? heatRadius + 3 : heatRadius,
      clip: sparse ? 0.97 : 0.99,
      gamma: sparse ? 0.62 : 0.55,
      opacity: heatOpacity,
    })
  }, [bundle, selection, heatMode, heatRadius, heatOpacity])

  const cold = useMemo(() => {
    if (!bundle || !selection || heatMode !== 'cold') return null
    const { u, v, n } = gatherUV(bundle, selection.positions)
    return buildColdmap(u, v, n)
  }, [bundle, selection, heatMode])

  // --- keyboard shortcuts -------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'Space' && playable) { e.preventDefault(); setPlaying((p) => !p) }
      if (e.key === 'f') setView(IDENTITY_VIEW)
      if (e.key === 'p') setShowPaths((v) => !v)
      if (e.key === 'm') setShowMarkers((v) => !v)
      if (e.key === 'o') setShowPositions((v) => !v)
      if (e.key >= '1' && e.key <= '9' && config) {
        const modes: HeatMode[] = ['none', 'traffic', ...config.layerIds, 'cold']
        const pick = modes[Number(e.key) - 1]
        if (pick) setHeatMode(pick)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playable, config])

  const handleMap = useCallback((id: string) => {
    setMapId(id)
    setFilters(defaultFilters(config?.layerIds ?? []))
    setMatchFilters(defaultMatchFilters())
    setView(IDENTITY_VIEW)
  }, [config])

  if (error) {
    return (
      <div className="h-full grid place-items-center p-6 text-center">
        <div>
          <p className="text-rose-400 font-semibold">Failed to load telemetry</p>
          <p className="text-xs text-slate-500 mt-1 num">{error}</p>
        </div>
      </div>
    )
  }

  if (!manifest || !mapMeta || !config) {
    return (
      <div className="h-full grid place-items-center">
        <p className="text-sm text-slate-500 animate-pulse">Loading telemetry…</p>
      </div>
    )
  }

  return (
    <div className="h-full flex overflow-hidden">
      <Sidebar
        manifest={manifest}
        map={mapMeta}
        onMap={handleMap}
        filters={filters}
        onFilters={setFilters}
        matchFilters={matchFilters}
        onMatchFilters={setMatchFilters}
        loading={loading}
        onOpenStudio={() => setStudioOpen(true)}
      />

      <main className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0 relative">
          {bundle && selection ? (
            <MapView
              bundle={bundle}
              selection={selection}
              layers={{ heat: heat?.canvas ?? null, cold: cold?.canvas ?? null }}
              view={view}
              onView={setView}
              mapBrightness={mapBrightness}
              showPaths={showPaths}
              pathOpacity={pathOpacity}
              showMarkers={showMarkers}
              markerScale={markerScale}
              showPositions={showPositions}
              positionScale={positionScale}
              playhead={playhead}
              trailSec={trailSec}
              focusJourney={focusJourney}
            />
          ) : (
            <div className="h-full grid place-items-center">
              <p className="text-sm text-slate-500 animate-pulse">
                Loading {mapMeta.label}…
              </p>
            </div>
          )}

          {!playable && bundle && (
            <div className="absolute top-3 left-3 panel bg-ink-900/85 px-2.5 py-1.5 text-[10px] text-slate-400 max-w-[260px]">
              Aggregate view — <span className="text-slate-200">{selection?.stats.matches ?? 0} matches</span> overlaid.
              Select one or more matches in the sidebar to play them back together.
            </div>
          )}
        </div>

        {bundle && selection && (
          <Timeline
            bundle={bundle}
            selection={selection}
            playhead={playhead}
            onPlayhead={setPlayhead}
            playing={playing}
            onPlaying={setPlaying}
            speed={speed}
            onSpeed={setSpeed}
            trailSec={trailSec}
            onTrail={setTrailSec}
            enabled={playable}
          />
        )}
      </main>

      {bundle && selection && (
        <Inspector
          bundle={bundle}
          selection={selection}
          heatMode={heatMode}
          onHeatMode={setHeatMode}
          heatRadius={heatRadius}
          onHeatRadius={setHeatRadius}
          heatOpacity={heatOpacity}
          onHeatOpacity={setHeatOpacity}
          mapBrightness={mapBrightness}
          onMapBrightness={setMapBrightness}
          showPaths={showPaths}
          onShowPaths={setShowPaths}
          pathOpacity={pathOpacity}
          onPathOpacity={setPathOpacity}
          showMarkers={showMarkers}
          onShowMarkers={setShowMarkers}
          markerScale={markerScale}
          onMarkerScale={setMarkerScale}
          showPositions={showPositions}
          onShowPositions={setShowPositions}
          positionScale={positionScale}
          onPositionScale={setPositionScale}
          coverage={cold}
          focusJourney={focusJourney}
          onFocusJourney={setFocusJourney}
        />
      )}

      <Onboarding />
      {studioOpen && (
        <Studio
          manifest={manifest}
          onClose={() => setStudioOpen(false)}
        />
      )}
    </div>
  )
}
