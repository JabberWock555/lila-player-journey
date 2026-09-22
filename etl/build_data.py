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
import calendar
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

CONFIG_PATH = Path(__file__).parent / "config" / "dataset.json"

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)

# `<MonthName>_<DD>` — the shape of the day folders in the raw drop.
DAY_DIR_RE = re.compile(r"^([A-Za-z]+)_(\d{1,2})$")

MONTHS = {name.lower(): i for i, name in enumerate(calendar.month_name) if name}


class Config:
    """Everything that used to be a hardcoded constant, loaded from dataset.json.

    `scale` is the world-units width of the square the minimap covers, and
    (originX, originZ) is its bottom-left corner in world space.
    """

    def __init__(self, path: Path):
        raw = json.loads(path.read_text())
        self.maps: dict[str, dict] = raw["maps"]
        self.layers: dict[str, dict] = raw["layers"]
        self.events: list[dict] = raw["events"]
        self.traffic_ramp: list[str] = raw.get("trafficRamp", [])
        self.minimap_max_px: int = raw.get("minimapMaxPx", 2048)

        # Ordering is the wire format: the .bin `ev` column stores these indices.
        self.event_types: list[str] = [e["name"] for e in self.events]
        self.event_code = {name: i for i, name in enumerate(self.event_types)}
        self.layer_of = {e["name"]: e.get("layer") for e in self.events}

        self._validate()

        # Semantic groupings derived from the layer each event belongs to, so a
        # new event type joins the right bucket by config alone.
        self.position_events = {n for n, l in self.layer_of.items() if l is None}
        self.kill_events = {n for n, l in self.layer_of.items() if l == "kill"}
        self.death_events = {n for n, l in self.layer_of.items() if l in ("death", "storm")}

    def _validate(self) -> None:
        if len(set(self.event_types)) != len(self.event_types):
            sys.exit("dataset.json: duplicate event names")
        for name, layer in self.layer_of.items():
            if layer is not None and layer not in self.layers:
                sys.exit(f"dataset.json: event {name!r} references unknown layer {layer!r}")
        for map_id, cfg in self.maps.items():
            missing = {"label", "scale", "originX", "originZ", "source"} - cfg.keys()
            if missing:
                sys.exit(f"dataset.json: map {map_id!r} missing {sorted(missing)}")
            if cfg["scale"] <= 0:
                sys.exit(f"dataset.json: map {map_id!r} has non-positive scale")

    def assert_event_codes_stable(self, manifest_path: Path) -> None:
        """Event codes are positional, so the list may only ever grow.

        Reordering or removing an entry would silently reinterpret every `.bin`
        ever written, including archived ones, so refuse to build instead.
        """
        if not manifest_path.exists():
            return
        try:
            previous = json.loads(manifest_path.read_text()).get("eventTypes", [])
        except (json.JSONDecodeError, OSError):
            return
        if self.event_types[:len(previous)] != previous:
            sys.exit(
                "dataset.json: `events` is no longer a superset of the previously built\n"
                f"  manifest, whose order was: {previous}\n"
                f"  and is now:                {self.event_types[:len(previous)]}\n"
                "  Event codes are stored positionally in the .bin files — append new\n"
                "  event types, never reorder or remove them."
            )


# --------------------------------------------------------------------------
# Load
# --------------------------------------------------------------------------

def parse_day_dir(name: str) -> tuple[int, int] | None:
    """`February_10` -> (2, 10). Returns None for anything that isn't a day folder."""
    m = DAY_DIR_RE.match(name)
    if not m:
        return None
    month = MONTHS.get(m.group(1).lower())
    if month is None:
        return None
    day = int(m.group(2))
    return (month, day) if 1 <= day <= 31 else None


def load_raw(src: Path, report: dict) -> pd.DataFrame:
    """Read every parquet file under the day folders into one DataFrame.

    Any `<MonthName>_<DD>` folder is accepted, so a later month drops in without
    a code change. Directories that don't match are reported rather than
    silently skipped.
    """
    day_dirs, ignored = [], []
    for p in sorted(src.iterdir()):
        if not p.is_dir() or p.name.startswith("."):
            continue
        if p.name == "minimaps":
            continue
        (day_dirs if parse_day_dir(p.name) else ignored).append(p)

    if ignored:
        print(f"  ! ignored non-day folders: {[p.name for p in ignored]}")
        report["ignoredFolders"] = [p.name for p in ignored]
    if not day_dirs:
        sys.exit(f"No <Month>_<DD> folders found under {src}")

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

    report["dayFolders"] = [p.name for p in day_dirs]
    report["filesRead"] = len(frames)
    report["filesSkipped"] = len(skipped)

    df = pd.concat(frames, ignore_index=True)
    print(f"  read {len(frames)} files from {len(day_dirs)} day folder(s) -> {len(df):,} rows")
    return df


