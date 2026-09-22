#!/usr/bin/env python3
"""
LILA BLACK — Player Journey ETL
================================

Reads the raw per-player parquet files, normalises them, and emits a compact
static bundle that the browser can load directly:

    public/data/manifest.json     index of maps / matches / journeys + aggregates
    public/data/<Map>.bin         columnar Float32/Uint32/Uint8 event arrays
    public/maps/<Map>.webp        downscaled minimap

Run:  python3 etl/build_data.py --src /path/to/player_data

Design notes
------------
* The whole dataset is ~89k events. That is small enough to ship to the client
  in full, so there is no query API and no server at runtime — the tool is a
  pure static site. All filtering/aggregation happens in the browser.
* Events are stored as parallel typed arrays (struct-of-arrays) rather than
  JSON objects: ~21 bytes/event instead of ~120, and they can be dropped
  straight into TypedArray views with zero parsing.
* Rows are sorted by (match, player, time) so every player-journey is one
  contiguous slice, described by an (offset, length) pair in the manifest.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # the source minimaps are up to 9000x9000

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

# From the dataset README. `scale` is the world-units width of the square that
# the minimap image covers; (origin_x, origin_z) is its bottom-left corner.
MAP_CONFIG = {
    "AmbroseValley": {"scale": 900, "originX": -370, "originZ": -473,
                      "label": "Ambrose Valley", "source": "AmbroseValley_Minimap.png"},
    "GrandRift":     {"scale": 581, "originX": -290, "originZ": -290,
                      "label": "Grand Rift",     "source": "GrandRift_Minimap.png"},
    "Lockdown":      {"scale": 1000, "originX": -500, "originZ": -500,
                      "label": "Lockdown",       "source": "Lockdown_Minimap.jpg"},
}

# Stable ordering — the Uint8 codes in the binary are indices into this list.
EVENT_TYPES = [
    "Position", "BotPosition", "Loot",
    "Kill", "Killed", "BotKill", "BotKilled", "KilledByStorm",
]
EVENT_CODE = {name: i for i, name in enumerate(EVENT_TYPES)}

POSITION_EVENTS = {"Position", "BotPosition"}
DEATH_EVENTS = {"Killed", "BotKilled", "KilledByStorm"}
KILL_EVENTS = {"Kill", "BotKill"}

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)

MINIMAP_MAX_PX = 2048  # downscaled output; the sources are 2k-9k and 3-12 MB


# --------------------------------------------------------------------------
# Load
# --------------------------------------------------------------------------

def load_raw(src: Path) -> pd.DataFrame:
    """Read every parquet file under the day folders into one DataFrame."""
    day_dirs = sorted(p for p in src.iterdir() if p.is_dir() and p.name.startswith("February_"))
    if not day_dirs:
        sys.exit(f"No February_* folders found under {src}")

    frames, skipped = [], []
    for day_dir in day_dirs:
        for path in sorted(day_dir.iterdir()):
            if path.name.startswith("."):
                continue
            try:
                frame = pq.read_table(path).to_pandas()
            except Exception as exc:  # a corrupt file must not kill the build
                skipped.append((path.name, str(exc)))
                continue
            frame["source_day"] = day_dir.name
            frame["source_file"] = path.name
            frames.append(frame)

    if skipped:
        print(f"  ! skipped {len(skipped)} unreadable file(s): {skipped[:3]}")
    if not frames:
        sys.exit("No readable parquet files found.")

    df = pd.concat(frames, ignore_index=True)
    print(f"  read {len(frames)} files -> {len(df):,} rows")
    return df


def normalise(df: pd.DataFrame) -> pd.DataFrame:
    """Decode, de-duplicate and derive the columns the frontend needs."""

    # `event` is stored as parquet binary; decode to str.
    df["event"] = df["event"].apply(
        lambda v: v.decode("utf-8") if isinstance(v, (bytes, bytearray)) else str(v)
    )

    unknown = set(df["event"].unique()) - set(EVENT_TYPES)
    if unknown:
        print(f"  ! unknown event types ignored: {unknown}")
        df = df[~df["event"].isin(unknown)]

    # ---- Timestamps -------------------------------------------------------
    # The column is typed timestamp[ms], but the underlying integers are Unix
    # *seconds* (e.g. 1_770_754_537). Read as ms they land in Jan 1970; read as
    # seconds they land in Feb 2026 and match the day folder they came from.
    # So: take the raw integer and treat it as seconds.
    df["ts_unix"] = df["ts"].astype("int64")
    df["datetime"] = pd.to_datetime(df["ts_unix"], unit="s", utc=True)

    folder_date = pd.to_datetime(
        df["source_day"].str.replace("February_", "2026-02-", regex=False), utc=True
    )
    drift = (df["datetime"].dt.normalize() - folder_date).abs().dt.total_seconds()
    mismatch = (drift > 86400).mean()
    print(f"  timestamp<->folder mismatch rate: {mismatch:.3%}")

    # ---- Identity ---------------------------------------------------------
    # Bot detection is by user_id shape, NOT by event name: the data contains
    # bots emitting plain `Position`/`Loot` and humans emitting `BotKilled`,
    # so the event name alone would misclassify ~750 rows.
    df["is_bot"] = ~df["user_id"].str.match(UUID_RE).fillna(False)

    # match_id carries the `.nakama-N` server-instance suffix; strip it so the
    # id matches the one in the filename and groups cleanly.
    df["match_id"] = df["match_id"].str.replace(r"\.nakama-\d+$", "", regex=True)

    df = df[df["map_id"].isin(MAP_CONFIG)].copy()

    # ---- Geometry ---------------------------------------------------------
    scale = df["map_id"].map(lambda m: MAP_CONFIG[m]["scale"]).astype("float64")
    ox = df["map_id"].map(lambda m: MAP_CONFIG[m]["originX"]).astype("float64")
    oz = df["map_id"].map(lambda m: MAP_CONFIG[m]["originZ"]).astype("float64")
    df["u"] = (df["x"] - ox) / scale
    df["v"] = (df["z"] - oz) / scale

    out_of_bounds = ((df.u < 0) | (df.u > 1) | (df.v < 0) | (df.v > 1)).mean()
    print(f"  events outside minimap UV bounds: {out_of_bounds:.3%}")

    # Identical rows occur, but they are only *redundant* for position samples
    # (a stationary player sampled twice inside the same one-second tick).
    # Repeated discrete events are real: 2.4k `Loot` rows duplicate in groups of
    # 2-7 at one tick and one spot, which is a container yielding several items.
    # Collapsing those would understate loot density, so only positions are
    # de-duplicated here.
    key = ["user_id", "match_id", "ts_unix", "event", "x", "y", "z"]
    is_pos = df["event"].isin(POSITION_EVENTS)
    redundant = is_pos & df.duplicated(subset=key, keep="first")
    if redundant.any():
        print(f"  dropped {int(redundant.sum()):,} redundant duplicate position samples")
    df = df[~redundant]

    df = df.sort_values(["map_id", "match_id", "user_id", "ts_unix"], kind="stable")
    return df.reset_index(drop=True)


# --------------------------------------------------------------------------
# Emit
# --------------------------------------------------------------------------

def build_map_bundle(map_id: str, g: pd.DataFrame, out_dir: Path) -> dict:
    """Write <Map>.bin and return the manifest entry for this map."""

    match_ids = list(dict.fromkeys(g["match_id"]))
    match_index = {m: i for i, m in enumerate(match_ids)}
    player_ids = list(dict.fromkeys(g["user_id"]))
    player_index = {p: i for i, p in enumerate(player_ids)}

    g = g.assign(
        _mi=g["match_id"].map(match_index),
        _pi=g["user_id"].map(player_index),
    ).sort_values(["_mi", "_pi", "ts_unix"], kind="stable")

    n = len(g)
    arrays = {
        "x":  g["x"].to_numpy(dtype="<f4"),
        "y":  g["y"].to_numpy(dtype="<f4"),
        "z":  g["z"].to_numpy(dtype="<f4"),
        "t":  g["ts_unix"].to_numpy(dtype="<u4"),
        "ev": g["event"].map(EVENT_CODE).to_numpy(dtype="u1"),
        "mi": g["_mi"].to_numpy(dtype="<u2"),
        "pi": g["_pi"].to_numpy(dtype="<u2"),
    }
    blob = b"".join(arrays[k].tobytes() for k in ("x", "y", "z", "t", "ev", "mi", "pi"))
    (out_dir / f"{map_id}.bin").write_bytes(blob)

    # Journey slices: rows are already grouped by (match, player).
    journeys = []
    offset = 0
    for (mi, pi), jg in g.groupby(["_mi", "_pi"], sort=True):
        length = len(jg)
        events = jg["event"]
        journeys.append({
            "m": int(mi),
            "p": int(pi),
            "o": offset,
            "n": length,
            "t0": int(jg["ts_unix"].iloc[0]),
            "t1": int(jg["ts_unix"].iloc[-1]),
            "loot": int((events == "Loot").sum()),
            "kills": int(events.isin(KILL_EVENTS).sum()),
            "died": int(events.isin(DEATH_EVENTS).any()),
            "storm": int((events == "KilledByStorm").sum() > 0),
        })
        offset += length
    assert offset == n, "journey offsets do not cover the buffer"

    # Match summaries.
    matches = []
    by_match: dict[int, list[dict]] = defaultdict(list)
    for j in journeys:
        by_match[j["m"]].append(j)

    for mi, mid in enumerate(match_ids):
        js = by_match[mi]
        mg = g[g["_mi"] == mi]
        humans = [j for j in js if not UUID_RE.match(player_ids[j["p"]]) is None]
        bots = [j for j in js if j not in humans]
        t0, t1 = int(mg["ts_unix"].min()), int(mg["ts_unix"].max())
        counts = mg["event"].value_counts()
        matches.append({
            "id": mid,
            "t0": t0,
            "t1": t1,
            "day": datetime.fromtimestamp(t0, timezone.utc).strftime("%Y-%m-%d"),
            "humans": len(humans),
            "bots": len(bots),
            "events": int(len(mg)),
            "kills": int(sum(counts.get(e, 0) for e in KILL_EVENTS)),
            "deaths": int(sum(counts.get(e, 0) for e in DEATH_EVENTS)),
            "loot": int(counts.get("Loot", 0)),
            "storm": int(counts.get("KilledByStorm", 0)),
        })

    print(f"  {map_id:<14} {n:>6,} events  {len(matches):>4} matches  "
          f"{len(player_ids):>3} players  {len(blob)/1e6:.2f} MB")

    return {
        "id": map_id,
        "label": MAP_CONFIG[map_id]["label"],
        "scale": MAP_CONFIG[map_id]["scale"],
        "originX": MAP_CONFIG[map_id]["originX"],
        "originZ": MAP_CONFIG[map_id]["originZ"],
        "image": f"maps/{map_id}.webp",
        "bin": f"data/{map_id}.bin",
        "count": n,
        "elevation": [float(g["y"].min()), float(g["y"].max())],
        "matches": matches,
        "players": [{"id": p, "bot": bool(not UUID_RE.match(p))} for p in player_ids],
        "journeys": journeys,
    }


def build_minimaps(src: Path, out_dir: Path) -> dict[str, list[int]]:
    """Downscale each minimap to a web-friendly webp. Returns source sizes."""
    sizes = {}
    for map_id, cfg in MAP_CONFIG.items():
        source = src / "minimaps" / cfg["source"]
        if not source.exists():
            print(f"  ! missing minimap {source}")
            continue
        img = Image.open(source).convert("RGB")
        sizes[map_id] = list(img.size)
        if max(img.size) > MINIMAP_MAX_PX:
            ratio = MINIMAP_MAX_PX / max(img.size)
            img = img.resize(
                (round(img.width * ratio), round(img.height * ratio)), Image.LANCZOS
            )
        dst = out_dir / f"{map_id}.webp"
        img.save(dst, "WEBP", quality=88, method=6)
        print(f"  {map_id:<14} {sizes[map_id][0]}x{sizes[map_id][1]} -> "
              f"{img.width}x{img.height}  {dst.stat().st_size/1e6:.2f} MB")
    return sizes


def build_aggregates(df: pd.DataFrame) -> dict:
    """Dataset-wide numbers shown on the overview panel."""
    humans = df[~df.is_bot]
    per_journey = df.groupby(["match_id", "user_id"]).agg(
        is_bot=("is_bot", "first"),
        dur=("ts_unix", lambda s: int(s.max() - s.min())),
    )
    human_journeys = per_journey[~per_journey.is_bot]
    return {
        "events": int(len(df)),
        "matches": int(df.match_id.nunique()),
        "players": int(humans.user_id.nunique()),
        "bots": int(df[df.is_bot].user_id.nunique()),
        "days": sorted(df["datetime"].dt.strftime("%Y-%m-%d").unique().tolist()),
        "eventCounts": {k: int(v) for k, v in df.event.value_counts().items()},
        "medianSessionSec": int(human_journeys.dur.median()),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(Path.home() / "Downloads" / "player_data"),
                    help="folder containing February_* and minimaps/")
    ap.add_argument("--out", default="public", help="output folder (served statically)")
    args = ap.parse_args()

    src = Path(args.src).expanduser()
    out = Path(args.out)
    data_dir, maps_dir = out / "data", out / "maps"
    data_dir.mkdir(parents=True, exist_ok=True)
    maps_dir.mkdir(parents=True, exist_ok=True)

    print("1/4  reading parquet …")
    df = load_raw(src)

    print("2/4  normalising …")
    df = normalise(df)

    print("3/4  minimaps …")
    source_sizes = build_minimaps(src, maps_dir)

    print("4/4  map bundles …")
    maps = []
    for map_id in MAP_CONFIG:
        g = df[df.map_id == map_id]
        if g.empty:
            continue
        entry = build_map_bundle(map_id, g, data_dir)
        entry["sourceImageSize"] = source_sizes.get(map_id, [1024, 1024])
        maps.append(entry)

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "eventTypes": EVENT_TYPES,
        "maps": maps,
        "totals": build_aggregates(df),
    }
    path = data_dir / "manifest.json"
    path.write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"\nwrote {path} ({path.stat().st_size/1e6:.2f} MB)")
    print(json.dumps(manifest["totals"], indent=2)[:600])


if __name__ == "__main__":
    main()
