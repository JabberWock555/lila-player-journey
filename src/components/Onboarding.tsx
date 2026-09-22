import { useEffect, useState } from 'react'

const KEY = 'lila-onboarding-v1'

const STEPS = [
  { k: 'Pick a map', v: 'Top-left. Ambrose Valley holds ~70% of the data.' },
  { k: 'Filter', v: 'Narrow by date, then click a match to isolate one run.' },
  { k: 'Heatmaps', v: 'Traffic / Kill / Death / Loot, plus "Dead space" for areas nobody visits.' },
  { k: 'Playback', v: 'With one match selected, press Play or scrub the timeline.' },
  { k: 'Navigate', v: 'Scroll to zoom, drag to pan, hover a marker for details.' },
]

const KEYS: [string, string][] = [
  ['Space', 'play / pause'],
  ['1-6', 'heatmap mode'],
  ['P / M', 'toggle paths / markers'],
  ['F', 'fit view'],
]

export function Onboarding() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // `?tour=0` suppresses the tour, for screenshots and demo links.
    if (new URLSearchParams(location.search).get('tour') === '0') return
    try {
      if (!localStorage.getItem(KEY)) setOpen(true)
    } catch {
      // private mode / blocked storage — just skip the tour
    }
  }, [])

  const close = () => {
    setOpen(false)
    try { localStorage.setItem(KEY, '1') } catch { /* ignore */ }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-[88px] right-[262px] z-30 w-7 h-7 rounded-full panel
                   bg-ink-800/90 text-slate-400 hover:text-white text-xs font-semibold
                   grid place-items-center shadow-lg"
        title="How to use this tool"
        aria-label="Help"
      >?</button>

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6"
          onClick={close}
        >
          <div
            className="panel bg-ink-800 w-full max-w-md p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold text-white">Player Journey Explorer</h2>
            <p className="text-xs text-slate-400 mt-1">
              5 days of LILA BLACK telemetry — 796 matches, ~89k events — plotted on the
              live minimaps.
            </p>

            <dl className="mt-4 space-y-2">
              {STEPS.map(({ k, v }, i) => (
                <div key={k} className="flex gap-2.5">
                  <span className="w-4 h-4 mt-0.5 shrink-0 rounded-full bg-sky-500/20 text-sky-300
                                   text-[9px] font-bold grid place-items-center num">{i + 1}</span>
                  <div>
                    <dt className="text-xs font-semibold text-slate-200">{k}</dt>
                    <dd className="text-[11px] text-slate-500">{v}</dd>
                  </div>
                </div>
              ))}
            </dl>

            <div className="mt-4 pt-3 border-t border-edge/60">
              <div className="label mb-1.5">Shortcuts</div>
              <div className="grid grid-cols-2 gap-1.5">
                {KEYS.map(([k, v]) => (
                  <div key={k} className="flex items-center gap-1.5 text-[10px]">
                    <kbd className="px-1.5 py-0.5 rounded bg-ink-600 border border-edge
                                    text-slate-300 num">{k}</kbd>
                    <span className="text-slate-500">{v}</span>
                  </div>
                ))}
              </div>
            </div>

            <button onClick={close} className="btn btn-primary w-full mt-4 py-2">
              Start exploring
            </button>
          </div>
        </div>
      )}
    </>
  )
}
