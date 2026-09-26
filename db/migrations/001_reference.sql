-- Reference data: census tracts (with SVI), storm tracks, FEMA county designations, and each
-- storm's precomputed wind impact per tract and per H3 cell. Live event hypertables come later.

create extension if not exists postgis;
create extension if not exists h3;
create extension if not exists h3_postgis cascade;

create table tracts (
  geoid text primary key,
  state_abbr text not null,
  state_name text not null,
  county_fips text not null,
  county_name text not null,
  lat double precision not null,
  lon double precision not null,
  population integer not null,
  households integer not null,
  svi real not null,
  svi_imputed boolean not null,
  svi_socioeconomic real,
  svi_household real,
  svi_minority real,
  svi_housing real,
  pct_poverty real,
  pct_no_vehicle real,
  pct_age65 real,
  pct_disability real,
  pct_limited_english real,
  pct_mobile_home real,
  geog geography(point, 4326) generated always as (st_setsrid(st_makepoint(lon, lat), 4326)::geography) stored,
  h3_r4 h3index generated always as (h3_lat_lng_to_cell(point(lon, lat), 4)) stored,
  h3_r5 h3index generated always as (h3_lat_lng_to_cell(point(lon, lat), 5)) stored,
  h3_r6 h3index generated always as (h3_lat_lng_to_cell(point(lon, lat), 6)) stored
);
create index tracts_geog_idx on tracts using gist (geog);
create index tracts_county_idx on tracts (county_fips);
create index tracts_h3_r4_idx on tracts (h3_r4);
create index tracts_h3_r5_idx on tracts (h3_r5);
create index tracts_h3_r6_idx on tracts (h3_r6);

create table storms (
  id text primary key,
  slug text not null unique,
  name text not null,
  year integer not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  landfalls jsonb not null default '[]'
);

-- Best-track fixes. Radii are nm per quadrant (NE, SE, SW, NW).
create table storm_points (
  storm_id text not null references storms (id) on delete cascade,
  ts timestamptz not null,
  lat double precision not null,
  lon double precision not null,
  vmax_kt integer,
  pmin_mb integer,
  status text not null,
  record text not null,
  r34_nm integer[],
  r50_nm integer[],
  r64_nm integer[],
  rmw_nm integer,
  primary key (storm_id, ts)
);

-- Counties FEMA designated for Individual Assistance (source 'fema'), or declared by hand.
create table declared_counties (
  storm_id text not null references storms (id) on delete cascade,
  county_fips text not null,
  source text not null default 'fema',
  primary key (storm_id, county_fips)
);

-- Peak wind per tract over the storm, and when 34/50/64 kt winds first arrived.
create table storm_tract_impacts (
  storm_id text not null references storms (id) on delete cascade,
  geoid text not null references tracts (geoid) on delete cascade,
  max_wind_kt real not null,
  band smallint not null,
  peak_at timestamptz,
  t34_at timestamptz,
  t50_at timestamptz,
  t64_at timestamptz,
  primary key (storm_id, geoid)
);

-- The same over an H3 grid (includes open water) for the map's Wind layer and timeline.
create table storm_hex_wind (
  storm_id text not null references storms (id) on delete cascade,
  res smallint not null,
  h3 h3index not null,
  max_wind_kt real not null,
  band smallint not null,
  peak_at timestamptz,
  t34_at timestamptz,
  t50_at timestamptz,
  t64_at timestamptz,
  primary key (storm_id, res, h3)
);
