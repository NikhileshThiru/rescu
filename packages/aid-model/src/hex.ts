import { cellToLatLng, latLngToCell, polygonToCells } from "h3-js";
import { type Allocation, tractTotalCents } from "./allocate";
import { type Band, bandOf, type Impact, type StormState } from "./types";
import { impactsAt, MIN_TRACKED_KT, reachNm } from "./wind";

export interface TractPoint {
  lat: number;
  lon: number;
  households: number;
  svi: number;
}

export interface HexAid {
  h3: string;
  households: number;
  eligibleHouseholds: number;
  aidCents: number;
  /** Mean aid per eligible household, cents. */
  aidPerHouseholdCents: number;
  /** Household-weighted SVI. */
  svi: number;
  /** Strongest band any tract in the hex saw. */
  band: Band;
  maxKt: number;
}

/**
 * Rolls tract results up to H3 cells. Aid is decided per tract, so totals are identical at
 * every resolution; the hex size is purely a display choice.
 */
export function aggregateHexes(tracts: TractPoint[], impacts: Impact[], allocation: Allocation, res: number): HexAid[] {
  const cells = new Map<string, HexAid & { sviWeight: number }>();
  tracts.forEach((t, i) => {
    const imp = impacts[i]!;
    if (imp.maxKt <= 0 && allocation.score[i]! <= 0) return;
    const h3 = latLngToCell(t.lat, t.lon, res);
    let c = cells.get(h3);
    if (!c) {
      c = { h3, households: 0, eligibleHouseholds: 0, aidCents: 0, aidPerHouseholdCents: 0, svi: 0, band: 0, maxKt: 0, sviWeight: 0 };
      cells.set(h3, c);
    }
    c.households += t.households;
    c.svi += t.svi * t.households;
    c.sviWeight += t.households;
    c.maxKt = Math.max(c.maxKt, imp.maxKt);
    if (allocation.score[i]! > 0) {
      c.eligibleHouseholds += t.households;
      c.aidCents += tractTotalCents(allocation, i, t.households);
    }
  });
  return [...cells.values()].map(({ sviWeight, ...c }) => ({
    ...c,
    svi: sviWeight ? c.svi / sviWeight : 0,
    band: bandOf(c.maxKt),
    aidPerHouseholdCents: c.eligibleHouseholds ? Math.round(c.aidCents / c.eligibleHouseholds) : 0,
  }));
}

export interface HexWind extends Impact {
  h3: string;
}

/**
 * The storm's wind field on an H3 grid (including open water and empty land), for the Wind
 * layer and the timeline. Cells whose peak stays under `minKt` are dropped.
 */
export function windHexes(states: StormState[], res: number, minKt = MIN_TRACKED_KT): HexWind[] {
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const s of states) {
    const reach = reachNm(s, minKt);
    if (reach <= 0) continue;
    const dLat = reach / 60;
    const dLon = reach / (60 * Math.cos((s.lat * Math.PI) / 180));
    south = Math.min(south, s.lat - dLat);
    north = Math.max(north, s.lat + dLat);
    west = Math.min(west, s.lon - dLon);
    east = Math.max(east, s.lon + dLon);
  }
  if (south > north) return [];
  const box: [number, number][] = [
    [south, west],
    [north, west],
    [north, east],
    [south, east],
    [south, west],
  ];
  const cells = polygonToCells(box, res);
  const centers = cells.map((h3) => {
    const [lat, lon] = cellToLatLng(h3);
    return { lat, lon };
  });
  const impacts = impactsAt(states, centers);
  const out: HexWind[] = [];
  cells.forEach((h3, i) => {
    const imp = impacts[i]!;
    if (imp.maxKt >= minKt) out.push({ h3, ...imp });
  });
  return out;
}