def normalise(df: pd.DataFrame, cfg: Config, report: dict) -> pd.DataFrame:
    """Decode, de-duplicate and derive the columns the frontend needs."""

    # `event` is stored as parquet binary; decode to str.
    df["event"] = df["event"].apply(
        lambda v: v.decode("utf-8") if isinstance(v, (bytes, bytearray)) else str(v)
    )

    unknown = sorted(set(df["event"].unique()) - set(cfg.event_types))
    if unknown:
        print(f"  ! unknown event types ignored: {unknown}")
        print("    (add them to the end of `events` in dataset.json to keep them)")
        df = df[~df["event"].isin(unknown)]
    report["unknownEventTypes"] = unknown

    # ---- Timestamps -------------------------------------------------------
    # The column is typed timestamp[ms], but the underlying integers are Unix
    # *seconds* (e.g. 1_770_754_537). Read as ms they land in Jan 1970; read as
    # seconds they land in Feb 2026 and match the day folder they came from.
    # So: take the raw integer and treat it as seconds.
    df["ts_unix"] = df["ts"].astype("int64")
    df["datetime"] = pd.to_datetime(df["ts_unix"], unit="s", utc=True)

    # Cross-check the decoded timestamps against the folder they came from. The
    # folder name carries only month and day, so the year is taken from the data
    # itself (the modal decoded year within that folder) rather than a literal —
    # that keeps this check working for any month or year of future drops.
    folder_year = (
        df.groupby("source_day")["datetime"].agg(lambda s: s.dt.year.mode().iat[0])
    )
    parts = {name: parse_day_dir(name) for name in folder_year.index}
    folder_dates = {
        name: pd.Timestamp(year=int(folder_year[name]), month=parts[name][0],
                           day=parts[name][1], tz="UTC")
        for name in folder_year.index
    }
    folder_date = df["source_day"].map(folder_dates)
    drift = (df["datetime"].dt.normalize() - folder_date).abs().dt.total_seconds()
    mismatch = float((drift > 86400).mean())
    print(f"  timestamp<->folder mismatch rate: {mismatch:.3%}")
    report["timestampFolderMismatch"] = mismatch
    report["years"] = sorted({int(y) for y in folder_year})

    # ---- Identity ---------------------------------------------------------
    # Bot detection is by user_id shape, NOT by event name: the data contains
    # bots emitting plain `Position`/`Loot` and humans emitting `BotKilled`,
    # so the event name alone would misclassify ~750 rows.
    df["is_bot"] = ~df["user_id"].str.match(UUID_RE).fillna(False)

    # match_id carries the `.nakama-N` server-instance suffix; strip it so the
    # id matches the one in the filename and groups cleanly.
    df["match_id"] = df["match_id"].str.replace(r"\.nakama-\d+$", "", regex=True)

    unmapped = sorted(set(df["map_id"].unique()) - set(cfg.maps))
    if unmapped:
        print(f"  ! map_ids with no dataset.json entry, dropped: {unmapped}")
        print("    (run `python3 etl/calibrate_map.py --map <Name>` to add one)")
    report["unmappedMapIds"] = unmapped
    df = df[df["map_id"].isin(cfg.maps)].copy()

    # ---- Geometry ---------------------------------------------------------
    scale = df["map_id"].map(lambda m: cfg.maps[m]["scale"]).astype("float64")
    ox = df["map_id"].map(lambda m: cfg.maps[m]["originX"]).astype("float64")
    oz = df["map_id"].map(lambda m: cfg.maps[m]["originZ"]).astype("float64")
    df["u"] = (df["x"] - ox) / scale
    df["v"] = (df["z"] - oz) / scale

    oob_mask = (df.u < 0) | (df.u > 1) | (df.v < 0) | (df.v > 1)
    out_of_bounds = float(oob_mask.mean())
    print(f"  events outside minimap UV bounds: {out_of_bounds:.3%}")
    report["outOfBounds"] = out_of_bounds
    # Per-map, so one badly calibrated new map is obvious rather than averaged away.
    report["outOfBoundsByMap"] = {
        str(m): float(g.mean()) for m, g in oob_mask.groupby(df["map_id"])
    }

    # Identical rows occur, but they are only *redundant* for position samples
    # (a stationary player sampled twice inside the same one-second tick).
    # Repeated discrete events are real: 2.4k `Loot` rows duplicate in groups of
    # 2-7 at one tick and one spot, which is a container yielding several items.
    # Collapsing those would understate loot density, so only positions are
    # de-duplicated here.
    key = ["user_id", "match_id", "ts_unix", "event", "x", "y", "z"]
    is_pos = df["event"].isin(cfg.position_events)
    redundant = is_pos & df.duplicated(subset=key, keep="first")
    if redundant.any():
        print(f"  dropped {int(redundant.sum()):,} redundant duplicate position samples")
    report["droppedDuplicatePositions"] = int(redundant.sum())
    df = df[~redundant]

    df = df.sort_values(["map_id", "match_id", "user_id", "ts_unix"], kind="stable")
    return df.reset_index(drop=True)


