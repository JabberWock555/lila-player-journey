# Three things the data told me

All figures come from the shipped dataset (88,894 events, 796 matches, 245 human players,
Feb 9–14 2026) and are reproducible in the tool. Reproduction steps are given per insight.

---

## 1. LILA BLACK is being played as a solo PvE game, not an extraction shooter

**What caught my eye.** I selected a match to test playback and got a single cyan path. Then
another. Then another. The "Journeys" counter never showed more than one human.

**The evidence.**

| Measure | Value |
|---|---|
| Matches with exactly **1** human | **779 / 796 (97.9%)** |
| Matches with 2 humans | 1 |
| Matches with 0 humans (bot-only files) | 16 |
| `Kill` events (human kills human) | **3** |
| `Killed` events (human killed by human) | **3** |
| `BotKill` events (human kills bot) | 2,415 |
| Share of all kills that are against bots | **99.88%** |

Three player-versus-player kills across five days and 89k events. The PvP layer of an
extraction shooter is, in this window, statistically nonexistent.

It is worth separating two possible causes, because they lead to different fixes:
matchmaking may genuinely be placing players in solo lobbies, or the telemetry may be
sharded such that concurrent humans land in different `match_id`s. The second is worth ruling
out first — but the kill events argue for the first, since a human killed by another human
would still log `Killed` in their own file regardless of how matches are keyed, and that fires
three times total.

**Reproduce it.** Open any date, click through matches in the sidebar; "Journeys" reads
`1 human · N bot` almost every time. Selection totals for all of Ambrose Valley show
1,799 kills against 488 combat deaths, with the human-vs-human events invisible at that
scale.

**Actionable?** Yes, and it reframes the level-design brief.

- **Verify first:** confirm whether this is matchmaking behaviour or a telemetry sharding
  artefact. Everything below depends on that answer.
- **If it is real:** contested-space design is currently dead weight. Multi-entrance
  chokepoints, third-party sightlines, loot contention at high-value POIs and rotation
  denial all assume opponents who are not there. Those areas should be retuned for solo
  pacing against bots — encounter spacing, cover for one-versus-many, escape routes —
  rather than for PvP standoffs.
- **Bot placement becomes the primary difficulty lever**, not player density. Bot spawn
  density and patrol routes are doing all the work that PvP was meant to do.

**Metrics affected:** humans per match, PvP engagement rate, time-to-first-contact,
encounters per run, extraction rate.

**Why a level designer should care.** You are tuning a map for a threat model that is not
occurring. Every hour spent balancing PvP sightlines is returning nothing right now, and the
bot encounter layout — which nobody is treating as the main event — is what players actually
experience.

---

## 2. Roughly half of every map is space nobody ever enters

**What caught my eye.** The traffic heatmap shows bright POI cores joined by thin filaments,
with large tracts of drawn, detailed map completely dark. The Dead space overlay quantifies it.

**The evidence.** 96×96 grid; "playable" = within ~6 cells of somewhere a player actually
stood (a conservative floor — see ARCHITECTURE.md).

| Map | Playable cells | Never visited | Top 1% of cells carry | Top 5% carry |
|---|---|---|---|---|
| Ambrose Valley | 5,581 | **2,303 (41%)** | 23% of traffic | 53% |
| Lockdown | 4,270 | **2,110 (49%)** | 21% | 59% |
| Grand Rift | 4,841 | **2,936 (61%)** | 22% | 57% |

Two failures at once: **41–61% of reachable space gets zero traffic**, and of the space that
is used, **the top 5% of cells absorb over half of all movement**. Players funnel through a
small number of POIs and the roads between them.

Grand Rift is the worst on both counts and also the least played (59 matches vs Ambrose's
566) — the map players avoid is the map they use least of.

**Reproduce it.** Select a map, set heatmap to **Dead space**. The panel prints unvisited
playable area for the current filter (41% on Ambrose with no filters). Switch to **Traffic**
to see the concentration directly.

**Actionable?** Yes — this is the clearest art-and-layout ROI signal in the dataset.

- **Audit the cold regions against the art budget.** Fully modelled terrain nobody walks
  through is spent effort and shipped download size.
- **Pull players into cold space or cut it.** The cheap lever is relocating loot spawns and
  extraction points into cold cells and re-checking the heatmap a week later; the expensive
  one is compressing the playable bounds.
- **Grand Rift needs the decision first**, at 61% unused and the lowest play rate.
- **Sanity-check the storm.** A one-directional storm systematically sweeping the same axis
  will produce exactly this pattern by making one side of the map never worth entering.

