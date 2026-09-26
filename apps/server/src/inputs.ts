import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { REPO_ROOT } from "./config.js";
import type { StormInput, TractInput } from "./world.js";

/** The committed map file (`pnpm web:data`), so the sim times aid exactly like the map. */
export function loadStormFile(slug: string): StormInput {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`bad storm slug ${slug}`);
  return JSON.parse(readFileSync(new URL(`apps/web/public/data/${slug}.json`, REPO_ROOT), "utf8"));
}

export function demoStorms(): { slug: string; name: string; year: number }[] {
  return JSON.parse(readFileSync(new URL("apps/web/public/data/storms.json", REPO_ROOT), "utf8"));
}

/** Every tract in a county the storm touched, with its modeled need (0 where none). */
export async function loadTracts(sql: postgres.Sql, stormId: string): Promise<TractInput[]> {
  const rows = await sql<
    { geoid: string; county_fips: string; county_name: string; state_abbr: string; lat: number; lon: number; households: number; population: number; svi: number; need: number }[]
  >`
    with touched as (
      select distinct t.county_fips
      from storm_tract_impacts i join tracts t using (geoid)
      where i.storm_id = ${stormId} and i.need > 0
    )
    select t.geoid, t.county_fips, t.county_name, t.state_abbr, t.lat, t.lon, t.households, t.population, t.svi,
           coalesce(i.need, 0)::float8 as need
    from tracts t
    left join storm_tract_impacts i on i.geoid = t.geoid and i.storm_id = ${stormId}
    where t.county_fips in (select county_fips from touched)
    order by t.geoid`;
  return rows.map((r) => ({
    geoid: r.geoid,
    countyFips: r.county_fips,
    countyName: r.county_name,
    state: r.state_abbr,
    lat: r.lat,
    lon: r.lon,
    households: r.households,
    population: r.population,
    svi: r.svi,
    need: r.need,
  }));
}
