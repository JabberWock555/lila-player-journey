#!/usr/bin/env python3
"""
Map calibration helper
======================

Finding a new map's `scale` / `originX` / `originZ` is the fiddly part of
onboarding it, because nothing in the telemetry states them — you only know you
got them right when the paths land on the roads.

This script does three things:

  1. prints the raw world extents of every event on that map;
  2. proposes a square footprint that contains them, snapped to a round number;
  3. renders a contact sheet of that proposal and eight nearby variants over the
     candidate minimap, so the right one can be picked by eye.

Usage
-----
    # propose values for a new map and render the contact sheet
    python3 etl/calibrate_map.py --map NewMap --src ~/Downloads/player_data

    # self-test: does the proposal recover the three known maps?
    python3 etl/calibrate_map.py --verify-known --src ~/Downloads/player_data
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
from build_data import CONFIG_PATH, Config, parse_day_dir  # noqa: E402

Image.MAX_IMAGE_PIXELS = None

PREVIEW_PX = 512
# Fraction of the data span left as margin, since players rarely reach the very
# edge of a map. Tuned so the proposal recovers the three known maps closely.
PADDING = 0.09


def load_points(src: Path, map_id: str) -> pd.DataFrame:
    """Every (x, z) recorded on one map, read straight from the raw parquet."""
    rows = []
    for day_dir in sorted(p for p in src.iterdir() if p.is_dir() and parse_day_dir(p.name)):
        for path in sorted(day_dir.iterdir()):
            if path.name.startswith("."):
                continue
            try:
                t = pq.read_table(path, columns=["map_id", "x", "z"])
            except Exception:
                continue
            df = t.to_pandas()
            df = df[df.map_id == map_id]
            if len(df):
                rows.append(df)
    if not rows:
        sys.exit(f"No events found for map_id={map_id!r} under {src}")
    return pd.concat(rows, ignore_index=True)


def snap(value: float) -> int:
    """Round a scale to something a human would plausibly have typed."""
    for step in (1000, 500, 100, 50, 10):
        if value >= step * 2:
            return int(round(value / step) * step)
    return int(round(value))


def propose(df: pd.DataFrame) -> tuple[dict, dict | None]:
    """Propose a square world footprint for the minimap.

    Returns (primary, alternative). Neither can be exact: the telemetry only
    shows where players *went*, and every map has border nobody walks into, so
    a data-derived box is always a slight under-estimate. The contact sheet is
    what actually settles it — these two just bracket the search.

      primary     — box centred on the data, padded. Recovered AmbroseValley's
                    scale exactly (900) in the self-test.
      alternative — box centred on the world origin (origin = -scale/2). Two of
                    the three shipped maps follow that convention
                    (Lockdown -500/1000, Grand Rift -290/581), so it is worth
                    checking whenever it still contains every point.
    """
    x0, x1 = float(df.x.min()), float(df.x.max())
    z0, z1 = float(df.z.min()), float(df.z.max())

    span = max(x1 - x0, z1 - z0) * (1 + 2 * PADDING)
    scale = snap(span)
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    primary = {
        "scale": scale,
        "originX": int(round((cx - scale / 2) / 10) * 10),
        "originZ": int(round((cz - scale / 2) / 10) * 10),
        "basis": "centred on the data",
    }

    reach = max(abs(x0), abs(x1), abs(z0), abs(z1)) * (1 + PADDING)
    sym_scale = snap(reach * 2)
    alternative = None
    if all(abs(v) <= sym_scale / 2 for v in (x0, x1, z0, z1)):
        alternative = {
            "scale": sym_scale,
            "originX": -sym_scale // 2,
            "originZ": -sym_scale // 2,
            "basis": "centred on the world origin",
        }
    return primary, alternative


def render_sheet(df: pd.DataFrame, minimap: Path | None, guess: dict, out: Path) -> None:
    """3x3 contact sheet: the proposal in the centre, variants around it."""
    base = (
        Image.open(minimap).convert("RGB").resize((PREVIEW_PX, PREVIEW_PX))
        if minimap and minimap.exists()
        else Image.new("RGB", (PREVIEW_PX, PREVIEW_PX), (18, 20, 26))
    )

    # Vary scale and origin a little either way around the proposal.
    scales = [int(guess["scale"] * f) for f in (0.9, 1.0, 1.1)]
    shifts = [-0.10, 0.0, 0.10]

    sheet = Image.new("RGB", (PREVIEW_PX * 3 + 40, PREVIEW_PX * 3 + 40), (10, 11, 14))
    draw_sheet = ImageDraw.Draw(sheet)

    # Sample at most 40k points — enough to judge alignment, fast to draw.
    pts = df.sample(min(len(df), 40_000), random_state=0)

    for row, scale in enumerate(scales):
        for col, shift in enumerate(shifts):
            ox = guess["originX"] + shift * scale
            oz = guess["originZ"] + shift * scale
            tile = base.copy()
            d = ImageDraw.Draw(tile, "RGBA")
            u = (pts.x - ox) / scale
            v = (pts.z - oz) / scale
            px = u * PREVIEW_PX
            py = (1 - v) * PREVIEW_PX
            inside = 0
            for a, b in zip(px.values, py.values):
                if 0 <= a < PREVIEW_PX and 0 <= b < PREVIEW_PX:
                    inside += 1
                    # 2x2 rather than a single pixel: sparse maps are otherwise
                    # too faint to judge alignment by eye at tile size.
                    d.rectangle([a, b, a + 1, b + 1], fill=(255, 70, 70, 200))
            x0 = col * (PREVIEW_PX + 10) + 10
            y0 = row * (PREVIEW_PX + 10) + 10
            sheet.paste(tile, (x0, y0))
            label = f"scale={scale} origin=({ox:.0f},{oz:.0f}) in={inside / len(pts):.1%}"
            draw_sheet.rectangle([x0, y0, x0 + PREVIEW_PX, y0 + 14], fill=(0, 0, 0))
            draw_sheet.text((x0 + 4, y0 + 3), label, fill=(230, 230, 230))
            if row == 1 and col == 1:
                draw_sheet.rectangle(
                    [x0 - 2, y0 - 2, x0 + PREVIEW_PX + 2, y0 + PREVIEW_PX + 2],
                    outline=(80, 200, 255), width=2,
                )

    sheet.save(out)
    print(f"\nwrote {out}  (centre tile, cyan border, is the proposal)")


def describe(df: pd.DataFrame, guess: dict, tag: str) -> None:
    u = (df.x - guess["originX"]) / guess["scale"]
    v = (df.z - guess["originZ"]) / guess["scale"]
    inside = float(((u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)).mean())
    print(f"\n  {tag} — {guess['basis']}")
    print(f"    scale={guess['scale']}  originX={guess['originX']}  originZ={guess['originZ']}")
    print(f"    contains {inside:.2%} of events;  "
          f"u {u.min():.3f}-{u.max():.3f}   v {v.min():.3f}-{v.max():.3f}")


def report(df: pd.DataFrame, map_id: str, primary: dict, alt: dict | None) -> None:
    print(f"\n=== {map_id}: {len(df):,} events ===")
    for axis in ("x", "z"):
        s = df[axis]
        print(f"  {axis}: min {s.min():8.1f}  p1 {s.quantile(.01):8.1f}  "
              f"p99 {s.quantile(.99):8.1f}  max {s.max():8.1f}  span {s.max()-s.min():7.1f}")
    describe(df, primary, "candidate A")
    if alt:
        describe(df, alt, "candidate B")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default=str(Path.home() / "Downloads" / "player_data"))
    ap.add_argument("--map", help="map_id to calibrate")
    ap.add_argument("--minimap", help="path to the candidate minimap image")
    ap.add_argument("--config", default=str(CONFIG_PATH))
    ap.add_argument("--verify-known", action="store_true",
                    help="check the proposal against the maps already in the config")
    ap.add_argument("--out", default=".", help="where to write the contact sheet")
    args = ap.parse_args()

    src = Path(args.src).expanduser()
    cfg = Config(Path(args.config).expanduser())

    if args.verify_known:
        print("Self-test: proposing values for maps whose real config is known.\n")
        print(f"{'map':<15}{'candidate A':>22}{'candidate B':>22}{'configured':>22}{'best err':>10}")
        worst = 0.0
        for map_id, known in cfg.maps.items():
            df = load_points(src, map_id)
            primary, alt = propose(df)
            errs = [abs(primary["scale"] - known["scale"]) / known["scale"]]
            if alt:
                errs.append(abs(alt["scale"] - known["scale"]) / known["scale"])
            worst = max(worst, min(errs))
            fmt = lambda g: f"{g['scale']} ({g['originX']},{g['originZ']})" if g else "-"
            print(f"{map_id:<15}{fmt(primary):>22}{fmt(alt):>22}"
                  f"{fmt(known):>22}{min(errs):>9.1%}")
        print(f"\nworst scale error across both candidates: {worst:.1%}")
        print("The proposal is a starting point, not an answer — always confirm with\n"
              "the contact sheet that paths follow roads and buildings.")
        return

    if not args.map:
        sys.exit("--map is required (or use --verify-known)")

    df = load_points(src, args.map)
    primary, alt = propose(df)
    report(df, args.map, primary, alt)
    guess = primary

    minimap = Path(args.minimap).expanduser() if args.minimap else None
    if minimap is None:
        entry = cfg.maps.get(args.map)
        if entry:
            minimap = src / "minimaps" / entry["source"]
        else:
            # Guess the conventional filename before giving up.
            for ext in ("png", "jpg", "jpeg", "webp"):
                candidate = src / "minimaps" / f"{args.map}_Minimap.{ext}"
                if candidate.exists():
                    minimap = candidate
                    break
    if minimap is None or not minimap.exists():
        print(f"\n  ! no minimap found for {args.map}; the sheet will show points only.")
        print("    pass --minimap <path> to overlay the real image.")
        minimap = None

    render_sheet(df, minimap, guess, Path(args.out).expanduser() / f"calibration_{args.map}.png")

    block = {
        "label": args.map,
        "scale": guess["scale"],
        "originX": guess["originX"],
        "originZ": guess["originZ"],
        "source": minimap.name if minimap else f"{args.map}_Minimap.png",
    }
    block.pop("basis", None)
    print("\nPaste into `maps` in etl/config/dataset.json, adjusting to whichever\n"
          "tile in the sheet lines up best (candidate B may fit better — check both):\n")
    rendered = json.dumps({args.map: block}, indent=2)
    # strip the outer braces so it drops straight into the existing `maps` object
    print("\n".join("  " + line for line in rendered.splitlines()[1:-1]))
    print("\nThen: python3 etl/build_data.py --src <src> --strict")


if __name__ == "__main__":
    main()
