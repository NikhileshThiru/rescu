/**
 * Loads everything into Tiger: tracts, all storms (demo + training), FEMA's real outcomes,
 * per-tract hazards and tuned need for every storm, and the wind field on H3 for demo storms.
 * Idempotent: replaces what it loads. `pnpm data:load` (after db:migrate, data:features, data:fit)
 */
import { readFileSync } from "node:fs";
import { DEFAULT_NEED_MODEL, dominantHazard, need, windHexes } from "@rescu/aid-model";
import { connect } from "./db.js";
import { OUT_DIR, readCoastDistance, readFema, readStorms, readTracts, runStorm } from "./lib.js";

const HEX_RESOLUTIONS = [4, 5];
const CHUNK = 10_000;

const sql = connect();
const timings: Record<string, number> = {};
async function time<T>(label: string, fn: () => Promise<T>) {
  const t0 = performance.now();
  const out = await fn();
  timings[label] = Math.round(performance.now() - t0);
  return out;
}

/** Daily rain per tract (inches), for demo storms, so the sim can reveal flooding day by day. */
function dailyRain(slug: string): Map<string, number[]> {
  const [, ...lines] = readFileSync(new URL(`rain/${slug}.csv`, OUT_DIR), "utf8").trim().split(/\r?\n/);
  return new Map(
    lines.map((l) => {
      const [geoid, , ...days] = l.split(",");
      return [geoid!, days.map((d) => Math.round((Number(d) / 25.4) * 100) / 100)];
    }),
  );
}

function features(slug: string) {
  const [, ...lines] = readFileSync(new URL(`features/${slug}.csv`, OUT_DIR), "utf8").trim().split(/\r?\n/);
  const n = (x: string | undefined) => (x ? Number(x) : null);
  return lines.map((l) => {
    const f = l.split(",");
    return { geoid: f[0]!, windKt: Number(f[1]), peakT: n(f[2]), t34: n(f[3]), t64: n(f[4]), rainIn: Number(f[5]), surge: Number(f[7]) };
  });
}

