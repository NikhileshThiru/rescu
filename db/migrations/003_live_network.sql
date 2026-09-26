-- Live network: each sim run is one relief declaration on-chain. Every transaction the sim sends
-- is recorded as it confirms, in hypertables partitioned on real time (ingest order) with the
-- sim time alongside for the timeline and the history view. Continuous aggregates feed the
-- Command Center's live numbers.

create table sim_runs (
  -- The declaration id on-chain.
  id bigint primary key,
  storm_id text not null references storms (id) on delete cascade,
  mint text not null,
  declaration text not null,
  households integer not null,
  merchants integer not null,
  budget_cents bigint not null,
  -- Households the model pays at full scale; the on-chain run is a sample of them.
  full_scale_households integer not null,
  sim_start timestamptz not null,
  sim_end timestamptz not null,
  staged_at timestamptz not null default now(),
  declared_at timestamptz,
  ended_at timestamptz,
  config jsonb not null default '{}'
);

create table sim_households (
  run_id bigint not null references sim_runs (id) on delete cascade,
  idx integer not null,
  owner text not null,
  geoid text not null,
  county_fips text not null,
  h3_r5 h3index not null,
  lat double precision not null,
  lon double precision not null,
  size smallint not null,
  svi real not null,
  aid_cents bigint not null,
  -- When the storm reaches the household's hex (the moment its aid is due).
  aid_due_at timestamptz not null,
  primary key (run_id, idx)
);

create table sim_merchants (
  run_id bigint not null references sim_runs (id) on delete cascade,
  idx integer not null,
  owner text not null,
  name text not null,
  category text not null,
  county_fips text not null,
  h3_r5 h3index not null,
  lat double precision not null,
  lon double precision not null,
  closed_from timestamptz,
  reopens_at timestamptz,
  primary key (run_id, idx)
);

-- Every transaction the sim sends: register, enroll, fund, disburse, payment, clock, clawback.
create table chain_txs (
  ts timestamptz not null,
  run_id bigint not null,
  sim_ts timestamptz not null,
  kind text not null,
  ok boolean not null,
  -- The on-chain rule that rejected it (e.g. OverDailyCap), null when it landed.
  error text,
  recipients integer not null default 0,
  amount_cents bigint not null default 0,
  latency_ms integer not null,
  signature text not null
);
select create_hypertable('chain_txs', by_range('ts', interval '30 minutes'));
create index chain_txs_run_sim_idx on chain_txs (run_id, sim_ts);

-- One row per household paid. time_to_aid_ms: from the storm reaching its hex to confirmed.
create table disbursements (
  ts timestamptz not null,
  run_id bigint not null,
  sim_ts timestamptz not null,
  household integer not null,
  h3_r5 h3index not null,
  amount_cents bigint not null,
  time_to_aid_ms integer not null,
  signature text not null
);
select create_hypertable('disbursements', by_range('ts', interval '30 minutes'));
create index disbursements_run_sim_idx on disbursements (run_id, sim_ts);

-- One row per payment attempt, landed or rejected by the transfer hook.
create table payments (
  ts timestamptz not null,
  run_id bigint not null,
  sim_ts timestamptz not null,
  household integer not null,
  merchant integer not null,
  category text not null,
  amount_cents bigint not null,
  item_ids smallint[] not null,
  item_qty smallint[] not null,
  -- Unit price charged per item, cents (the oracle compares these to pre-storm prices).
  item_cents integer[] not null,
  ok boolean not null,
  error text,
  h3_r5 h3index not null,
  merchant_h3_r5 h3index not null,
  latency_ms integer not null,
  signature text not null
);
select create_hypertable('payments', by_range('ts', interval '30 minutes'));
create index payments_run_sim_idx on payments (run_id, sim_ts);

-- Columnstore (compression) once a chunk is an hour old; segmenting by run keeps a run's
-- history queries on a few segments.
alter table chain_txs set (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'run_id', timescaledb.orderby = 'ts');
alter table disbursements set (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'run_id', timescaledb.orderby = 'ts');
alter table payments set (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'run_id', timescaledb.orderby = 'ts');
call add_columnstore_policy('chain_txs', after => interval '1 hour');
call add_columnstore_policy('disbursements', after => interval '1 hour');
call add_columnstore_policy('payments', after => interval '1 hour');

-- Transactions per second by kind and outcome, with a latency sketch per bucket. Real-time
-- (materialized_only = false) so the newest seconds are always included.
create materialized view chain_txs_1s
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select
  time_bucket('1 second', ts) as bucket,
  run_id,
  kind,
  ok,
  error,
  count(*) as txs,
  sum(recipients) as recipients,
  sum(amount_cents) as amount_cents,
  percentile_agg(latency_ms) as latency
from chain_txs
group by 1, 2, 3, 4, 5
with no data;

-- Aid landed per second, with a time-to-aid sketch (median over a run = rollup of the sketches).
create materialized view disbursements_1s
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select
  time_bucket('1 second', ts) as bucket,
  run_id,
  count(*) as households,
  sum(amount_cents) as amount_cents,
  percentile_agg(time_to_aid_ms) as time_to_aid
from disbursements
group by 1, 2
with no data;

select add_continuous_aggregate_policy('chain_txs_1s', start_offset => interval '2 hours', end_offset => interval '10 seconds', schedule_interval => interval '30 seconds');
select add_continuous_aggregate_policy('disbursements_1s', start_offset => interval '2 hours', end_offset => interval '10 seconds', schedule_interval => interval '30 seconds');