**Metrics affected:** map area utilisation %, traffic Gini/concentration, POI visit
distribution, average distance travelled per run, per-map match share.

**Why a level designer should care.** This is a direct map of where your work is and is not
being seen, with a number attached. It tells you which POIs to cut, which to connect, and
where a new route would actually change behaviour — and it re-measures in one click after a
change.

---

## 3. Death is sharply localised, and dying costs players most of their run

**What caught my eye.** The death heatmap is not a diffuse field like traffic — it is a few
hard points. And comparing runs that ended in death against runs that did not showed two
very different games.

**The evidence.**

Spatial concentration (24×24 grid):

| Map | Deaths | Top 3 cells | Top 10 cells |
|---|---|---|---|
| Ambrose Valley | 505 | **20%** | 42% |
| Lockdown | 185 | 22% | 44% |
| Grand Rift | 52 | 27% | 58% |

*"Deaths" here means all causes. The tool reports the two separately, since they are
different design problems — Ambrose Valley reads `DEATHS 488` (killed by a bot or player)
plus `STORM 17`, which is the 505 above.*

Normalising deaths by traffic isolates cells that are lethal *beyond* their popularity —
these are difficulty spikes, not just busy places:

| Map | World (x, z) | Deaths per 1k position samples | Traffic | Kills | Deaths |
|---|---|---|---|---|---|
| Ambrose Valley | ≈ (−51, −79) | **56.6** | 548 | 46 | 31 |
| Ambrose Valley | ≈ (−14, −4) | 35.2 | 993 | 75 | 35 |
| Lockdown | ≈ (104, −21) | 49.1 | 407 | 36 | 20 |
| Lockdown | ≈ (−62, −146) | **78.4** | 102 | 2 | 8 |

That last row is the interesting one: high lethality, low traffic, and almost **no kills** —
players die there and rarely win. It behaves like a trap rather than a fight.

What dying costs, across 781 human runs (56.6% end in death):

| | Survived / extracted | Died |
|---|---|---|
| Median run length | **512 s** | 286 s |
| Median items looted | **22** | 9 |

A death ends the run at roughly the halfway mark with **41% of the loot**. All death events
sit at progress ≈ 1.0 — death terminates the journey, so there is no recovery arc.

The storm is a minor cause overall (5.0% of runs) but is **3× more lethal on Lockdown (10.0%)
and Grand Rift (8.8%) than on Ambrose Valley (3.1%)** — the same storm mechanic, very
different pressure depending on map geometry.

**Reproduce it.** Set heatmap to **Death zones**, then compare against **Kill zones** on the
same filter: the places where players die and the places they win diverge sharply. Zoom in
and hover markers for exact world coordinates; the readout under the cursor gives the
position to take back into the editor.

**Actionable?** Yes, and it is the most immediately fixable.

- **Treat the top 3 cells per map as a difficulty-review list.** They carry ~20% of all
  deaths in a fraction of a percent of the area.
- **Separate the two failure modes.** High-lethality/high-kill cells are working combat
  arenas that may just be overtuned. High-lethality/**low**-kill cells like Lockdown
  (−62, −146) are unfair geometry — bad cover, an ambush angle, or a drop players cannot
  read — and should be inspected first.
- **Re-examine storm timing per map.** Ambrose's storm barely registers while Lockdown's
  kills one run in ten. Either Ambrose's storm is inert or Lockdown's geometry does not give
  players a viable route out.
- **Watch the loot curve.** Looting is spread evenly across a run (26/29/27/18% by quarter),
  so an early death is a linear loss of progression — which makes early-run death spikes
  disproportionately damaging to retention.

**Metrics affected:** death rate (currently 56.6%), deaths per POI per 1k visits,
median run length, loot per run, extraction rate, storm death share by map.

**Why a level designer should care.** It converts "this area feels unfair" into a ranked list
with world coordinates, separates overtuned-but-working arenas from genuinely broken
geometry, and quantifies the cost of each death in the progression players lose.

---

### Footnote on volume

Unique daily human players fall steadily across the window — 98 → 80 → 59 → 47 → 12 (Feb 14 is
a partial day and not comparable). Five days of a single cohort cannot separate a retention
problem from a shrinking test population, so I have not drawn a conclusion from it — but if
this is an open cohort rather than a closed playtest, it is the first thing I would
instrument next, cross-referenced against the death-rate and dead-space findings above.