try {
  const tracts = readTracts();
  const byGeoid = new Map(tracts.map((t) => [t.geoid, t]));
  const coast = readCoastDistance();
  const storms = readStorms();
  const fema = readFema();

  await time("tracts", () =>
    sql.begin(async (tx) => {
      await tx`delete from storm_tract_impacts`;
      await tx`delete from tracts`;
      for (let i = 0; i < tracts.length; i += CHUNK) {
        const c = tracts.slice(i, i + CHUNK);
        const col = <K extends keyof (typeof c)[number]>(k: K) => c.map((t) => t[k]);
        await tx`
          insert into tracts (
            geoid, state_abbr, state_name, county_fips, county_name, lat, lon, population, households,
            svi, svi_imputed, svi_socioeconomic, svi_household, svi_minority, svi_housing,
            pct_poverty, pct_no_vehicle, pct_age65, pct_disability, pct_limited_english, pct_mobile_home, dist_coast_km
          )
          select * from unnest(
            ${col("geoid")}::text[], ${col("stateAbbr")}::text[], ${col("stateName")}::text[],
            ${col("countyFips")}::text[], ${col("countyName")}::text[],
            ${col("lat")}::float8[], ${col("lon")}::float8[], ${col("population")}::int[], ${col("households")}::int[],
            ${col("svi")}::real[], ${col("sviImputed").map(String)}::text[]::bool[],
            ${col("sviSocioeconomic")}::real[], ${col("sviHousehold")}::real[], ${col("sviMinority")}::real[], ${col("sviHousing")}::real[],
            ${col("pctPoverty")}::real[], ${col("pctNoVehicle")}::real[], ${col("pctAge65")}::real[],
            ${col("pctDisability")}::real[], ${col("pctLimitedEnglish")}::real[], ${col("pctMobileHome")}::real[],
            ${c.map((t) => coast.get(t.geoid) ?? 200)}::real[]
          )`;
      }
    }),
  );
  console.log(`tracts: ${tracts.length.toLocaleString()} rows in ${timings.tracts} ms`);

  for (const storm of storms) {
    const f = fema[storm.id];
    const rows = features(storm.slug).filter((r) => byGeoid.has(r.geoid));
    const daily = storm.demo ? dailyRain(storm.slug) : null;
    const states = storm.demo ? runStorm(storm, []).states : [];
    const hexes = HEX_RESOLUTIONS.filter(() => storm.demo).map((res) => ({ res, cells: windHexes(states, res) }));

    await time(storm.slug, () =>
      sql.begin(async (tx) => {
        await tx`delete from storms where id = ${storm.id}`;
        const p = storm.points;
        await tx`
          insert into storms (id, slug, name, year, starts_at, ends_at, landfalls, demo)
          values (${storm.id}, ${storm.slug}, ${storm.name}, ${storm.year}, to_timestamp(${p[0]!.t}),
                  to_timestamp(${p[p.length - 1]!.t}), ${tx.json(storm.landfalls)}, ${storm.demo})`;
        await tx`
          insert into storm_points (storm_id, ts, lat, lon, vmax_kt, pmin_mb, status, record, r34_nm, r50_nm, r64_nm, rmw_nm)
          select ${storm.id}, to_timestamp(t), lat, lon, vmax, pmin, status, record,
                 string_to_array(r34, ',', 'NULL')::int[], string_to_array(r50, ',', 'NULL')::int[],
                 string_to_array(r64, ',', 'NULL')::int[], rmw
          from unnest(
            ${p.map((x) => x.t)}::float8[], ${p.map((x) => x.lat)}::float8[], ${p.map((x) => x.lon)}::float8[],
            ${p.map((x) => x.vmax)}::int[], ${p.map((x) => x.pmin)}::int[], ${p.map((x) => x.status)}::text[],
            ${p.map((x) => x.record)}::text[],
            ${p.map((x) => x.r34.map((r) => r ?? "NULL").join(","))}::text[],
            ${p.map((x) => x.r50.map((r) => r ?? "NULL").join(","))}::text[],
            ${p.map((x) => x.r64.map((r) => r ?? "NULL").join(","))}::text[],
            ${p.map((x) => x.rmw)}::int[]
          ) as u(t, lat, lon, vmax, pmin, status, record, r34, r50, r64, rmw)`;

        if (f) {
          const designated = new Set(f.iaCounties);
          const counties = [...new Set([...Object.keys(f.ihp), ...f.iaCounties])];
          await tx`
            insert into fema_outcomes (storm_id, county_fips, registrations, approved_households, approved_usd, ia_designated)
            select ${storm.id}, fips, reg, approved, usd, ia from unnest(
              ${counties}::text[],
              ${counties.map((c) => f.ihp[c]?.registrations ?? 0)}::int[],
              ${counties.map((c) => f.ihp[c]?.approved ?? 0)}::int[],
              ${counties.map((c) => f.ihp[c]?.amount ?? 0)}::numeric[],
              ${counties.map((c) => String(designated.has(c)))}::text[]::bool[]
            ) as u(fips, reg, approved, usd, ia)`;
          if (f.iaCounties.length) {
            await tx`insert into declared_counties (storm_id, county_fips) select ${storm.id}, unnest(${f.iaCounties}::text[])`;
          }
        }

        for (let i = 0; i < rows.length; i += CHUNK) {
          const c = rows.slice(i, i + CHUNK).map((r) => {
            const t = byGeoid.get(r.geoid)!;
            const h = { windKt: r.windKt, rainIn: r.rainIn, surge: r.surge, mobileShare: (t.pctMobileHome ?? 0) / 100 };
            return { ...r, need: need(h), dominant: dominantHazard(h, DEFAULT_NEED_MODEL.params), daily: daily?.get(r.geoid) ?? null };
          });
          await tx`
            insert into storm_tract_impacts
              (storm_id, geoid, max_wind_kt, band, peak_at, t34_at, t64_at, rain_in, rain_daily_in, surge_index, need, dominant_hazard)
            select ${storm.id}, geoid, kt,
                   case when kt >= 96 then 4 when kt >= 64 then 3 when kt >= 50 then 2 when kt >= 34 then 1 else 0 end,
                   to_timestamp(peak), to_timestamp(t34), to_timestamp(t64), rain,
                   case when daily = '' then null else string_to_array(daily, ',')::real[] end,
                   surge, need, dominant
            from unnest(
              ${c.map((x) => x.geoid)}::text[], ${c.map((x) => x.windKt)}::real[],
              ${c.map((x) => x.peakT)}::float8[], ${c.map((x) => x.t34)}::float8[], ${c.map((x) => x.t64)}::float8[],
              ${c.map((x) => x.rainIn)}::real[], ${c.map((x) => (x.daily ? x.daily.join(",") : ""))}::text[],
              ${c.map((x) => x.surge)}::real[], ${c.map((x) => x.need)}::real[], ${c.map((x) => x.dominant)}::text[]
            ) as u(geoid, kt, peak, t34, t64, rain, daily, surge, need, dominant)`;
        }

        for (const { res, cells } of hexes) {
          for (let i = 0; i < cells.length; i += CHUNK) {
            const c = cells.slice(i, i + CHUNK);
            await tx`
              insert into storm_hex_wind (storm_id, res, h3, max_wind_kt, band, peak_at, t34_at, t50_at, t64_at)
              select ${storm.id}, ${res}, h3::h3index, kt, band, to_timestamp(peak), to_timestamp(t34), to_timestamp(t50), to_timestamp(t64)
              from unnest(
                ${c.map((x) => x.h3)}::text[], ${c.map((x) => x.maxKt)}::real[], ${c.map((x) => x.band)}::smallint[],
                ${c.map((x) => x.peakT)}::float8[], ${c.map((x) => x.t34)}::float8[],
                ${c.map((x) => x.t50)}::float8[], ${c.map((x) => x.t64)}::float8[]
              ) as u(h3, kt, band, peak, t34, t50, t64)`;
          }
        }
      }),
    );
    console.log(
      `${storm.name.padEnd(9)}${storm.year}${storm.demo ? " (demo)" : "       "}: ${rows.length.toLocaleString()} tract impacts` +
        (hexes.length ? `, ${hexes.map((h) => `${h.cells.length.toLocaleString()} res-${h.res} hexes`).join(", ")}` : "") +
        ` (${timings[storm.slug]} ms)`,
    );
  }

  const model = JSON.parse(readFileSync(new URL("need-model.json", OUT_DIR), "utf8"));
  await sql.begin(async (tx) => {
    await tx`update need_models set active = false where active`;
    await tx`
      insert into need_models (fitted_at, trained_on, params, validation, active)
      values (${model.fittedAt}, ${model.trainedOn},
              ${tx.json({ params: model.params, rainModelScale: model.rainModelScale, declareThreshold: model.declareThreshold })},
              ${tx.json({ overall: model.overall, validation: model.validation })}, true)`;
  });

  const [counts] = await sql`
    select (select count(*) from tracts) as tracts, (select count(*) from storms) as storms,
           (select count(*) from storm_tract_impacts) as impacts, (select count(*) from storm_hex_wind) as hexes,
           (select count(*) from fema_outcomes) as fema_counties,
           pg_size_pretty(pg_database_size(current_database())) as size`;
  console.log("tiger:", counts);
} finally {
  await sql.end();
}
