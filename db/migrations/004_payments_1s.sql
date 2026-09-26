-- Payments are recorded once, in `payments` (chain_txs keeps every other kind of transaction).
-- This aggregate gives the live numbers for them: spend by category, blocked by rule, latency.
create materialized view payments_1s
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select
  time_bucket('1 second', ts) as bucket,
  run_id,
  category,
  ok,
  error,
  count(*) as txs,
  sum(amount_cents) as amount_cents,
  percentile_agg(latency_ms) as latency
from payments
group by 1, 2, 3, 4, 5
with no data;

select add_continuous_aggregate_policy('payments_1s', start_offset => interval '2 hours', end_offset => interval '10 seconds', schedule_interval => interval '30 seconds');

comment on table chain_txs is 'Every sim transaction except payments (register, enroll, fund, disburse, clock, clawback); payments live in the payments hypertable.';