# --------------------------------------------------------------------------
# Emit
# --------------------------------------------------------------------------

def build_map_bundle(map_id: str, g: pd.DataFrame, out_dir: Path, cfg: Config) -> dict:
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
        "ev": g["event"].map(cfg.event_code).to_numpy(dtype="u1"),
        "mi": g["_mi"].to_numpy(dtype="<u2"),
        "pi": g["_pi"].to_numpy(dtype="<u2"),
    }
    blob = b"".join(arrays[k].tobytes() for k in ("x", "y", "z", "t", "ev", "mi", "pi"))
    (out_dir / f"{map_id}.bin").write_bytes(blob)

    # Journey slices: rows are already grouped by (match, player).
    # Only `died` is precomputed — every other per-journey number the UI shows is
    # derived at runtime from the events actually passing the filters, so baking
    # more in here would just be manifest weight that can fall out of sync.
    journeys = []
    offset = 0
    for (mi, pi), jg in g.groupby(["_mi", "_pi"], sort=True):
        length = len(jg)
        journeys.append({
            "m": int(mi),
            "p": int(pi),
            "o": offset,
            "n": length,
            "t0": int(jg["ts_unix"].iloc[0]),
            "t1": int(jg["ts_unix"].iloc[-1]),
            "died": int(jg["event"].isin(cfg.death_events).any()),
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
        # Per-layer totals rather than named fields, so a layer added to
        # dataset.json shows up in the match list with no code change.
        layer_counts: dict[str, int] = {}
        for event_name, count in counts.items():
            layer = cfg.layer_of.get(event_name)
            if layer:
                layer_counts[layer] = layer_counts.get(layer, 0) + int(count)
        matches.append({
            "id": mid,
            "t0": t0,
            "t1": t1,
            "day": datetime.fromtimestamp(t0, timezone.utc).strftime("%Y-%m-%d"),
            "humans": len(humans),
            "bots": len(bots),
            "events": int(len(mg)),
            "layers": {k: layer_counts[k] for k in cfg.layers if k in layer_counts},
        })

    print(f"  {map_id:<14} {n:>6,} events  {len(matches):>4} matches  "
          f"{len(player_ids):>3} players  {len(blob)/1e6:.2f} MB")

    return {
        "id": map_id,
        "label": cfg.maps[map_id]["label"],
        "scale": cfg.maps[map_id]["scale"],
        "originX": cfg.maps[map_id]["originX"],
        "originZ": cfg.maps[map_id]["originZ"],
        "image": f"maps/{map_id}.webp",
        "bin": f"data/{map_id}.bin",
        "count": n,
        "elevation": [float(g["y"].min()), float(g["y"].max())],
        "matches": matches,
        "players": [{"id": p, "bot": bool(not UUID_RE.match(p))} for p in player_ids],
        "journeys": journeys,
    }


def build_minimaps(src: Path, out_dir: Path, cfg: Config, report: dict) -> dict[str, list[int]]:
    """Downscale each minimap to a web-friendly webp. Returns source sizes."""
    sizes: dict[str, list[int]] = {}
    missing: list[str] = []
    for map_id, map_cfg in cfg.maps.items():
        source = src / "minimaps" / map_cfg["source"]
        if not source.exists():
            print(f"  ! missing minimap {source}")
            missing.append(map_cfg["source"])
            continue
        img = Image.open(source).convert("RGB")
        sizes[map_id] = list(img.size)
        if max(img.size) > cfg.minimap_max_px:
            ratio = cfg.minimap_max_px / max(img.size)
            img = img.resize(
                (round(img.width * ratio), round(img.height * ratio)), Image.LANCZOS
            )
        dst = out_dir / f"{map_id}.webp"
        img.save(dst, "WEBP", quality=88, method=6)
        print(f"  {map_id:<14} {sizes[map_id][0]}x{sizes[map_id][1]} -> "
              f"{img.width}x{img.height}  {dst.stat().st_size/1e6:.2f} MB")
    report["missingMinimaps"] = missing
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


OOB_FAIL_THRESHOLD = 0.005    # 0.5% of a map's events outside the minimap
DRIFT_FAIL_THRESHOLD = 0.05   # 5% of rows whose timestamp disagrees with its folder


def check_strict(report: dict, cfg: Config) -> list[str]:
    """Conditions that should fail a build rather than ship a broken map."""
    problems = []
    for map_id, rate in report.get("outOfBoundsByMap", {}).items():
        if rate > OOB_FAIL_THRESHOLD:
            problems.append(
                f"{map_id}: {rate:.2%} of events fall outside the minimap "
                f"(>{OOB_FAIL_THRESHOLD:.1%}) — check scale/originX/originZ"
            )
    for map_id in cfg.maps:
        if map_id not in report.get("eventsByMap", {}):
            problems.append(f"{map_id}: configured in dataset.json but no events found")
    if report.get("missingMinimaps"):
        problems.append(f"missing minimap images: {report['missingMinimaps']}")
    if report.get("unknownEventTypes"):
        problems.append(f"unknown event types dropped: {report['unknownEventTypes']}")
    if report.get("unmappedMapIds"):
        problems.append(f"map_ids with no config entry: {report['unmappedMapIds']}")
    drift = report.get("timestampFolderMismatch", 0.0)
    if drift > DRIFT_FAIL_THRESHOLD:
        problems.append(
            f"{drift:.1%} of rows have a timestamp that disagrees with their day "
            f"folder (>{DRIFT_FAIL_THRESHOLD:.0%}) — folders may be mislabelled, or "
            "the `ts` column may no longer be Unix seconds"
        )
    return problems


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Build the static telemetry bundle the web app loads.")
    ap.add_argument("--src", default=str(Path.home() / "Downloads" / "player_data"),
                    help="folder containing <Month>_<DD> day folders and minimaps/")
    ap.add_argument("--out", default="public", help="output folder (served statically)")
    ap.add_argument("--config", default=str(CONFIG_PATH),
                    help="dataset config (maps, events, layers)")
    ap.add_argument("--strict", action="store_true",
                    help="exit non-zero on calibration/config problems")
    args = ap.parse_args()

    src = Path(args.src).expanduser()
    out = Path(args.out)
    data_dir, maps_dir = out / "data", out / "maps"
    data_dir.mkdir(parents=True, exist_ok=True)
    maps_dir.mkdir(parents=True, exist_ok=True)

    cfg = Config(Path(args.config).expanduser())
    cfg.assert_event_codes_stable(data_dir / "manifest.json")
    report: dict = {"generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    print(f"0/4  config: {len(cfg.maps)} maps, {len(cfg.event_types)} event types, "
          f"{len(cfg.layers)} layers")

    print("1/4  reading parquet …")
    df = load_raw(src, report)

    print("2/4  normalising …")
    df = normalise(df, cfg, report)

    print("3/4  minimaps …")
    source_sizes = build_minimaps(src, maps_dir, cfg, report)

    print("4/4  map bundles …")
    maps = []
    report["eventsByMap"] = {}
    for map_id in cfg.maps:
        g = df[df.map_id == map_id]
        if g.empty:
            print(f"  ! {map_id}: no events in this dataset, skipped")
            continue
        entry = build_map_bundle(map_id, g, data_dir, cfg)
        entry["sourceImageSize"] = source_sizes.get(map_id, [1024, 1024])
        maps.append(entry)
        report["eventsByMap"][map_id] = int(len(g))

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        # The frontend derives its event codes, layer buckets, colours and marker
        # shapes from these two blocks, so config is defined in exactly one place.
        "eventTypes": cfg.event_types,
        "events": cfg.events,
        "layers": cfg.layers,
        "trafficRamp": cfg.traffic_ramp,
        "maps": maps,
        "totals": build_aggregates(df),
    }
    path = data_dir / "manifest.json"
    path.write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"\nwrote {path} ({path.stat().st_size/1e6:.2f} MB)")

    report["totals"] = manifest["totals"]
    report_path = data_dir / "build-report.json"
    report_path.write_text(json.dumps(report, indent=2))
    print(f"wrote {report_path}")

    problems = check_strict(report, cfg)
    if problems:
        print("\nvalidation problems:")
        for p in problems:
            print(f"  ! {p}")
        if args.strict:
            sys.exit(f"\n--strict: {len(problems)} problem(s), build rejected")
    else:
        print("\nvalidation: clean")

    print(json.dumps(manifest["totals"], indent=2)[:600])


if __name__ == "__main__":
    main()
