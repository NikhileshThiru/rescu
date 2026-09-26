"""Joins Census 2020 tract population centers with CDC/ATSDR SVI 2022 into data/out/tracts.csv.

National on purpose: storms (including custom ones) choose their tracts by wind swath, not by
a hardcoded state list. Missing SVI (-999) is imputed from the county, then the state median.
"""
import csv
import statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CENPOP = ROOT / "raw" / "CenPop2020_Mean_TR.txt"
SVI = ROOT / "raw" / "SVI_2022_US.csv"
OUT = ROOT / "out" / "tracts.csv"

PCT_FIELDS = {
    "pct_poverty": "EP_POV150",
    "pct_no_vehicle": "EP_NOVEH",
    "pct_age65": "EP_AGE65",
    "pct_disability": "EP_DISABL",
    "pct_limited_english": "EP_LIMENG",
    "pct_mobile_home": "EP_MOBILE",
}
THEME_FIELDS = {
    "svi_socioeconomic": "RPL_THEME1",
    "svi_household": "RPL_THEME2",
    "svi_minority": "RPL_THEME3",
    "svi_housing": "RPL_THEME4",
}
COLUMNS = [
    "geoid", "state_abbr", "state_name", "county_fips", "county_name", "lat", "lon",
    "population", "households", "svi", "svi_imputed", *THEME_FIELDS, *PCT_FIELDS,
]


def value(v: str) -> float | None:
    try:
        x = float(v)
    except ValueError:
        return None
    return None if x == -999 else x


def main() -> None:
    centers = {}
    with CENPOP.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            geoid = row["STATEFP"] + row["COUNTYFP"] + row["TRACTCE"]
            centers[geoid] = (int(row["POPULATION"]), float(row["LATITUDE"]), float(row["LONGITUDE"]))

    rows = []
    with SVI.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            geoid = r["FIPS"].zfill(11)
            if geoid not in centers:
                continue
            pop, lat, lon = centers[geoid]
            hh = value(r["E_HH"]) or 0
            if hh <= 0 and pop > 0:
                hh = round(pop / 2.5)
            rows.append({
                "geoid": geoid,
                "state_abbr": r["ST_ABBR"],
                "state_name": r["STATE"],
                "county_fips": r["STCNTY"].zfill(5),
                "county_name": r["COUNTY"],
                "lat": lat,
                "lon": lon,
                "population": pop,
                "households": int(hh),
                "svi": value(r["RPL_THEMES"]),
                **{k: value(r[v]) for k, v in THEME_FIELDS.items()},
                **{k: value(r[v]) for k, v in PCT_FIELDS.items()},
            })

    by_county, by_state = defaultdict(list), defaultdict(list)
    for r in rows:
        if r["svi"] is not None:
            by_county[r["county_fips"]].append(r["svi"])
            by_state[r["state_abbr"]].append(r["svi"])
    imputed = 0
    for r in rows:
        r["svi_imputed"] = r["svi"] is None
        if r["svi"] is None:
            imputed += 1
            pool = by_county.get(r["county_fips"]) or by_state.get(r["state_abbr"]) or [0.5]
            r["svi"] = round(statistics.median(pool), 4)

    rows.sort(key=lambda r: r["geoid"])
    with OUT.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if r[k] is None else r[k]) for k in COLUMNS})

    unmatched = len(centers) - len(rows)
    print(f"{len(rows)} tracts ({unmatched} census tracts without SVI, mostly Puerto Rico and Connecticut's new regions)")
    print(f"{imputed} tracts with imputed SVI; {sum(r['households'] for r in rows):,} households, {sum(r['population'] for r in rows):,} people")
    print(f"wrote {OUT.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
