# Architecture

## What I built with, and why

**Offline Python ETL → packed static assets → React/Canvas SPA on Vercel. No server, no database.**

The decisive fact is the size of the dataset: 1,243 parquet files, **88,894 events after
cleaning**, ~8 MB raw. That is small enough to ship *in full* to the browser. Once the whole
dataset fits in memory, a query API earns nothing — it only adds latency, a deploy surface
and a failure mode. So the pipeline runs once at build time and the app is a static site.

| Layer | Choice | Rationale |
|---|---|---|
| ETL | Python + pyarrow/pandas | pyarrow reads the extension-less files natively; pandas makes the cleaning legible |
| Transport | Packed binary + JSON manifest | ~21 B/event vs ~120 B as JSON; parsed with zero cost as TypedArrays |
| UI | React 18 + TypeScript + Vite | Typed contracts between ETL and UI; 58 kB gzipped bundle |
| Drawing | Canvas 2D | Full redraw of 800+ paths + 15k markers in a few ms. WebGL/deck.gl would add ~150 kB and shader maintenance for no gain at this scale |
| Config | One `dataset.json`, read by the ETL and copied into the manifest | Maps, event types and layers are declared once instead of in eight places across two languages |
| Hosting | Vercel static | Immutable assets on a CDN; the data ships with the build |

## Data flow

```
etl/config/dataset.json            maps · event types · layers   (single source of truth)
        │
player_data/<Month>_<DD>/…         1,243 parquet files
        │
        │  etl/build_data.py  (one pass, ~20 s)
        │    · decode `event` bytes → str
        │    · reinterpret `ts` as Unix seconds  (see "Assumptions")
        │    · classify bot vs human from user_id shape
        │    · strip the `.nakama-N` suffix from match_id
        │    · project world (x,z) → minimap UV
        │    · drop redundant duplicate position samples
        │    · sort by (map, match, player, time)
        ▼
public/data/manifest.json      config + maps · matches · journeys · players · totals  (250 kB)
public/data/build-report.json  validation summary (drift, out-of-bounds, skips)
public/data/<Map>.bin          x,y,z:f32 │ t:u32 │ ev:u8 │ mi,pi:u16              (1.9 MB total)
public/maps/<Map>.webp         minimaps downscaled 4320²/9000² → 2048²            (0.73 MB total)
        │
        │  fetch once per map, decoded into TypedArray views (src/lib/data.ts)
        │  buildDatasetConfig() turns the manifest's config blocks into the
        │  event-code -> layer lookups the hot paths use (src/lib/types.ts)
        ▼
selectEvents(bundle, filters)   filters → index sets + summary stats  (src/lib/select.ts)
        │
        ├─ positions[]  → traffic heatmap, path polylines
        └─ byLayer{}    → kill / death / loot / storm markers and heatmaps
        │
        ▼
render(canvas, …)               single full redraw per state change  (src/lib/render.ts)
```

Rows are sorted so every **(match, player) journey is one contiguous slice**, described by an
`(offset, length)` pair in the manifest. Drawing a player's path is a straight walk over a
range — no grouping or lookup at runtime.

The only awkward detail is alignment: `Uint16Array` needs an even byte offset, and the `ev`
block is `n` bytes, so an odd `n` leaves the following blocks misaligned. `src/lib/data.ts`
copies those two blocks when that happens rather than silently producing garbage.

## Coordinate mapping — the tricky part

Each map defines a square world footprint that the minimap image covers, given as a `scale`
(width in world units) and an origin (its bottom-left corner):

| Map | Scale | Origin X | Origin Z |
|---|---|---|---|
| AmbroseValley | 900 | −370 | −473 |
| GrandRift | 581 | −290 | −290 |
| Lockdown | 1000 | −500 | −500 |

Three things have to be right.

**1. Use `x` and `z`, never `y`.** The world is Y-up: `y` is elevation (Ambrose spans
100.0–162.7), so the top-down plane is the **X/Z** plane. Using `y` would produce a flat smear.
`y` is still carried through to the tooltip, because verticality matters to a level designer.

**2. Normalise to UV, then flip Y.** World → unit square:

```
u = (x - originX) / scale          // 0..1 left→right
v = (z - originZ) / scale          // 0..1 bottom→top  (world up)
```

`v` is measured upward, but image rows run downward from the top-left, so the image
coordinate is `1 - v`. Getting this backwards yields a map that looks plausible — points
still land on roads — but vertically mirrored, which is exactly the kind of bug that survives
a casual glance. I verified it by rendering every event over each minimap and checking that
points sit on roads and buildings and respect the landmass edge, rather than assuming.

