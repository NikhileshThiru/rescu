/**
 * Observed storm-total rainfall per tract from PRISM daily grids (Oregon State, free; ~4 km).
 * For each storm: every day its center was within reach of the US, plus one day after. Each
 * day's grid is downloaded once into data/raw/prism/ (PRISM allows two downloads per file per
 * day) and never again. Writes data/out/rain/<slug>.csv. `pnpm --filter @rescu/data rain`
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fromArrayBuffer } from "geotiff";
import { OUT_DIR, readStorms, readTracts } from "./lib.js";

const RAW = new URL("../raw/prism/", import.meta.url);
const OUT = new URL("rain/", OUT_DIR);
/** Rain farther than this from the storm's track is some other weather system. */
const MAX_TRACK_DISTANCE_KM = 600;
const NEAR_US_KM = 500;

const toRad = Math.PI / 180;
function km(lat1: number, lon1: number, lat2: number, lon2: number) {
  const a = Math.sin(((lat2 - lat1) * toRad) / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(((lon2 - lon1) * toRad) / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(a)));
}
const ymd = (t: number) => new Date(t * 1000).toISOString().slice(0, 10).replaceAll("-", "");

async function grid(day: string) {
  const zip = new URL(`prism_ppt_us_25m_${day}.zip`, RAW);
  if (!existsSync(zip)) {
    const res = await fetch(`https://services.nacse.org/prism/data/get/us/4km/ppt/${day}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (!res.ok || body.subarray(0, 2).toString() !== "PK") {
      throw new Error(`PRISM ${day}: HTTP ${res.status}, ${body.length} bytes (not a zip). Stopping so we don't hammer the service.`);
    }
    writeFileSync(zip, body);
    await new Promise((r) => setTimeout(r, 1_500));
  }
  const tif = execFileSync("unzip", ["-p", zip.pathname, `prism_ppt_us_25m_${day}.tif`], { maxBuffer: 64 << 20 });
  const image = await (await fromArrayBuffer(tif.buffer.slice(tif.byteOffset, tif.byteOffset + tif.byteLength))).getImage();
  const [data] = (await image.readRasters()) as unknown as [Float32Array];
  const [x0, y0] = image.getOrigin() as [number, number];
  const [dx, dy] = image.getResolution() as [number, number];
  return { data, width: image.getWidth(), height: image.getHeight(), x0, y0, dx, dy: Math.abs(dy) };
}

type Grid = Awaited<ReturnType<typeof grid>>;
/** mm at a point; coastal centroids that land in an ocean (nodata) cell use the wettest neighbour. */
function sample(g: Grid, lat: number, lon: number) {
  const col = Math.floor((lon - g.x0) / g.dx);
  const row = Math.floor((g.y0 - lat) / g.dy);
  let best = -1;
  for (let r = row - 1; r <= row + 1; r++) {
    for (let c = col - 1; c <= col + 1; c++) {
      if (r < 0 || c < 0 || r >= g.height || c >= g.width) continue;
      const v = g.data[r * g.width + c]!;
      if (v >= 0 && (r === row && c === col ? true : best < 0)) best = r === row && c === col ? v : Math.max(best, v);
    }
  }
  return Math.max(0, best);
}

mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });
const tracts = readTracts();
const probe = tracts.filter((_, i) => i % 40 === 0);
const only = process.argv[2];

for (const storm of readStorms()) {
  if (only && storm.slug !== only) continue;
  const near = storm.points.filter((p) => probe.some((t) => km(p.lat, p.lon, t.lat, t.lon) < NEAR_US_KM));
  if (near.length === 0) {
    console.log(`${storm.name}: never near the US, skipped`);
    continue;
  }
  // One day early catches rain that runs ahead of the storm (Helene's "predecessor" rain soaked
  // the mountains the day before it arrived); two days after catches the tail.
  const days: string[] = [];
  for (let t = near[0]!.t - 86_400; t <= near[near.length - 1]!.t + 86_400 * 2; t += 86_400) days.push(ymd(t));
  const window = days.slice(0, 11);

  const inRange = tracts
    .map((t, i) => ({ i, t }))
    .filter(({ t }) => near.some((p) => km(p.lat, p.lon, t.lat, t.lon) < MAX_TRACK_DISTANCE_KM));
  const totals = new Float64Array(inRange.length);
  const daily: number[][] = inRange.map(() => []);
  for (const day of window) {
    const g = await grid(day);
    inRange.forEach(({ t }, k) => {
      const mm = sample(g, t.lat, t.lon);
      totals[k] = totals[k]! + mm;
      daily[k]!.push(Math.round(mm * 10) / 10);
    });
  }
  const lines = [`geoid,total_mm,${window.map((d) => `d${d}`).join(",")}`];
  let wettest = { mm: 0, where: "" };
  inRange.forEach(({ t }, k) => {
    if (totals[k]! < 5) return;
    lines.push(`${t.geoid},${totals[k]!.toFixed(1)},${daily[k]!.join(",")}`);
    if (totals[k]! > wettest.mm) wettest = { mm: totals[k]!, where: `${t.countyName}, ${t.stateAbbr}` };
  });
  writeFileSync(new URL(`${storm.slug}.csv`, OUT), lines.join("\n") + "\n");
  console.log(
    `${storm.name} ${storm.year}: ${window[0]}..${window[window.length - 1]} (${window.length} days), ` +
      `${lines.length - 1} tracts with rain, wettest ${(wettest.mm / 25.4).toFixed(1)} in (${wettest.where})`,
  );
}
