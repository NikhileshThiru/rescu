-- Multi-hazard need model: rain and surge per tract, the tuned need, FEMA's real outcomes as the
-- scorecard, and the model that produced the numbers.

alter table tracts add column dist_coast_km real;

-- Demo storms appear in the app; the rest are training storms for the need model.
alter table storms add column demo boolean not null default false;

alter table storm_tract_impacts
  add column rain_in real not null default 0,
  add column rain_daily_in real[],
  add column surge_index real not null default 0,
  -- Expected share of households needing help (0 to 1), from the tuned need model.
  add column need real not null default 0,
  add column dominant_hazard text;

-- What FEMA actually approved for households (Individuals & Households Program, owners + renters).
create table fema_outcomes (
  storm_id text not null references storms (id) on delete cascade,
  county_fips text not null,
  registrations integer not null,
  approved_households integer not null,
  approved_usd numeric(14, 2) not null,
  ia_designated boolean not null,
  primary key (storm_id, county_fips)
);

create table need_models (
  id bigserial primary key,
  fitted_at timestamptz not null,
  trained_on text[] not null,
  params jsonb not null,
  validation jsonb not null,
  active boolean not null default false
);
create unique index need_models_one_active on need_models (active) where active;