**3. Do not bake in 1024.** The README's formula multiplies UV by 1024, but the shipped
minimaps are 4320², 2160×2158 and 9000². I keep the projection in **normalised UV** and apply
the pixel scale only at draw time, from the canvas rect:

```
mx = u,  my = 1 - v                          // map space, resolution-independent
screenX = rect.left + mx * rect.size         // rect.size = min(w,h) * zoom
screenY = rect.top  + my * rect.size
```

One transform drives the base image, paths, markers and heatmaps, so every layer stays
registered at any zoom, and the same function inverted powers the live `x / z` readout under
the cursor.

**Validation.** All 88,894 events fall inside `0 ≤ u,v ≤ 1` — no clamping, no outliers. Per-map
UV extents are Ambrose `u 0.05–0.75, v 0.10–0.93`, Grand Rift `u 0.11–0.94, v 0.17–0.79`,
Lockdown `u 0.09–0.85, v 0.22–0.83`: comfortably inside the image with the margin you would
expect from an unreachable border. At high zoom individual paths follow road centrelines and
turn inside buildings, which is the real proof the projection is correct.

## Configuration and the one invariant that matters

`etl/config/dataset.json` declares the maps (label, `scale`, `originX`, `originZ`,
minimap file), the event types, and the layers each event belongs to (label, colour,
marker shape, heatmap ramp). The ETL derives its constants from it and copies the
`events`/`layers` blocks into the manifest; the frontend builds its lookups from those
at load. Nothing about a specific map, event or layer is hardcoded in either language,
so adding any of them is a config edit. The README has the step-by-step.

**The invariant: the `events` list is append-only.** An event's index in that list is
what the `.bin` files store in their `ev` column, as a single byte. Reordering or
removing an entry would silently reinterpret every archived binary — `Loot` would read
back as `Kill`. `Config.assert_event_codes_stable()` compares the list against the
previously built manifest and refuses to build unless the old order is still a prefix of
the new one. Appending is always safe, and verified: adding a ninth event type leaves all
three existing `.bin` files byte-identical.

Two derived groupings follow from the config rather than being listed by hand: position
samples are the events with `layer: null`, and a journey counts as a death if it contains
any event whose layer is `death` or `storm`.

## Assumptions where the data was ambiguous

**`ts` is Unix seconds stored in a millisecond column.** The schema says `timestamp[ms]` and
the README shows `1970-01-21 11:52:07.161`, described as time elapsed within the match. Read
that way the numbers are wrong twice over: matches would last milliseconds, and the dates sit
in 1970. The raw integer (e.g. `1770754537`) is a Unix timestamp **in seconds** — it decodes to
2026-02-10 20:15:37. I reinterpret it that way, and the ETL asserts the result: **0.000%** of
rows disagree with the day folder they came from. Match durations then land at a median of
6:07, which is a sane match length. Consequence: event resolution is one second, so position
samples are at best 1 Hz. *Reported in the ETL output as `timestamp<->folder mismatch rate`.*

**Bot detection uses `user_id` shape, not the event name.** The README implies bots emit
`BotPosition`/`BotKill`/`BotKilled` and humans emit the rest. That does not hold: 636 `Position`
and 115 `Loot` rows come from numeric (bot) ids, and 403 `BotKilled` rows come from UUID
(human) ids — the `Bot*` prefix on kill events describes *the other party*, not the actor.
Classifying by event name would mislabel ~750 rows. I classify strictly on whether `user_id`
is a UUID, which matches the filename convention.

**Duplicate rows are only collapsed for position samples.** 2,865 rows participate in exact
duplicate groups. Almost all are `Loot` (2,364) in groups of 2–7 sharing one tick and one
position — that is a container yielding several items, i.e. real signal, and collapsing it
would understate loot density. Only identical `Position`/`BotPosition` samples are redundant
(a stationary player sampled twice in a one-second tick); **210** of those are dropped. The
other 88,894 events are kept.

**`match_id` carries a `.nakama-N` server-instance suffix** that the filename does not. I strip
it so ids join cleanly, assuming the suffix identifies the server instance rather than
distinguishing two different matches.

**Dates are derived from the timestamp (UTC), not the folder name.** They agree for all but
436 rows that straddle a UTC midnight — the folder is the collection batch, the timestamp is
the event. This is why the date filter shows a `02/09` chip with a single match.

