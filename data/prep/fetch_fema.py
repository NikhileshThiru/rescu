"""Downloads FEMA's county designations for the demo storms from OpenFEMA (free, no key).

A county counts as "declared" when it got a major disaster declaration (DR) with Individual
Assistance, the program that pays households. Writes data/out/declared_counties.json.
"""
import json
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "out" / "declared_counties.json"
API = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries"

# storm id -> (name in the declaration title, declared on or after, declared before)
STORMS = {
    "AL092024": ("HELENE", "2024-09-01", "2025-06-01"),
    "AL092022": ("IAN", "2022-09-01", "2023-06-01"),
    "AL122005": ("KATRINA", "2005-08-01", "2006-06-01"),
}


def fetch(name: str, start: str, end: str) -> list[dict]:
    query = {
        "$filter": (
            f"contains(declarationTitle,'{name}') and declarationType eq 'DR' "
            f"and declarationDate ge '{start}T00:00:00.000Z' and declarationDate lt '{end}T00:00:00.000Z'"
        ),
        "$select": "disasterNumber,state,declarationTitle,declarationDate,fipsStateCode,fipsCountyCode,"
        "designatedArea,iaProgramDeclared,ihProgramDeclared",
        "$top": "1000",
    }
    url = f"{API}?{urllib.parse.urlencode(query, quote_via=urllib.parse.quote)}"
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)["DisasterDeclarationsSummaries"]


def main() -> None:
    out = {}
    for storm_id, (name, start, end) in STORMS.items():
        rows = fetch(name, start, end)
        counties = sorted({
            r["fipsStateCode"] + r["fipsCountyCode"]
            for r in rows
            if (r["iaProgramDeclared"] or r["ihProgramDeclared"]) and r["fipsCountyCode"] != "000"
        })
        disasters = sorted({f"DR-{r['disasterNumber']} {r['state']}" for r in rows})
        out[storm_id] = {"name": name.title(), "disasters": disasters, "counties": counties}
        by_state: dict[str, int] = {}
        for r in rows:
            if r["iaProgramDeclared"] or r["ihProgramDeclared"]:
                by_state[r["state"]] = by_state.get(r["state"], 0) + 1
        print(f"{name.title():8} {len(counties)} IA counties {dict(sorted(by_state.items()))}; {', '.join(disasters)}")
    OUT.write_text(json.dumps(out, indent=1))
    print(f"wrote {OUT.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
