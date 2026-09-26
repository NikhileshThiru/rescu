"""Downloads FEMA's record for every storm in data/config/storms.json from OpenFEMA (free, no key).

For each storm:
- the counties designated for Individual Assistance (the program that pays households),
- what FEMA actually approved for households there (owners + renters): registrations, approved
  households and dollars per county. This is the ground truth the need model is tuned and
  scored against.

Raw responses are cached in data/raw/fema/ so reruns never hit the API again.
Writes data/out/fema.json.
"""
import csv
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "raw" / "fema"
OUT = ROOT / "out" / "fema.json"
API = "https://www.fema.gov/api/open/v2"
CONFIG = json.loads((ROOT / "config" / "storms.json").read_text())["storms"]
STORMS = json.loads((ROOT / "out" / "storms.json").read_text())


def get(dataset: str, filt: str, select: str, cache_key: str) -> list[dict]:
    path = CACHE / f"{cache_key}.json"
    if path.exists():
        return json.loads(path.read_text())
    rows: list[dict] = []
    skip = 0
    while True:
        query = {"$filter": filt, "$select": select, "$top": "10000", "$skip": str(skip)}
        url = f"{API}/{dataset}?{urllib.parse.urlencode(query, quote_via=urllib.parse.quote)}"
        with urllib.request.urlopen(url, timeout=120) as r:
            page = json.load(r)[dataset]
        rows += page
        if len(page) < 10000:
            break
        skip += 10000
        time.sleep(0.5)
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows))
    time.sleep(0.3)
    return rows


def norm(name: str) -> str:
    """'St. Tammany (Parish)' and 'St. Tammany Parish' both become 'sttammanyparish'."""
    return re.sub(r"[^a-z]", "", name.lower())


def county_index() -> dict[tuple[str, str], str]:
    index = {}
    with (ROOT / "out" / "tracts.csv").open(newline="") as f:
        for r in csv.DictReader(f):
            index[(r["state_abbr"], norm(r["county_name"]))] = r["county_fips"]
    return index


def main() -> None:
    counties = county_index()
    tracks = {s["id"]: s for s in STORMS}
    out = {}
    for c in CONFIG:
        track = tracks[c["id"]]
        first = datetime.fromtimestamp(track["points"][0]["t"], tz=timezone.utc) - timedelta(days=3)
        until = first + timedelta(days=300)
        name = c["name"].upper()
        decl = get(
            "DisasterDeclarationsSummaries",
            f"contains(declarationTitle,'{name}') and declarationType eq 'DR' "
            f"and declarationDate ge '{first:%Y-%m-%d}T00:00:00.000Z' and declarationDate lt '{until:%Y-%m-%d}T00:00:00.000Z'",
            "disasterNumber,state,declarationTitle,declarationDate,fipsStateCode,fipsCountyCode,iaProgramDeclared,ihProgramDeclared",
            f"decl_{c['slug']}",
        )
        # Whole-word match: 'IDA' must not match 'FLORIDA'.
        decl = [r for r in decl if re.search(rf"\b{name}\b", r["declarationTitle"])]
        ia = [r for r in decl if (r["iaProgramDeclared"] or r["ihProgramDeclared"]) and r["fipsCountyCode"] != "000"]
        ia_counties = sorted({r["fipsStateCode"] + r["fipsCountyCode"] for r in ia})
        disasters = sorted({r["disasterNumber"] for r in ia})

        ihp: dict[str, dict] = {}
        unmatched = 0
        for dn in disasters:
            for dataset in ("HousingAssistanceOwners", "HousingAssistanceRenters"):
                rows = get(
                    dataset,
                    f"disasterNumber eq {dn}",
                    "state,county,validRegistrations,approvedForFemaAssistance,totalApprovedIhpAmount",
                    f"{dataset}_{dn}",
                )
                for r in rows:
                    fips = counties.get((r["state"], norm(r["county"] or "")))
                    if not fips:
                        unmatched += r["approvedForFemaAssistance"] or 0
                        continue
                    agg = ihp.setdefault(fips, {"registrations": 0, "approved": 0, "amount": 0.0})
                    agg["registrations"] += r["validRegistrations"] or 0
                    agg["approved"] += r["approvedForFemaAssistance"] or 0
                    agg["amount"] += r["totalApprovedIhpAmount"] or 0.0
        for agg in ihp.values():
            agg["amount"] = round(agg["amount"], 2)

        approved = sum(a["approved"] for a in ihp.values())
        out[c["id"]] = {
            "name": c["name"],
            "disasters": [f"DR-{d}" for d in disasters],
            "iaCounties": ia_counties,
            "ihp": ihp,
            "unmatchedApproved": unmatched,
        }
        share = 100 * unmatched / max(1, approved + unmatched)
        print(
            f"{c['name']:9}{c['year']} {len(disasters)} disasters, {len(ia_counties):3} IA counties, "
            f"{approved:>8,} approved households, ${sum(a['amount'] for a in ihp.values()) / 1e6:>7,.0f}M "
            f"({share:.1f}% unmatched)"
        )
    OUT.write_text(json.dumps(out, indent=1))
    print(f"wrote {OUT.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