**"Playable area" for dead-space detection is inferred, not authored.** There is no navmesh in
the dataset, so a cell counts as playable if it is within ~6 cells of somewhere a player
actually stood. This keeps the off-map void out of the result but will miss genuinely
reachable regions that nobody has ever entered — so the figure is a floor on wasted space,
not an exact measure.

**Matches are almost entirely solo.** 779 of 796 matches contain exactly one human. Playback
is therefore scoped to a single match: overlaying several matches would superimpose unrelated
wall-clock timelines, which would be misleading rather than useful. The UI says so explicitly
when more than one match is selected.

## Trade-offs

| Decision | Alternative considered | Why this way |
|---|---|---|
| Ship the whole dataset, filter client-side | Query API (DuckDB/Postgres) over parquet | 2.6 MB total. An API adds latency and infra for a dataset that fits in memory; every filter is now instant and works offline |
| Packed binary + manifest | Plain JSON, or parquet-wasm in the browser | JSON is ~6× larger and costs a parse; parquet-wasm adds ~1 MB of runtime to re-do work the build already did |
| Canvas 2D | deck.gl / WebGL | At 89k points Canvas redraws in a few ms. WebGL buys headroom this dataset never needs, at a real cost in bundle size and complexity |
| Precompute heatmaps in the browser | Bake heatmap tiles in the ETL | Baked tiles cannot respond to filters. Grid + separable box blur is ~5 ms, so it can be live |
| Per-map bundles, loaded on demand | One combined bundle | Ambrose is 70% of the data; nobody needs Lockdown's bytes to look at Ambrose |
| Normalise heatmaps against the 97–99th percentile | Normalise against the max | A single extreme spawn cell otherwise flattens the entire field to near-zero |
| Distinct marker **shapes** per event type | Colour only | Markers overlap heavily at POIs; shape survives overlap, colour-blindness and greyscale |
| View presets that switch with scope | Fixed defaults | 836 overlaid journeys at readable opacity bury the map; one journey at aggregate opacity is invisible. The preset flips with the selection and remains user-overridable |
| Static hosting | Server-rendered app | Nothing is dynamic. A CDN-served SPA has no cold starts and no runtime cost |
| Config in JSON read at build time | Config in TypeScript, imported by both | The ETL is Python; a shared JSON file is the only format both ends read without a codegen step |
| Per-layer counts in the manifest | Named `kills`/`loot`/`storm` fields | Named fields mean a new layer needs a schema change plus UI edits; a `layers` map means it needs neither |

## Scaling roadmap

Shipping the whole dataset to the browser is right at today's size and stops being right
somewhere around **10 MB / ~30 days** of telemetry — roughly where first load stops
feeling instant on a normal connection. Current payload is 2.6 MB for 5 days, so there is
about 6× headroom. Two staged responses, in order, when that threshold approaches:

1. **Shard by day.** Emit `data/<Map>/<YYYY-MM-DD>.bin` plus a small per-map index, and
   have the loader fetch only the days the date filter selects, with an LRU cache. The
   date filter and the `(offset, length)` journey slices already exist, so this touches
   the loading layer and nothing else. The manifest has to split the same way — at 100×
   the matches it would be ~25 MB on its own.
2. **Precompute density grids.** Bake a per (map, day, layer) grid in the ETL. Counts are
   additive, so any date range is the element-wise sum of its days' grids — the
   all-time heatmap stops needing raw position samples at all, and raw events only load
   when a single match is opened.

Neither is built. At 5 days they would be speculative complexity, and the ETL prints the
numbers needed to know when they stop being.

## Known limits

- **1 Hz sampling.** Sub-second movement is not recoverable; paths interpolate between
  one-second samples. Gaps over 25 s break the polyline rather than drawing a false straight
  line across the map.
- **Bot telemetry is sparse.** Only 94 distinct bots have files at all, and the median match
  has none — bot heatmaps represent the sampled subset, not the full bot population.
- **PvP is effectively absent** (3 human-vs-human kills in the whole dataset), so "kill zones"
  are overwhelmingly player-vs-bot zones. See INSIGHTS.md.
- **Grand Rift's minimap is 2160×2158**, not square. It is treated as square UV space; the
  0.09% vertical error is well below one grid cell.
- Tuned for desktop. It is a level-design workstation tool; there is no mobile layout.
- `calibrate_map.py` proposes a map's `scale`/`origin` from where players actually walked,
  so it under-estimates any border nobody enters — it lands within ~10% on the three
  known maps. It is a starting point for the visual contact sheet, not an answer.
- The ETL is a full rebuild; there is no incremental ingest. At 1,243 files it takes ~20 s,
  so this only matters alongside the sharding work above.
