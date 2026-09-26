"""Distance from each tract's population center to the ocean coastline (Natural Earth 10m,
public domain), capped at 200 km. Storm surge only reaches low, near-coast land, so this is the
surge model's exposure term. Writes data/out/coast.csv.
"""
import csv
import json
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COAST = ROOT / "raw" / "coast" / "ne_10m_coastline.geojson"
TRACTS = ROOT / "out" / "tracts.csv"
OUT = ROOT / "out" / "coast.csv"
CELL = 0.25  # degrees per index bucket
CAP_KM = 200.0
R_KM = 6371.0


def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 2 * R_KM * math.asin(min(1.0, math.sqrt(a)))


def coast_points():
    """Coastline vertices around the US, densified so no gap exceeds ~1 km."""
    data = json.loads(COAST.read_text())
    for f in data["features"]:
        g = f["geometry"]
        for line in g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]:
            if not any(-130 < x < -60 and 20 < y < 52 for x, y in line):
                continue
            for (x1, y1), (x2, y2) in zip(line, line[1:]):
                steps = max(1, int(km(y1, x1, y2, x2) / 1.0))
                for i in range(steps):
                    t = i / steps
                    yield y1 + (y2 - y1) * t, x1 + (x2 - x1) * t
            yield line[-1][1], line[-1][0]


class CoastIndex:
    """Nearest-coastline lookup on a 0.25 degree bucket grid."""

    def __init__(self):
        self.buckets = defaultdict(list)
        self.points = 0
        for lat, lon in coast_points():
            self.buckets[(int(math.floor(lat / CELL)), int(math.floor(lon / CELL)))].append((lat, lon))
            self.points += 1
        self.reach = int(math.ceil((CAP_KM / 111.0) / CELL)) + 1

    def distance_km(self, lat: float, lon: float) -> float:
        bi, bj = int(math.floor(lat / CELL)), int(math.floor(lon / CELL))
        best = CAP_KM
        for ring in range(self.reach + 1):
            # Stop once the nearest unexplored ring is farther than the best hit.
            if ring > 0 and (ring - 1) * CELL * 111.0 * math.cos(math.radians(lat)) > best:
                break
            for di in range(-ring, ring + 1):
                for dj in range(-ring, ring + 1):
                    if max(abs(di), abs(dj)) != ring:
                        continue
                    for plat, plon in self.buckets.get((bi + di, bj + dj), ()):
                        d = km(lat, lon, plat, plon)
                        if d < best:
                            best = d
        return best


def main():
    index = CoastIndex()
    with TRACTS.open(newline="") as f, OUT.open("w", newline="") as o:
        w = csv.writer(o)
        w.writerow(["geoid", "dist_coast_km"])
        coastal = 0
        for r in csv.DictReader(f):
            d = index.distance_km(float(r["lat"]), float(r["lon"]))
            coastal += d < 10
            w.writerow([r["geoid"], round(d, 2)])
    print(f"{index.points:,} coastline points; {coastal:,} tracts within 10 km of the coast; wrote {OUT.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
