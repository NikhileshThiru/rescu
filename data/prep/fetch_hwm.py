"""USGS high-water marks (STN, free) for every storm that has them: the flood heights crews
measured after the water went down. Coastal marks are the ground truth for the surge model.
Raw responses are cached in data/raw/usgs/. Writes data/out/hwm/<slug>.csv.
"""
import csv
import json
import re
import time
import urllib.request
from pathlib import Path

from coast_distance import CoastIndex

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "raw" / "usgs"
OUT = ROOT / "out" / "hwm"
STN = "https://stn.wim.usgs.gov/STNServices"
CONFIG = json.loads((ROOT / "config" / "storms.json").read_text())["storms"]


def cached(name: str, url: str):
    path = CACHE / name
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=180) as r:
            path.write_bytes(r.read())
        time.sleep(0.5)
    return json.loads(path.read_text())


def main():
    events = cached("events.json", f"{STN}/Events.json")
    coast = CoastIndex()
    OUT.mkdir(parents=True, exist_ok=True)
    for c in CONFIG:
        match = [e for e in events if re.fullmatch(rf"{c['year']} {c['name']}", (e.get("event_name") or "").strip(), re.I)]
        if not match:
            print(f"{c['name']:9}{c['year']}: no USGS event")
            continue
        eid = match[0]["event_id"]
        marks = cached(f"hwm_{eid}.json", f"{STN}/HWMs/FilteredHWMs.json?Event={eid}")
        rows = []
        for m in marks:
            if (m.get("hwm_environment") or "") != "Coastal" or m.get("latitude") is None:
                continue
            lat, lon = float(m["latitude"]), float(m["longitude"])
            rows.append({
                "lat": lat,
                "lon": lon,
                "dist_coast_km": round(coast.distance_km(lat, lon), 2),
                "height_above_ground_ft": m.get("height_above_gnd"),
                "elev_ft": m.get("elev_ft"),
                "quality": m.get("hwm_quality_id"),
            })
        with (OUT / f"{c['slug']}.csv").open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["lat", "lon", "dist_coast_km", "height_above_ground_ft", "elev_ft", "quality"])
            w.writeheader()
            for r in rows:
                w.writerow({k: "" if v is None else v for k, v in r.items()})
        with_height = sum(1 for r in rows if r["height_above_ground_ft"] is not None)
        print(f"{c['name']:9}{c['year']}: {len(rows):4} coastal marks ({with_height} with height above ground)")


if __name__ == "__main__":
    main()
