/**
 * Loads reference data into Tiger and precomputes each storm's wind impact per tract and per
 * H3 cell. Idempotent: replaces what it loads. `pnpm data:load` (after `pnpm db:migrate`)
 */
import { readFileSync } from "node:fs";
import { windHexes } from "@rescu/aid-model";
import { connect } from "./db.js";
import { OUT_DIR, readStorms, readTracts, runStorm } from "./lib.js";

const HEX_RESOLUTIONS = [4, 5];
const CHUNK = 10_000;
const ts = (t: number | null) => (t === null ? null : t);

const sql = connect();
const timings: Record<string, number> = {};
const time = async <T>(label: string, fn: () => Promise<T>) => {
  const t0 = performance.now();
  const out = await fn();
  timings[label] = Math.round(performance.now() - t0);
  return out;
};

try {
  const tracts = readTracts();
  const storms = readStorms();
  const declared: Record<string, { counties: string[] }> = JSON.parse(
    readFileSync(new URL("declared_counties.json", OUT_DIR), "utf8"),
  );

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
            pct_poverty, pct_no_vehicle, pct_age65, pct_disability, pct_limited_english, pct_mobile_home
          )
          select * from unnest(
            ${col("geoid")}::text[], ${col("stateAbbr")}::text[], ${col("stateName")}::text[],
            ${col("countyFips")}::text[], ${col("countyName")}::text[],
            ${col("lat")}::float8[], ${col("lon")}::float8[], ${col("population")}::int[], ${col("households")}::int[],
            ${col("svi")}::real[], ${col("sviImputed").map(String)}::text[]::bool[],
            ${col("sviSocioeconomic")}::real[], ${col("sviHousehold")}::real[], ${col("sviMinority")}::real[], ${col("sviHousing")}::real[],
            ${col("pctPoverty")}::real[], ${col("pctNoVehicle")}::real[], ${col("pctAge65")}::real[],
            ${col("pctDisability")}::real[], ${col("pctLimitedEnglish")}::real[], ${col("pctMobileHome")}::real[]
          )`;
      }
    }),
  );
  console.log(`tracts: ${tracts.length.toLocaleString()} rows in ${timings.tracts} ms`);

  for (const storm of storms) {
    const run = runStorm(storm, tracts);
    const hexes = HEX_RESOLUTIONS.map((res) => ({ res, cells: windHexes(run.states, res) }));
    const counties = declared[storm.id]?.counties ?? [];

    await time(storm.slug, () =>
      sql.begin(async (tx) => {
        await tx`delete from storms where id = ${storm.id}`;
        const first = storm.points[0]!.t;
        const last = storm.points[storm.points.length - 1]!.t;
        await tx`
          insert into storms (id, slug, name, year, starts_at, ends_at, landfalls)
          values (${storm.id}, ${storm.slug}, ${storm.name}, ${storm.year},
                  to_timestamp(${first}), to_timestamp(${last}), ${tx.json(storm.landfalls)})`;
        const p = storm.points;
        await tx`
          insert into storm_points (storm_id, ts, lat, lon, vmax_kt, pmin_mb, status, record, r34_nm, r50_nm, r64_nm, rmw_nm)
          select ${storm.id}, to_timestamp(t), lat, lon, vmax, pmin, status, record,
                 string_to_array(r34, ',', 'NULL')::int[], string_to_array(r50, ',', 'NULL')::int[], string_to_array(r64, ',', 'NULL')::int[], rmw
          from unnest(
            ${p.map((x) => x.t)}::float8[], ${p.map((x) => x.lat)}::float8[], ${p.map((x) => x.lon)}::float8[],
            ${p.map((x) => x.vmax)}::int[], ${p.map((x) => x.pmin)}::int[], ${p.map((x) => x.status)}::text[],
            ${p.map((x) => x.record)}::text[],
            ${p.map((x) => x.r34.map((r) => r ?? "NULL").join(","))}::text[],
            ${p.map((x) => x.r50.map((r) => r ?? "NULL").join(","))}::text[],
            ${p.map((x) => x.r64.map((r) => r ?? "NULL").join(","))}::text[],
            ${p.map((x) => x.rmw)}::int[]
          ) as u(t, lat, lon, vmax, pmin, status, record, r34, r50, r64, rmw)`;
        if (counties.length) {
          await tx`insert into declared_counties (storm_id, county_fips) select ${storm.id}, unnest(${counties}::text[])`;
        }

        const hit = run.impacts.map((imp, i) => ({ imp, geoid: tracts[i]!.geoid })).filter((x) => x.imp.maxKt > 0);
        for (let i = 0; i < hit.length; i += CHUNK) {
          const c = hit.slice(i, i + CHUNK);
          await tx`
            insert into storm_tract_impacts (storm_id, geoid, max_wind_kt, band, peak_at, t34_at, t50_at, t64_at)
            select ${storm.id}, geoid, kt, band, to_timestamp(peak), to_timestamp(t34), to_timestamp(t50), to_timestamp(t64)
            from unnest(
              ${c.map((x) => x.geoid)}::text[], ${c.map((x) => x.imp.maxKt)}::real[], ${c.map((x) => x.imp.band)}::smallint[],
              ${c.map((x) => ts(x.imp.peakT))}::float8[], ${c.map((x) => ts(x.imp.t34))}::float8[],
              ${c.map((x) => ts(x.imp.t50))}::float8[], ${c.map((x) => ts(x.imp.t64))}::float8[]
            ) as u(geoid, kt, band, peak, t34, t50, t64)`;
        }

        for (const { res, cells } of hexes) {
          for (let i = 0; i < cells.length; i += CHUNK) {
            const c = cells.slice(i, i + CHUNK);
            await tx`
              insert into storm_hex_wind (storm_id, res, h3, max_wind_kt, band, peak_at, t34_at, t50_at, t64_at)
              select ${storm.id}, ${res}, h3::h3index, kt, band, to_timestamp(peak), to_timestamp(t34), to_timestamp(t50), to_timestamp(t64)
              from unnest(
                ${c.map((x) => x.h3)}::text[], ${c.map((x) => x.maxKt)}::real[], ${c.map((x) => x.band)}::smallint[],
                ${c.map((x) => ts(x.peakT))}::float8[], ${c.map((x) => ts(x.t34))}::float8[],
                ${c.map((x) => ts(x.t50))}::float8[], ${c.map((x) => ts(x.t64))}::float8[]
              ) as u(h3, kt, band, peak, t34, t50, t64)`;
          }
        }
        console.log(
          `${storm.name}: ${storm.points.length} fixes, ${counties.length} FEMA counties, ` +
            `${hit.length.toLocaleString()} tract impacts, ` +
            hexes.map((h) => `${h.cells.length.toLocaleString()} res-${h.res} hexes`).join(", ") +
            ` (model ${run.ms.toFixed(0)} ms)`,
        );
      }),
    );
  }

  const [counts] = await sql`
    select (select count(*) from tracts) as tracts,
           (select count(*) from storm_tract_impacts) as impacts,
           (select count(*) from storm_hex_wind) as hexes,
           pg_size_pretty(pg_database_size(current_database())) as size`;
  console.log("tiger:", counts, "ms:", timings);
} finally {
  await sql.end();
}
