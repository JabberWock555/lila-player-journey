# Engineering notes

Detail behind [ARCHITECTURE.md](../ARCHITECTURE.md), which is kept to one page. Nothing here is needed to use the tool; it is here for whoever maintains it.

## Binary layout detail

Rows are sorted so every **(match, player) journey is one contiguous slice**, described by an
`(offset, length)` pair in the manifest. Drawing a player's path is a straight walk over a
range — no grouping or lookup at runtime.

`Uint16Array` needs an even byte offset, and the `ev` block is `n` bytes, so an odd `n` leaves
the following blocks misaligned. `src/lib/data.ts` copies those two blocks when that happens
rather than silently producing garbage.

## Playing several matches together

779 of 796 matches contain exactly one human, so
comparing runs means comparing *matches*, not players within one. Several matches can be
selected and played together, but their `ts` values are absolute Unix seconds and can sit
hours apart — played on one wall-clock axis they would be strung out with nothing visible
at any given moment. So whenever more than one match is in scope, `selectEvents` rebases
each onto its own `t0` and everything downstream (paths, markers, timeline histogram,
scrubber) reads that relative time. The timeline labels this "synced from each match
start" so the axis is never mistaken for wall clock. A side effect: the aggregate density
strip now reads as *events by time-into-match* across every match, which is a more useful
axis than the six-day span it replaced.



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

## Caching, and a bug it caused

Vite content-hashes everything under `/assets`, so those are served `immutable` for a
year. The telemetry is different: `/data/*.bin`, `/data/manifest.json` and `/maps/*.webp`
sit at **stable paths** and are replaced in place whenever the ETL re-runs.

The first deploy cached them for 5 minutes with a week-long `stale-while-revalidate`.
That looked like a reasonable latency/freshness trade, and it was wrong. Across the next
deploy a browser paired its cached *old* manifest with the *new* content-hashed JS, and
the app failed outright — the old manifest had no `events` block for the new code to read.

The silent version of that failure is worse. `manifest.json` holds the `(offset, length)`
slice for every journey; an old `.bin` with a new manifest would not error at all, it
would just draw the wrong events at the wrong coordinates.

So `/data` and `/maps` are now `max-age=0, must-revalidate`. With ETags a repeat visit is
eight conditional requests returning `304` with no body — a few hundred milliseconds,
paid once per load, in exchange for never rendering data from a different build than the
code reading it. For a tool whose entire job is showing the truth about a dataset, that
is the right side of the trade.

Two guards back it up, because a proxy could still serve something stale:
`loadManifest()` rejects a manifest missing any key the app needs and says a hard reload
will fix it, and `decode()` checks each binary's byte length against `count × 21` from
the manifest and refuses to render if they disagree.

## The data studio

Adding a map or a day of telemetry used to mean editing `dataset.json` by hand and running
the ETL blind. The **+ Data** panel removes the guesswork from both halves without
pretending the static deploy can do something it cannot.

**Calibrating a map** is the part worth having in a UI. It draws the minimap with real
recorded positions on top and re-projects live as `scale` / `originX` / `originZ` change,
so the alignment is judged the only way it can be — by whether traffic follows the roads.
**Fit to data** runs the same padded-extent heuristic as `etl/calibrate_map.py`. The panel
shows what share of events land inside the frame, with the caveat stated next to it: a
uniformly shifted box still contains every point, so the percentage rules out gross errors
and nothing more. The output is the `dataset.json` block, ready to paste.

**Importing telemetry** parses dropped `.nakama-0` files in the browser with `hyparquet`
(dynamically imported, so its ~170 kB gzipped never loads for anyone who does not open the
panel) and applies the same normalisation as `etl/build_data.py` — `ts` as Unix seconds,
bots by `user_id` shape, `.nakama-N` stripped, only redundant *position* duplicates
dropped. It reports events per map, unknown event types, unconfigured `map_id`s, the date
range and the out-of-bounds rate. Verified against the pipeline: three Feb 14 files give
395 events, 0 dropped duplicates and 0.00% out of bounds from both the browser and Python.

What it deliberately does not do is persist. The deploy is a static bundle with no backend
and no write access to the repo, so the honest boundary is: the studio tells you the
config is right and the data is clean, and the ETL commits it. Claiming otherwise would
mean an import that silently vanished on reload.

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

## Dead-space measurement

The first version counted a cell as playable if it was within 6 cells of anywhere a player
stood. Drawn over the minimap, that visibly included a halo over the black void and all of
Lockdown's sea, and nearly doubled Ambrose Valley's figure (41% vs 22%). Walkable area is now
read from the minimap itself — land that is neither near-black void nor open water — plus any
cell someone actually stood in, since traffic proves walkability. The panel reports two
numbers: interior (at least 3 cells from the coast) and including the coastal rim, which may
be cliff. `src/lib/heatmap.ts` and `analysis/insights.py` use the same thresholds.

Coverage still depends heavily on how many matches are in view — see the "tested and not
claimed" section of INSIGHTS.md before comparing maps with different amounts of data.

## Known limits

- **1 Hz sampling.** Sub-second movement is not recoverable; paths interpolate between
  one-second samples. Gaps over 25 s break the polyline rather than drawing a false straight
  line across the map.
- **Bot telemetry is sparse.** Only 94 distinct bots have files at all, and the median match
  has none — bot heatmaps represent the sampled subset, not the full bot population.
- **There is no PvP in the data.** The only `Kill`/`Killed` events are three self-inflicted
  deaths (one player logging both at the same second and spot), so "kill zones" are entirely
  player-vs-bot zones. See INSIGHTS.md.
- **The Deaths tile counts bot deaths while Bots is on.** In bot files `BotKilled` is the bot's
  own death. Turn Bots off for human-only deaths, which is what INSIGHTS.md uses.
- **Grand Rift's minimap is 2160×2158**, not square. It is treated as square UV space; the
  0.09% vertical error is well below one grid cell.
- Tuned for desktop. It is a level-design workstation tool; there is no mobile layout.
- `calibrate_map.py` proposes a map's `scale`/`origin` from where players actually walked,
  so it under-estimates any border nobody enters — it lands within ~10% on the three
  known maps. It is a starting point for the visual contact sheet, not an answer.
- The ETL is a full rebuild; there is no incremental ingest. At 1,243 files it takes ~20 s,
  so this only matters alongside the sharding work above.
