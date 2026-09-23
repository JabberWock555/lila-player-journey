# Architecture

## What I built with, and why

**Offline Python ETL → packed static files → React + Canvas app on Vercel. No server, no database.**

The dataset decides it: 1,243 parquet files, 88,894 events after cleaning, 2.6 MB once packed.
That fits in a browser tab whole, so a query API would only add latency, cost and a failure mode.
The pipeline runs once at build time; every filter, heatmap and replay runs client-side and is instant.

| Layer | Choice | Why |
|---|---|---|
| ETL | Python, pyarrow, pandas | Reads the extension-less parquet natively; the cleaning rules stay legible |
| Data on the wire | Packed binary + JSON manifest | ~21 bytes/event vs ~120 as JSON, loaded straight into TypedArrays with no parsing |
| App | React 18, TypeScript, Vite, Tailwind | Typed contract with the ETL; 65 kB gzipped |
| Drawing | Canvas 2D | Redraws 800+ paths and 15k markers in a few ms; WebGL would add weight for no gain at this size |
| Config | One `etl/config/dataset.json` | Maps, event types and layers declared once, read by both ETL and app |
| Hosting | Vercel (static), GitHub Pages as fallback | Nothing is dynamic, so a CDN is enough |

## How data gets from parquet to the screen

```
player_data/<Month>_<DD>/*.nakama-0 ──► etl/build_data.py ──► public/data/manifest.json   maps, matches, journeys, config
    + etl/config/dataset.json            decode · clean ·        public/data/<Map>.bin     x,y,z f32 · t u32 · event u8 · match,player u16
                                         project · validate      public/maps/<Map>.webp    minimaps, 2048 px
                                                                        │ fetched once per map
browser:  TypedArray views ──► selectEvents(filters) ──► heatmaps · paths · markers ──► one Canvas redraw
```

The ETL decodes events, fixes timestamps, labels humans and bots, projects to minimap coordinates,
drops redundant duplicates and sorts by (map, match, player, time), so each player's run is one
contiguous slice the renderer walks directly. It writes a `build-report.json` and `--strict`
fails the build on out-of-bounds points, missing minimaps or unknown events.

## Mapping game coordinates to the minimap

Each map's minimap covers a square of the world, given as a `scale` (its width in world units)
and an origin (its bottom-left corner): Ambrose Valley 900 at (−370, −473), Grand Rift 581 at
(−290, −290), Lockdown 1000 at (−500, −500). Three things have to be right:

1. **Use `x` and `z`, not `y`.** The world is Y-up; `y` is height (it only goes to the tooltip).
2. **Normalise, then flip.** `u = (x − originX) / scale`, `v = (z − originZ) / scale` gives 0–1 with
   `v` pointing up. Image rows run down, so the drawn position is `(u, 1 − v)`. Getting this backwards
   still puts points on *a* road — just the mirror-image one — so it has to be checked, not assumed.
3. **Don't hardcode 1024.** The README formula assumes 1024 px images; the real ones are 4320²,
   2160×2158 and 9000². Everything stays in 0–1 map space and is scaled to pixels only when drawn,
   so one transform keeps the minimap, paths, markers and heatmaps aligned at any zoom.

**How I checked it:** plotted all 88,894 events over each minimap. Every one lands inside the
image, and zoomed in, paths follow road centrelines and turn inside buildings. The same transform,
inverted, drives the live `x / z` readout under the cursor for cross-checking in the editor.

## Assumptions where the data was ambiguous

| What I ran into | How I handled it |
|---|---|
| `ts` is typed milliseconds, but read that way matches last under a second and sit in 1970 | Treated the raw number as **Unix seconds** — every row then matches its day folder (0.000% mismatch) and median runs are ~6 min |
| The README ties bot status to event names, but bot files contain `Position`/`Loot` and human files contain `BotKilled` | Human vs bot is decided by **user_id format only** (UUID = human) |
| In bot files, `BotKilled` is the **bot's own** death (one per bot, its last event in 285 of 297) | "Deaths" in the insights count **human files only** |
| Three numeric IDs (1379, 1402, 1429) behave exactly like players, one per match in the 16 matches with no UUID player | Kept as bots per the README rule, but flagged in INSIGHTS.md — likely test accounts |
| All 3 `Kill`/`Killed` pairs are one player logging both at the same second and spot | Read as **self-inflicted deaths**, not PvP |
| 2,364 identical `Loot` rows in groups of 2–7 | Real (one container, several items), so kept; only 210 duplicate position samples dropped |
| `match_id` has a `.nakama-N` suffix the filename lacks | Stripped so ids join |
| 436 rows sit on the other side of UTC midnight from their folder | Date comes from the timestamp, so a `02/09` date appears with one match |
| No extraction points in the data | Inferred from where surviving runs end (tight clusters), and labelled as inferred |

## Trade-offs

| Decision | Alternative | Why this way |
|---|---|---|
| Ship all data, filter in the browser | Query API over parquet | 2.6 MB total; instant filters and nothing to run |
| Packed binary | JSON, or parsing parquet in the browser | ~6× smaller than JSON; no 170 kB parquet library for every visitor |
| Canvas 2D | deck.gl / WebGL | Fast enough here, much simpler |
| Heatmaps computed live | Pre-baked tiles | Tiles can't follow the filters; computing takes ~5 ms |
| Different marker **shapes** per event | Colour only | Survives overlap and colour-blindness |
| Several matches play from their own start | Wall-clock time | Matches hours apart would never be on screen together |
| Data files revalidated on every load | Long browser cache | A stale data file with new code broke the site once; correctness beats ~200 ms |
| "+ Data" studio hands over config text | Studio writes the files | A static site can't write to the repo; it validates and gives you the exact edit |

Deeper notes — the append-only event-code rule, the caching bug, the dead-space method, the
studio and the scaling plan — are in [docs/ENGINEERING_NOTES.md](docs/ENGINEERING_NOTES.md).
