"""Extracts the storms in data/config/storms.json from NOAA HURDAT2 into data/out/storms.json.

Radii are nautical miles per quadrant in NE, SE, SW, NW order; -999 (missing) becomes null.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "raw" / "hurdat2.txt"
OUT = ROOT / "out" / "storms.json"

CONFIG = json.loads((ROOT / "config" / "storms.json").read_text())["storms"]
STORMS = {s["id"]: s for s in CONFIG}


def num(field: str) -> int | None:
    v = int(field)
    return None if v == -999 else v


def coord(field: str) -> float:
    value, hemi = float(field[:-1]), field[-1]
    return -value if hemi in "SW" else value


def parse() -> list[dict]:
    storms: list[dict] = []
    current: dict | None = None
    remaining = 0
    for raw in RAW.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("<"):
            continue  # the NOAA download is wrapped in <html><pre>
        parts = [p.strip() for p in line.split(",")]
        if remaining == 0:
            storm_id, count = parts[0], int(parts[2])
            remaining = count
            current = None
            if storm_id in STORMS:
                c = STORMS[storm_id]
                current = {"id": storm_id, "slug": c["slug"], "name": c["name"], "year": c["year"], "demo": c["demo"], "points": []}
                storms.append(current)
            continue
        remaining -= 1
        if current is None:
            continue
        date, hhmm, record, status = parts[0], parts[1], parts[2], parts[3]
        t = datetime(int(date[:4]), int(date[4:6]), int(date[6:8]), int(hhmm[:2]), int(hhmm[2:]), tzinfo=timezone.utc)
        radii = [num(x) for x in parts[8:20]]
        current["points"].append({
            "t": int(t.timestamp()),
            "lat": coord(parts[4]),
            "lon": coord(parts[5]),
            "vmax": num(parts[6]),
            "pmin": num(parts[7]),
            "status": status,
            "record": record,
            "r34": radii[0:4],
            "r50": radii[4:8],
            "r64": radii[8:12],
            "rmw": num(parts[20]) if len(parts) > 20 and parts[20] else None,
        })
    for s in storms:
        s["landfalls"] = [
            {"t": p["t"], "lat": p["lat"], "lon": p["lon"], "vmax": p["vmax"]}
            for p in s["points"] if p["record"] == "L"
        ]
    return storms


if __name__ == "__main__":
    storms = parse()
    missing = set(STORMS) - {s["id"] for s in storms}
    if missing:
        raise SystemExit(f"storms not found in HURDAT2: {sorted(missing)}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(storms, indent=1))
    for s in storms:
        peak = max(p["vmax"] or 0 for p in s["points"])
        print(f"{s['name']:9}{s['year']} {len(s['points']):3} points, peak {peak:3} kt, {len(s['landfalls'])} landfalls{'  (demo)' if s['demo'] else ''}")
    print(f"wrote {OUT.relative_to(ROOT.parent)}")
