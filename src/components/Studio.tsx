import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Manifest, MapMeta } from '../lib/types'
import { buildDatasetConfig } from '../lib/types'
import { loadMap } from '../lib/data'
import type { ImportReport } from '../lib/importer'
import { Slider, fmtNum } from './ui'

interface Props {
  manifest: Manifest
  onClose: () => void
}

type Tab = 'map' | 'data'

const PREVIEW = 420

export function Studio({ manifest, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('map')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 bg-black/75 grid place-items-center p-6"
         onClick={onClose}>
      <div className="panel bg-ink-800 w-full max-w-4xl max-h-[88vh] flex flex-col shadow-2xl"
           onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-4 py-3 border-b border-edge/60">
          <div>
            <h2 className="text-sm font-bold text-white">Data studio</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Calibrate a map or import telemetry without hand-editing config.
            </p>
          </div>
          <div className="flex items-center gap-1">
            {(['map', 'data'] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                      className={`chip ${tab === t ? 'chip-on' : ''}`}>
                {t === 'map' ? 'Add / calibrate map' : 'Import telemetry'}
              </button>
            ))}
            <button onClick={onClose}
                    className="ml-2 w-7 h-7 rounded-md grid place-items-center text-slate-400 hover:text-white hover:bg-ink-600">
              ✕
            </button>
          </div>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {tab === 'map'
            ? <MapCalibrator manifest={manifest} />
            : <DataImporter manifest={manifest} />}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ map tab */

function MapCalibrator({ manifest }: { manifest: Manifest }) {
  const [mapId, setMapId] = useState(manifest.maps[0]?.id ?? '')
  const [label, setLabel] = useState(manifest.maps[0]?.label ?? '')
  const [scale, setScale] = useState(manifest.maps[0]?.scale ?? 900)
  const [originX, setOriginX] = useState(manifest.maps[0]?.originX ?? -450)
  const [originZ, setOriginZ] = useState(manifest.maps[0]?.originZ ?? -450)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageName, setImageName] = useState<string>('')
  const [points, setPoints] = useState<{ x: Float32Array; z: Float32Array } | null>(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [imgTick, setImgTick] = useState(0)

  const existing = useMemo(() => manifest.maps.find((m) => m.id === mapId), [manifest, mapId])

  // Pull the world coordinates for the chosen map so calibration is judged
  // against the real data, not a guess.
  useEffect(() => {
    if (!existing) { setPoints(null); return }
    let cancelled = false
    setBusy(true)
    loadMap(existing, buildDatasetConfig(manifest))
      .then((b) => {
        if (cancelled) return
        // Sample: 40k points is plenty to see alignment and keeps redraw snappy.
        const step = Math.max(1, Math.floor(b.events.n / 40000))
        const count = Math.floor(b.events.n / step)
        const x = new Float32Array(count)
        const z = new Float32Array(count)
        for (let i = 0, k = 0; k < count; i += step, k++) {
          x[k] = b.events.x[i]
          z[k] = b.events.z[i]
        }
        setPoints({ x, z })
        setBusy(false)
      })
      .catch(() => setBusy(false))
    return () => { cancelled = true }
  }, [existing, manifest])

  // Default the image to the map's own minimap unless one has been uploaded.
  useEffect(() => {
    if (imageUrl) return
    if (!existing) { imgRef.current = null; setImgTick((t) => t + 1); return }
    const img = new Image()
    img.onload = () => { imgRef.current = img; setImgTick((t) => t + 1) }
    img.src = `${import.meta.env.BASE_URL}${existing.image}`
  }, [existing, imageUrl])

  useEffect(() => {
    if (!imageUrl) return
    const img = new Image()
    img.onload = () => { imgRef.current = img; setImgTick((t) => t + 1) }
    img.src = imageUrl
  }, [imageUrl])

  const selectMap = (id: string) => {
    setMapId(id)
    const m = manifest.maps.find((x) => x.id === id)
    if (m) { setLabel(m.label); setScale(m.scale); setOriginX(m.originX); setOriginZ(m.originZ) }
  }

  /** Same heuristic as etl/calibrate_map.py: pad the data extent, snap the scale. */
  const fitToData = useCallback(() => {
    if (!points || !points.x.length) return
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (let i = 0; i < points.x.length; i++) {
      if (points.x[i] < x0) x0 = points.x[i]
      if (points.x[i] > x1) x1 = points.x[i]
      if (points.z[i] < z0) z0 = points.z[i]
      if (points.z[i] > z1) z1 = points.z[i]
    }
    const span = Math.max(x1 - x0, z1 - z0) * 1.18
    const snapped = span >= 2000 ? Math.round(span / 1000) * 1000
      : span >= 1000 ? Math.round(span / 500) * 500
      : span >= 200 ? Math.round(span / 100) * 100
      : Math.round(span / 10) * 10
    setScale(snapped)
    setOriginX(Math.round(((x0 + x1) / 2 - snapped / 2) / 10) * 10)
    setOriginZ(Math.round(((z0 + z1) / 2 - snapped / 2) / 10) * 10)
  }, [points])

  const inside = useMemo(() => {
    if (!points || !points.x.length) return null
    let n = 0
    for (let i = 0; i < points.x.length; i++) {
      const u = (points.x[i] - originX) / scale
      const v = (points.z[i] - originZ) / scale
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) n++
    }
    return n / points.x.length
  }, [points, scale, originX, originZ])

  // Live overlay.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')!
    c.width = PREVIEW; c.height = PREVIEW
    ctx.fillStyle = '#0d0f14'
    ctx.fillRect(0, 0, PREVIEW, PREVIEW)
    if (imgRef.current) ctx.drawImage(imgRef.current, 0, 0, PREVIEW, PREVIEW)
    if (points) {
      ctx.fillStyle = 'rgba(255,70,70,0.75)'
      for (let i = 0; i < points.x.length; i++) {
        const u = (points.x[i] - originX) / scale
        const v = (points.z[i] - originZ) / scale
        const px = u * PREVIEW
        const py = (1 - v) * PREVIEW
        if (px < 0 || py < 0 || px >= PREVIEW || py >= PREVIEW) continue
        ctx.fillRect(px, py, 1.5, 1.5)
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.strokeRect(0.5, 0.5, PREVIEW - 1, PREVIEW - 1)
  }, [points, scale, originX, originZ, imgTick])

  const block = useMemo(() => JSON.stringify({
    [mapId || 'NewMap']: {
      label: label || mapId || 'NewMap',
      scale, originX, originZ,
      source: imageName || existing?.image.split('/').pop()?.replace('.webp', '_Minimap.png') || `${mapId}_Minimap.png`,
    },
  }, null, 2).split('\n').slice(1, -1).map((l) => l.replace(/^ {2}/, '')).join('\n'),
  [mapId, label, scale, originX, originZ, imageName, existing])

  return (
    <div className="grid grid-cols-[auto_1fr] gap-4">
      <div>
        <canvas ref={canvasRef}
                className="rounded-md border border-edge/60 block"
                style={{ width: PREVIEW, height: PREVIEW }} />
        <p className="text-[10px] text-slate-500 mt-1.5 max-w-[420px] leading-snug">
          Red is real recorded positions. It is calibrated when traffic follows the roads
          and stops at the coastline — a high "inside" figure alone does not prove it,
          since a uniformly shifted box still contains every point.
        </p>
      </div>

      <div className="space-y-3 min-w-0">
        <div>
          <div className="label mb-1">Map</div>
          <div className="flex flex-wrap gap-1">
            {manifest.maps.map((m) => (
              <button key={m.id} onClick={() => selectMap(m.id)}
                      className={`chip ${mapId === m.id ? 'chip-on' : ''}`}>
                {m.label}
              </button>
            ))}
          </div>
          {busy && <p className="text-[10px] text-slate-500 mt-1">loading events…</p>}
        </div>

        <label className="block">
          <div className="label mb-1">New map id</div>
          <input
            value={mapId}
            onChange={(e) => setMapId(e.target.value)}
            placeholder="e.g. NorthRidge"
            className="w-full px-2 py-1.5 rounded-md bg-ink-900 border border-edge/70
                       text-[11px] num text-slate-200 focus:outline-none focus:border-sky-500/50"
          />
          <p className="text-[10px] text-slate-500 mt-1">
            Must match the <code className="text-slate-400">map_id</code> in the telemetry.
          </p>
        </label>

        <label className="block">
          <div className="label mb-1">Display label</div>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md bg-ink-900 border border-edge/70
                       text-[11px] text-slate-200 focus:outline-none focus:border-sky-500/50"
          />
        </label>

        <div>
          <div className="label mb-1">Minimap image</div>
          <input type="file" accept="image/*"
                 onChange={(e) => {
                   const f = e.target.files?.[0]
                   if (!f) return
                   setImageName(f.name)
                   setImageUrl(URL.createObjectURL(f))
                 }}
                 className="w-full text-[10px] text-slate-400 file:mr-2 file:py-1 file:px-2
                            file:rounded file:border file:border-edge/70 file:bg-ink-700
                            file:text-slate-300 file:text-[10px]" />
          {imageName && <p className="text-[10px] text-slate-500 mt-1">using {imageName}</p>}
        </div>

        <div className="space-y-2 pt-1">
          <Slider label="Scale (world units across)" value={scale} min={100} max={2000} step={1}
                  onChange={setScale} />
          <Slider label="Origin X" value={originX} min={-1500} max={500} step={1}
                  onChange={setOriginX} />
          <Slider label="Origin Z" value={originZ} min={-1500} max={500} step={1}
                  onChange={setOriginZ} />
        </div>

        <div className="flex items-center gap-2">
          <button className="btn" onClick={fitToData} disabled={!points}>Fit to data</button>
          {inside !== null && (
            <span className="text-[11px] num text-slate-400">
              {(inside * 100).toFixed(1)}% inside
            </span>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="label">dataset.json → maps</span>
            <CopyButton text={block} />
          </div>
          <pre className="text-[10px] num bg-ink-900 border border-edge/70 rounded-md p-2
                          overflow-x-auto text-slate-300 whitespace-pre">{block}</pre>
          <p className="text-[10px] text-slate-500 mt-1.5 leading-snug">
            Paste into <code className="text-slate-400">maps</code> in
            {' '}<code className="text-slate-400">etl/config/dataset.json</code>, drop the image in
            {' '}<code className="text-slate-400">minimaps/</code>, then re-run the ETL with
            {' '}<code className="text-slate-400">--strict</code>. The app is a static site, so it
            cannot write the file itself — but this is the whole edit.
          </p>
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- data tab */

function DataImporter({ manifest }: { manifest: Manifest }) {
  const [report, setReport] = useState<ImportReport | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const mapsById = useMemo(
    () => Object.fromEntries(manifest.maps.map((m) => [m.id, m])) as Record<string, MapMeta>,
    [manifest],
  )

  const handleFiles = useCallback(async (files: File[]) => {
    if (!files.length) return
    setError(null); setReport(null); setProgress({ done: 0, total: files.length })
    try {
      const { parseFiles } = await import('../lib/importer')
      const res = await parseFiles(
        files, buildDatasetConfig(manifest), mapsById,
        (done, total) => setProgress({ done, total }),
      )
      setReport(res.report)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
    }
  }, [manifest, mapsById])

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragging(false)
          handleFiles([...e.dataTransfer.files])
        }}
        className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
          dragging ? 'border-sky-400/70 bg-sky-500/5' : 'border-edge/70'
        }`}
      >
        <p className="text-sm text-slate-300">Drop <code className="num">.nakama-0</code> parquet files here</p>
        <p className="text-[11px] text-slate-500 mt-1">
          Parsed in your browser — nothing is uploaded anywhere.
        </p>
        <label className="btn mt-3 inline-block cursor-pointer">
          Choose files
          <input type="file" multiple className="hidden"
                 onChange={(e) => handleFiles([...(e.target.files ?? [])])} />
        </label>
      </div>

      {progress && (
        <div>
          <div className="flex justify-between text-[11px] text-slate-400 mb-1">
            <span>Parsing…</span>
            <span className="num">{progress.done} / {progress.total}</span>
          </div>
          <div className="h-1.5 rounded-full bg-ink-900 overflow-hidden">
            <div className="h-full bg-sky-400 transition-all"
                 style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
        </div>
      )}

      {error && (
        <p className="text-[11px] text-rose-400 num">{error}</p>
      )}

      {report && (
        <div className="space-y-2">
          <div className="grid grid-cols-4 gap-1.5">
            <Cell label="Files" value={fmtNum(report.files)} />
            <Cell label="Events" value={fmtNum(report.rows)} />
            <Cell label="Dropped dupes" value={fmtNum(report.dropped)} />
            <Cell label="Out of bounds"
                  value={`${(report.outOfBounds * 100).toFixed(2)}%`}
                  bad={report.outOfBounds > 0.005} />
          </div>

          <div className="panel px-3 py-2 space-y-1 text-[11px]">
            <Row k="Days" v={report.days.join(', ') || '—'} />
            <Row k="Maps" v={Object.entries(report.byMap).map(([m, n]) => `${m} (${fmtNum(n)})`).join(', ') || '—'} />
            {report.unknownEvents.length > 0 && (
              <Row k="Unknown events" v={report.unknownEvents.join(', ')} warn />
            )}
            {report.unmappedMaps.length > 0 && (
              <Row k="Unconfigured maps" v={report.unmappedMaps.join(', ')} warn />
            )}
            {report.filesFailed.length > 0 && (
              <Row k="Unreadable" v={`${report.filesFailed.length} file(s): ${report.filesFailed.slice(0, 2).map((f) => f.name).join(', ')}`} warn />
            )}
          </div>

          {report.unmappedMaps.length > 0 && (
            <p className="text-[11px] text-amber-300/90">
              {report.unmappedMaps.join(', ')} has no entry in the map config — add it on the
              <strong> Add / calibrate map</strong> tab first, or its events cannot be placed.
            </p>
          )}

          <div className="panel px-3 py-2.5 bg-ink-900/60">
            <div className="label mb-1">To make this permanent</div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              This validated the files against the current config — the same checks the
              pipeline runs. The deployed app is a static bundle, so it cannot write these
              events into the repo from the browser. Drop the day folder alongside the
              others and rebuild:
            </p>
            <pre className="text-[10px] num bg-ink-900 border border-edge/70 rounded-md p-2 mt-1.5 overflow-x-auto text-slate-300">python3 etl/build_data.py --src /path/to/player_data --strict</pre>
            <p className="text-[10px] text-slate-500 mt-1.5">
              Folders are picked up by name as <code className="text-slate-400">&lt;Month&gt;_&lt;DD&gt;</code>,
              any month or year.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- bits */

function Cell({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="panel px-2.5 py-2">
      <div className="label truncate">{label}</div>
      <div className={`text-base num font-semibold mt-0.5 ${bad ? 'text-rose-400' : 'text-slate-200'}`}>
        {value}
      </div>
    </div>
  )
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-slate-500 shrink-0 w-[112px]">{k}</span>
      <span className={`num break-all ${warn ? 'text-amber-300' : 'text-slate-300'}`}>{v}</span>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="text-[10px] text-slate-500 hover:text-sky-300"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1600)
        } catch {
          // clipboard blocked (insecure context / permissions) — the block is
          // visible and selectable anyway
          setDone(false)
        }
      }}
    >{done ? 'copied' : 'copy'}</button>
  )
}
