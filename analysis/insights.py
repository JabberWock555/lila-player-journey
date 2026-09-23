#!/usr/bin/env python3
"""
Reproduce every number and figure in INSIGHTS.md.

    python3 analysis/insights.py --src /path/to/player_data

Reads the raw parquet with the same normalisation as etl/build_data.py, prints
the statistics behind each insight (including the checks that decided what to
claim and what to drop), and writes the figures to docs/.

Definitions used throughout
---------------------------
* human   — a journey whose user_id is a UUID (the README's rule).
* death   — a Killed, BotKilled or KilledByStorm event in a *human* file. Bot
            files also contain BotKilled rows; there they are the bot's own
            death (one per bot journey, final event in 285 of 297), so they are
            excluded from every "death" figure.
* extract — a point where surviving runs end. Nothing in the data names
            extraction points; they are inferred from survivor end positions,
            which cluster to within a few units (see insight 2).
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
CONFIG = json.loads((REPO / "etl" / "config" / "dataset.json").read_text())
MAPS = {k: (v["scale"], v["originX"], v["originZ"]) for k, v in CONFIG["maps"].items()}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
DAY = re.compile(r"^[A-Za-z]+_\d{1,2}$")
POS = {"Position", "BotPosition"}
DEATH = {"Killed", "BotKilled", "KilledByStorm"}
RNG = np.random.default_rng(0)


# ----------------------------------------------------------------- loading

def load(src: Path) -> pd.DataFrame:
    frames = []
    for day in sorted(p for p in src.iterdir() if p.is_dir() and DAY.match(p.name)):
        for f in sorted(day.iterdir()):
            if not f.name.startswith("."):
                frames.append(pq.read_table(f).to_pandas())
    df = pd.concat(frames, ignore_index=True)
    df["event"] = df.event.str.decode("utf-8")
    df["t"] = df.ts.astype("int64")                      # Unix seconds, see ARCHITECTURE.md
    df["match_id"] = df.match_id.str.replace(r"\.nakama-\d+$", "", regex=True)
    df["is_bot"] = ~df.user_id.str.match(UUID)
    key = ["user_id", "match_id", "t", "event", "x", "y", "z"]
    df = df[~(df.event.isin(POS) & df.duplicated(key, keep="first"))].copy()
    s = df.map_id.map(lambda m: MAPS[m][0])
    df["u"] = (df.x - df.map_id.map(lambda m: MAPS[m][1])) / s
    df["v"] = (df.z - df.map_id.map(lambda m: MAPS[m][2])) / s
    return df.reset_index(drop=True)


def grid(g: pd.DataFrame, n: int) -> np.ndarray:
    """Counts on an n x n grid in image orientation (row 0 = top of the minimap)."""
    ok = (g.u >= 0) & (g.u <= 1) & (g.v >= 0) & (g.v <= 1)
    gx = np.minimum(n - 1, (g.u[ok] * n).astype(int))
    gy = np.minimum(n - 1, ((1 - g.v[ok]) * n).astype(int))
    h = np.zeros((n, n))
    np.add.at(h, (gy, gx), 1)
    return h


def cell_world(m: str, i: int, j: int, n: int) -> tuple[int, int]:
    sc, ox, oz = MAPS[m]
    return round((j + .5) / n * sc + ox), round((1 - (i + .5) / n) * sc + oz)


def runs_table(hum: pd.DataFrame) -> pd.DataFrame:
    h = hum.sort_values("t")
    g = h.groupby(["map_id", "match_id", "user_id"])
    r = g.agg(t0=("t", "min"), t1=("t", "max"),
              died=("event", lambda e: e.isin(DEATH).any()),
              bot=("event", lambda e: (e == "BotKilled").any()),
              storm=("event", lambda e: (e == "KilledByStorm").any()),
              loot=("event", lambda e: int((e == "Loot").sum())),
              kills=("event", lambda e: int((e == "BotKill").sum()))).reset_index()
    last = g[["x", "z"]].last().reset_index()
    r = r.merge(last, on=["map_id", "match_id", "user_id"])
    r["dur"] = r.t1 - r.t0
    return r


def cluster(points: np.ndarray, radius: float, min_size: int = 3) -> list[tuple[np.ndarray, int]]:
    """Greedy density clustering: seed at the densest point, absorb everything within radius."""
    left = np.ones(len(points), bool)
    out = []
    while left.any():
        idx = np.where(left)[0]
        q = points[idx]
        d = np.hypot(q[:, None, 0] - q[None, :, 0], q[:, None, 1] - q[None, :, 1])
        seed = idx[(d < radius).sum(1).argmax()]
        mem = idx[np.hypot(points[idx, 0] - points[seed, 0], points[idx, 1] - points[seed, 1]) < radius]
        out.append((points[mem].mean(0), len(mem)))
        left[mem] = False
    return sorted([c for c in out if c[1] >= min_size], key=lambda c: -c[1])


def poisson_sf(k: int, lam: float) -> float:
    return 1 - sum(math.exp(-lam) * lam ** i / math.factorial(i) for i in range(k))


def fisher_greater(a: int, b: int, c: int, d: int) -> float:
    n, r1, c1 = a + b + c + d, a + b, a + c
    return sum(math.comb(r1, k) * math.comb(n - r1, c1 - k)
               for k in range(a, min(r1, c1) + 1)) / math.comb(n, c1)


# ------------------------------------------------------------------ insights

def insight_1(df: pd.DataFrame, hum: pd.DataFrame, runs: pd.DataFrame) -> None:
    print("\n=== 1. One player per match, and no PvP at all ===")
    humans = hum.groupby("match_id").user_id.nunique()
    matches = df.match_id.unique()
    print(f"matches {len(matches)}: exactly one UUID player {int((humans == 1).sum())}, "
          f"two {int((humans == 2).sum())}, none {len(matches) - len(humans)}")

    bots = df[df.is_bot]
    humanlike = bots.groupby(["match_id", "user_id"]).event.agg(lambda e: "Position" in set(e))
    humanlike = humanlike[humanlike].reset_index()
    zero = set(matches) - set(humans.index)
    print(f"numeric-id journeys emitting Position/Loot (not BotPosition): {len(humanlike)} "
          f"from ids {sorted(humanlike.user_id.unique(), key=int)}; "
          f"{int(humanlike.match_id.isin(zero).sum())} of them sit in the {len(zero)} zero-UUID matches, "
          f"one per match: {len(zero & set(humanlike.match_id)) == len(zero)}")

    pv = hum[hum.event.isin(["Kill", "Killed"])]
    pairs = pv.groupby(["match_id", "user_id"]).agg(n=("event", "size"),
                                                     same_t=("t", lambda t: t.nunique() == 1),
                                                     same_xy=("x", lambda x: x.nunique() == 1))
    print(f"Kill/Killed rows {len(pv)} -> {len(pairs)} (match, player) pairs; each pair is one player "
          f"logging both at the same second & spot: {bool((pairs.n == 2).all() and pairs.same_t.all() and pairs.same_xy.all())}; "
          f"human files in those matches: {sorted(set(humans[pairs.reset_index().match_id]))}")

    print(f"human runs {len(runs)}: died {runs.died.mean():.1%} "
          f"(to bots {runs.bot.mean():.1%}, storm {runs.storm.mean():.1%}, self {int((runs.died & ~runs.bot & ~runs.storm).sum())} runs)")
    print(f"human kills: BotKill {int((hum.event == 'BotKill').sum())}; kills of another human: 0")

    st = hum.groupby("match_id").agg(map=("map_id", "first"), t0=("t", "min"), t1=("t", "max"))
    for m, g in st.groupby("map"):
        ev = sorted([(t, 1) for t in g.t0] + [(t, -1) for t in g.t1])
        cur = peak = 0
        multi = 0.0
        last = None
        for t, d in ev:
            if last is not None and cur >= 2:
                multi += t - last
            cur += d
            peak = max(peak, cur)
            last = t
        print(f"  {m:14} peak concurrent separate matches {peak}; hours with >=2 running at once {multi / 3600:.1f}")

    def close(t, w):
        return int((np.diff(np.sort(t)) <= w).sum())
    obs = {w: sum(close(g.t0.values, w) for _, g in st.groupby("map")) for w in (5, 60)}
    sims = {w: [] for w in obs}
    for _ in range(2000):
        tot = dict.fromkeys(obs, 0)
        for _, g in st.groupby("map"):
            hr = (g.t0.values // 3600) * 3600
            t = hr + RNG.uniform(0, 3600, len(hr))
            for w in obs:
                tot[w] += close(t, w)
        for w in obs:
            sims[w].append(tot[w])
    for w in obs:
        s = np.array(sims[w])
        print(f"  same-map match starts within {w:2}s: observed {obs[w]}, random-arrival null {s.mean():.1f} "
              f"(95% {np.percentile(s, 2.5):.0f}-{np.percentile(s, 97.5):.0f}) -> no excess, no sign of split lobbies")


def insight_2(hum: pd.DataFrame, runs: pd.DataFrame, figs: Path) -> None:
    print("\n=== 2. Staying late is equally common everywhere; on Lockdown it is ~3x deadlier ===")
    s = runs[runs.storm]
    print(f"storm deaths {len(s)}: {s.dur.min()}-{s.dur.max()}s into the run, median {s.dur.median():.0f}s")
    amb = runs[runs.map_id == "AmbroseValley"]
    amb_late = amb[amb.dur >= 650]
    for m in MAPS:
        r = runs[runs.map_id == m]
        late = r[r.dur >= 650]
        if m == "AmbroseValley":
            p1 = p2 = ""
        else:
            p1 = f"  p={fisher_greater(int(r.storm.sum()), int((~r.storm).sum()), int(amb.storm.sum()), int((~amb.storm).sum())):.4f}"
            p2 = f"  p={fisher_greater(int(late.storm.sum()), int((~late.storm).sum()), int(amb_late.storm.sum()), int((~amb_late.storm).sum())):.3f}"
        print(f"  {m:14} all runs: storm {int(r.storm.sum()):2}/{len(r):3} = {r.storm.mean():5.1%}{p1:<12}"
              f"| still in at 650s: {len(late):3} ({len(late) / len(r):.0%}), of whom storm-killed {late.storm.mean():.0%}{p2}")

    # Were storm victims idle, or trying to get out?
    pos = hum[hum.event == "Position"].sort_values("t")
    pos = pos.join(runs.set_index(["match_id", "user_id"])[["t1"]], on=["match_id", "user_id"])
    fin = pos[pos.t >= pos.t1 - 60]
    dist = fin.groupby(["match_id", "user_id"]).apply(
        lambda g: float(np.hypot(np.diff(g.x.values), np.diff(g.z.values)).sum())).rename("d")
    r2 = runs.join(dist, on=["match_id", "user_id"])
    grp = np.where(r2.storm, "storm victim", np.where(r2.died, "killed by bot", "survived"))
    print("  distance moved in the final 60s (median units):")
    print(r2.assign(g=grp).groupby(["map_id", "g"]).d.median().unstack().round(0).to_string(
        header=True).replace("\n", "\n    ").join(["    ", ""]))
    sv = r2[r2.storm].d.dropna()
    print(f"  storm victims moving >= 20 units in their last minute: {int((sv >= 20).sum())}/{len(sv)}; "
          f"their median loot {runs[runs.storm].loot.median():.0f} vs survivors {runs[~runs.died].loot.median():.0f}")

    # Extraction points, and why distance-to-exit is not claimed.
    print("  inferred extraction points (survivor end-point clusters, radius 3% of map width):")
    for m in MAPS:
        r = runs[runs.map_id == m]
        surv = r[~r.died]
        ex = cluster(surv[["x", "z"]].values, MAPS[m][0] * 0.03)
        big = [(c, n) for c, n in ex if n / len(surv) >= 0.05]
        cells = []
        for keep in (ex, big):
            pts = np.array([c for c, _ in keep])
            posm = hum[(hum.map_id == m) & (hum.event == "Position")]
            d = np.min(np.hypot(posm.x.values[:, None] - pts[None, :, 0], posm.z.values[:, None] - pts[None, :, 1]), axis=1)
            cells.append(f"{len(pts)} pts -> median play-to-exit {np.median(d):.0f}")
        print(f"    {m:14} {sum(n for _, n in ex) / len(surv):.0%} of survivors end in one | all clusters: {cells[0]} | "
              f">=5% clusters: {cells[1]}")
    print("    -> play-to-exit distance flips with the cluster threshold, so it is not used as evidence")

    print("  where storm victims died:")
    for m in MAPS:
        r = runs[runs.map_id == m]
        st = r[r.storm]
        surv = r[~r.died]
        big = np.array([c for c, n in cluster(surv[["x", "z"]].values, MAPS[m][0] * 0.03) if n / len(surv) >= 0.05])
        d = np.min(np.hypot(st.x.values[:, None] - big[None, :, 0], st.z.values[:, None] - big[None, :, 1]), axis=1)
        east = int((st.x > MAPS[m][1] + MAPS[m][0] / 2).sum())
        print(f"    {m:14} {len(st):2} deaths: east half of the map {east}; within 30 units of an extraction point {int((d <= 30).sum())}")

    tiles = []
    for m in ("AmbroseValley", "Lockdown"):
        r = runs[runs.map_id == m]
        surv = r[~r.died]
        big = [(c, n) for c, n in cluster(surv[["x", "z"]].values, MAPS[m][0] * 0.03) if n / len(surv) >= 0.05]
        tiles.append(_storm_tile(m, big, r[r.storm], fin, len(surv)))
    _save_row(tiles, figs / "insight-storm-extraction.png", [
        ((250, 204, 21), "storm victim: path over their final 60 s, ending where the storm caught them"),
        ((255, 255, 255), "extraction point (share of survivors, >= 5%)"),
    ])


def insight_3(hum: pd.DataFrame, runs: pd.DataFrame, figs: Path) -> None:
    print("\n=== 3. Deaths concentrate at a few fights, and dying costs most of the run ===")
    n = 24
    tiles = []
    for m in MAPS:
        tr = grid(hum[(hum.map_id == m) & (hum.event == "Position")], n)
        de = grid(hum[(hum.map_id == m) & hum.event.isin(DEATH)], n)
        ki = grid(hum[(hum.map_id == m) & (hum.event == "BotKill")], n)
        flat = np.sort(de.ravel())[::-1]
        rate = de.sum() / tr.sum()
        tested = int((tr >= 150).sum())
        print(f"{m}: {int(de.sum())} human deaths; top 3 of {n*n} cells hold {flat[:3].sum() / de.sum():.0%}; "
              f"map rate {rate * 1000:.2f} per 1k position samples; map kills per death {ki.sum() / de.sum():.1f}; "
              f"cells tested (>=150 samples) {tested}")
        spots = []
        for i in range(n):
            for j in range(n):
                if tr[i, j] >= 150 and de[i, j] >= 6:
                    lam = tr[i, j] * rate
                    p = min(1.0, poisson_sf(int(de[i, j]), lam) * tested)   # Bonferroni
                    spots.append((p, i, j, int(de[i, j]), lam, ki[i, j] / de[i, j]))
        for p, i, j, d, lam, kd in sorted(spots)[:3]:
            print(f"   {cell_world(m, i, j, n)}: {d} deaths vs {lam:.1f} expected ({d / lam:.1f}x), "
                  f"corrected p={p:.3f}, kills/death here {kd:.1f}")
        if m in ("AmbroseValley", "Lockdown"):
            tiles.append(_death_tile(m, hum, spots, n))
    _save_row(tiles, figs / "insight-lethality.png", [
        ((255, 190, 70), "significant hotspot (Bonferroni p < 0.05)"),
        ((140, 140, 150), "above average but not significant"),
        ((200, 120, 255), "human death"),
    ])

    for died, g in runs.groupby("died"):
        print(f"  {'died    ' if died else 'survived'} n={len(g)}  median length {g.dur.median():.0f}s  "
              f"loot {g.loot.median():.0f}  kills {g.kills.median():.0f}")
    lt = hum[hum.event == "Loot"].join(runs.set_index(["match_id", "user_id"])[["t0", "t1"]],
                                       on=["match_id", "user_id"])
    frac = ((lt.t - lt.t0) / (lt.t1 - lt.t0).replace(0, np.nan)).dropna()
    q = [((frac >= a) & ((frac < a + .25) if a < .75 else (frac <= 1))).mean() for a in (0, .25, .5, .75)]
    print("  loot by quarter of the run: " + " / ".join(f"{x:.0%}" for x in q))


# ------------------------------------------------------------------- figures

T = 620


def _font(size):
    for f in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        with contextlib.suppress(OSError):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


F, FS = _font(22), _font(16)


def _base(m, dim=0.7):
    im = Image.open(REPO / "public" / "maps" / f"{m}.webp").convert("RGB").resize((T, T), Image.LANCZOS)
    return Image.blend(Image.new("RGB", (T, T), (8, 9, 12)), im, dim).convert("RGBA")


def _land(m, k):
    """Land mask from the minimap (void and open water excluded) — same rule as the app."""
    a = np.asarray(Image.open(REPO / "public" / "maps" / f"{m}.webp").convert("RGB")
                   .resize((k, k), Image.BILINEAR)).astype(float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    return (~((lum < 28) | ((b > r + 35) & (g > r + 25) & (lum > 40)))).astype(float)


def _to_px(m, x, z):
    sc, ox, oz = MAPS[m]
    return (x - ox) / sc * T, (1 - (z - oz) / sc) * T


def _title(im, text):
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, T, 40], fill=(0, 0, 0, 200))
    d.text((12, 9), text, font=F, fill=(235, 235, 235))


def _label(d, placed, circles, box_c, text, color):
    w, h = d.textlength(text, font=FS) + 12, 24
    x0, y0, x1, y1 = box_c
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hit = lambda a, b: not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])
    for bx, by in ((x1 + 4, cy - h / 2), (x0 - 4 - w, cy - h / 2), (cx - w / 2, y1 + 4), (cx - w / 2, y0 - 4 - h)):
        box = (bx, by, bx + w, by + h)
        if box[0] >= 0 and box[2] <= T and not any(hit(box, o) for o in circles + placed):
            break
    placed.append(box)
    d.rectangle(box, fill=(0, 0, 0, 215))
    d.text((box[0] + 6, box[1] + 3), text, font=FS, fill=color)


def _storm_tile(m, extracts, storm_runs, final_minute, n_surv):
    im = _base(m, 0.75)
    dr = ImageDraw.Draw(im)
    for (_, row) in storm_runs.iterrows():
        tail = final_minute[(final_minute.match_id == row.match_id) & (final_minute.user_id == row.user_id)]
        pts = [_to_px(m, x, z) for x, z in zip(tail.x, tail.z)]
        if len(pts) > 1:
            dr.line(pts, fill=(250, 204, 21, 220), width=3)
        px, py = _to_px(m, row.x, row.z)
        dr.polygon([(px, py - 8), (px + 7, py + 5), (px - 7, py + 5)], fill=(250, 204, 21, 255), outline=(0, 0, 0, 255))
    for (x, z), nn in extracts:
        px, py = _to_px(m, x, z)
        dr.ellipse([px - 8, py - 8, px + 8, py + 8], fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), width=2)
        tx = f"{nn / n_surv:.0%}"
        dr.rectangle([px + 10, py - 11, px + 16 + dr.textlength(tx, font=FS), py + 11], fill=(0, 0, 0, 190))
        dr.text((px + 13, py - 9), tx, font=FS, fill=(255, 255, 255))
    _title(im, f"{m} — {len(storm_runs)} storm deaths")
    return im


def _death_tile(m, hum, spots, n):
    im = _base(m)
    d = ImageDraw.Draw(im)
    dd = hum[(hum.map_id == m) & hum.event.isin(DEATH)]
    for u, v in zip(dd.u, dd.v):
        x, y = u * T, (1 - v) * T
        d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(200, 120, 255, 170))
    r = T / n * 0.9
    chosen = sorted(spots)[:3]
    circles = [((j + .5) / n * T - r, (i + .5) / n * T - r, (j + .5) / n * T + r, (i + .5) / n * T + r)
               for _, i, j, *_ in chosen]
    placed = []
    for (p, i, j, deaths, lam, kd), c in zip(chosen, circles):
        sig = p < 0.05
        col = (255, 190, 70) if sig else (140, 140, 150)
        d.ellipse(c, outline=col + (255,), width=4 if sig else 2)
        ptxt = "p<0.001" if p < 0.001 else f"p={p:.2f}"
        _label(d, placed, circles, c, f"{deaths} vs {lam:.1f} expected · {ptxt}", col)
    _title(im, f"{m} — human deaths")
    return im


def _save_row(tiles, path, legend):
    out = Image.new("RGB", (T * len(tiles) + 10 * (len(tiles) + 1), T + 60), (8, 9, 12))
    for k, t in enumerate(tiles):
        out.paste(t, (10 + k * (T + 10), 10))
    d = ImageDraw.Draw(out)
    x = 14
    for col, text in legend:
        d.ellipse([x, T + 28, x + 14, T + 42], fill=col)
        d.text((x + 22, T + 25), text, font=FS, fill=(200, 200, 200))
        x += 50 + d.textlength(text, font=FS)
    out.save(path, optimize=True)
    print(f"  wrote {path.relative_to(REPO)}")


# ------------------------------------------------------------ checks dropped

def dropped_claims(df: pd.DataFrame, hum: pd.DataFrame, runs: pd.DataFrame) -> None:
    print("\n=== Tested and not claimed ===")
    # Is Lockdown's late-game storm problem localised? Compare late players by where they were at 650 s.
    pos = hum[hum.event == "Position"].join(runs.set_index(["match_id", "user_id"])[["t0"]], on=["match_id", "user_id"])
    for m in ("AmbroseValley", "Lockdown"):
        r = runs[(runs.map_id == m) & (runs.dur >= 650)]
        p = pos[pos.map_id == m]
        at = p[(p.t - p.t0) <= 650].sort_values("t").groupby(["match_id", "user_id"]).x.last().rename("x650")
        r = r.join(at, on=["match_id", "user_id"])
        mid = MAPS[m][1] + MAPS[m][0] / 2
        e, w = r[r.x650 > mid], r[r.x650 <= mid]
        print(f"  {m:14} late players storm-killed: west {int(w.storm.sum())}/{len(w)}, east {int(e.storm.sum())}/{len(e)} "
              f"-> not localised to one side")
    # Dead space at equal sample size: Grand Rift has 57 matches, the others far more.
    for m in MAPS:
        g = df[(df.map_id == m) & df.event.isin(POS)]
        ids = g[~g.is_bot].match_id.unique()
        vals = []
        for _ in range(200 if len(ids) > 57 else 1):
            pick = ids if len(ids) <= 57 else RNG.choice(ids, 57, replace=False)
            vals.append(int((grid(g[g.match_id.isin(pick)], 96) > 0).sum()))
        print(f"  {m:14} visited cells, 57 matches: {np.mean(vals):.0f}   "
              f"all {len(ids)} matches: {int((grid(g[g.match_id.isin(ids)], 96) > 0).sum())}")
    print("  -> coverage tracks sample size; Grand Rift's larger dead space is not evidence of a worse map")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default=str(Path.home() / "Downloads" / "player_data"))
    ap.add_argument("--figs", default=str(REPO / "docs"))
    args = ap.parse_args()
    figs = Path(args.figs)
    figs.mkdir(exist_ok=True)

    df = load(Path(args.src).expanduser())
    hum = df[~df.is_bot]
    runs = runs_table(hum)
    print(f"{len(df):,} events, {df.match_id.nunique()} matches, {len(runs)} human runs")
    insight_1(df, hum, runs)
    insight_2(hum, runs, figs)
    insight_3(hum, runs, figs)
    dropped_claims(df, hum, runs)


if __name__ == "__main__":
    sys.exit(main())
