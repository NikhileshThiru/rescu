# Rescu

**Aid airdropped in seconds.**

Hurricane Helene hit Georgia on September 26, 2024. Disaster SNAP didn't open until October 21. Rescu lands restricted relief dollars in wallets as the storm arrives — **0.93 seconds** median from the wind reaching a home to money confirmed on-chain — spendable only at verified local stores, shopped by Grok, watched by an ML oracle that can suspend a merchant on-chain.

Live: **[rescu.tech](https://rescu.tech)** · Resident app: [/aid](https://rescu.tech/aid) · Merchant: [/merchant](https://rescu.tech/merchant) · Oracle: [/oracle](https://rescu.tech/oracle)

Built solo at HackGT 13 (Sep 25–27, 2026).

## The problem

After a hurricane, people need water, food, medicine and power in hours. What they get:

- FEMA Serious Needs Assistance is about **$750**, later.
- Georgia D-SNAP after Helene: in-person sites, ID required, **25 days** to Phase 1, **~7 weeks** for the last counties.
- Katrina / Rita: **$600M–$1.4B** in improper or potentially fraudulent FEMA individual assistance ([GAO](https://www.gao.gov/products/gao-06-844t)).
- Georgia AG: **~400** price-gouging complaints after Helene / Milton.

Cash that can be sold, delayed EBT, and no live enforcement. Other aid-on-chain projects either have no spending rules (Stellar Aid Assist) or run on a closed chain in camps (WFP Building Blocks).

## What it is

A disaster relief **market** on Solana:

1. **Target.** A multi-hazard model (wind, rain, surge, mobile homes, vulnerability) decides who needs how much from the storm itself at landfall. Trained on 23 US hurricanes and graded against FEMA's real approvals — held-out county overlap **0.64** vs **0.38** for a wind-only rule, better on **22 of 23** storms.
2. **Airdrop.** One click funds a Token-2022 "Relief Dollar" mint. Aid follows the storm: each place is paid when the winds reach it.
3. **Rules on the transfer.** A Token-2022 transfer hook is the checkout. Registered merchant, disaster zone, **$200 / order**, **$300 rolling 24 h**, not expired, not a resale to another resident. Failed payments land on-chain with the rule in the logs.
4. **Shop.** Residents ask Grok (or use a shop UI, or any agent over MCP). Grok searches live shelves and proposes a basket. Nothing pays until the resident taps Confirm. The agent spends an on-chain SPL delegate allowance — over the allowance, Token-2022 itself refuses.
5. **Oracle.** Robust stats + an isolation forest watch prices and wallets. A price hike opens a case in a few hundred milliseconds; one click suspends the store; the next payment is `MerchantSuspended`.

Merchants are simulated (fake names). Identity is mocked. The path to production is EBT-style merchant onboarding, USDC in the treasury, and a Visa card restricted by MCC so every existing Visa merchant works.

## Try it

The Command Center at [rescu.tech](https://rescu.tech) is the live network. Without a presenter key the site is **view-only** (map, feed, numbers). Judges can still:

| Page | What to do |
|---|---|
| [`/aid`](https://rescu.tech/aid) | Pick a persona, or tap **I live here** (your phone makes its own key; we only relay and pay the fee). Ask Grok. Confirm. Pay at a counter QR. |
| [`/merchant`](https://rescu.tech/merchant) | Ring up a charge. (Price edits are presenter-only.) |
| [`/oracle`](https://rescu.tech/oracle) | Read cases the model opened. (Suspend is presenter-only.) |

Scan the Command Center QR to join mid-run from your phone.

## One Helene run, measured

One Atlanta Vultr box (8 vCPU / 16 GB) running our Solana validator + sim + web; Tiger Cloud in us-east-1. Declared 6 hours before landfall at 4×; Day 0 → Day 30 in **7.8 minutes**.

| | |
|---|---|
| Households / stores on-chain | 20,000 / 500, staged in 30 s |
| Aid landed | $19,997,202.94 · **p50 0.93 s** · p95 3.1 s · 0 failed |
| Purchases | 136,645 ($10.14M) · confirm p50 391 ms · peak 582 tx/s |
| Refused by the hook | 423 (daily cap, order cap, resale, unregistered store) |
| Day 30 clawback | $9,853,260.92 returned · spent + returned = disbursed, to the cent |
| Tiger live KPIs | p50 28 ms / p95 39 ms while ingesting up to 2,893 rows/s |
| Oracle (blind to the answer key) | precision 0.99 · recall 0.87 · full scan ~35–75 ms |
| Where it was spent | general 37% · grocery 25% · hardware 20% · pharmacy 18% |

Helene's full-scale projection (the map): **1.56M households / $1.56B** in 125 counties. The chain runs a 20k sample with each tract's exact aid amount.

Raw hook throughput on the same box: **16,000 / 16,000** hooked payments at **819/s**, 43–57k compute units each.

## On-chain, including public devnet

Program `rescu` = registry + treasury + transfer hook. One Token-2022 mint per declaration (`Relief Dollar · Helene 2024`, rUSD). Residents hold **0 SOL**; a relayer pays every fee. Unspent aid burns after 30 days (permanent delegate), like EBT expungement. Merchants keep what they earned.

The live demo uses our validator so 20k wallets and hundreds of payments per second are not aimed at public RPC. The **same program** is on Solana devnet:

**[GrxgRShVcGaESyztvHHtaCF8YMXVhK3Wq7AesbQCaLy5](https://explorer.solana.com/address/GrxgRShVcGaESyztvHHtaCF8YMXVhK3Wq7AesbQCaLy5?cluster=devnet)**

One small Helene declaration, two households with 0 SOL, then a good payment and four refusals — each a real failed transaction with the rule in its logs:

- Paid $42.50 at a grocery ([tx](https://explorer.solana.com/tx/Wibev8gqXRej8FEdKHEkTtTpz9QnjFhtDpRpXHo1ADMGMhTZRcBCY6tDETef6hGcNj6kX88EkTrvXFxJ1HNpVz9?cluster=devnet))
- `NotRegisteredMerchant` ([tx](https://explorer.solana.com/tx/3GqKHqtG9PG7iqaqVYonTADem31qvyazvTnz4ES6y2BA564hLFiZTg5PrtL6p87TSr5gioefgB1kVjJwTu3LLee8?cluster=devnet))
- `OverOrderCap` ($250, cap $200) ([tx](https://explorer.solana.com/tx/4sGb6xLRPQps7VVx3jjWVVsbYCXjnCn2nypXHZAvaQEAzeC4iWBE6qS6LaNY6iJGb1gcX5FFWcPjgz4Q5G64B7es?cluster=devnet))
- `ResaleBlocked` ([tx](https://explorer.solana.com/tx/2Bx8EUb2AJoKrLKushf5SwBVSoUTVoUtsZbPJqHamSUhQyMN6wBhXDiY8mBC5RAAixVMjJqTUR5V3P17dP7TpBQx?cluster=devnet))
- Oracle suspends the pharmacy ([tx](https://explorer.solana.com/tx/2CHno9k1jfWxckWiqM5J1Y63pB26p14ispu41jQJTCc2nKPMZWpqcmoWpyUzPD8iZNnCDBcMrx5KJY8gUjSSmaQP?cluster=devnet)), then `MerchantSuspended` ([tx](https://explorer.solana.com/tx/5Yusr4VBSCpc3WvaWWQhWMUwevD14dk2Njk4AKSprbwreBqmajdigZyGLXqAFop5BJev6e2BpLwzDxu38pawhbyP?cluster=devnet))

Custom-cluster explorer links from the live demo use [rpc.rescu.tech](https://rpc.rescu.tech) (read-only; `requestAirdrop` / `sendTransaction` are refused).

## Stack

| Layer | |
|---|---|
| Chain | Anchor 1.1.2 program, Token-2022 transfer hook, `solana-test-validator` 3.1.10 on Vultr |
| Index + KPIs | Tiger Data (Postgres + TimescaleDB hypertables, continuous aggregates, Toolkit percentile sketches) |
| Sim + API | Node 22, Fastify, WebSocket, MCP (`rescu-relief-market`) |
| AI | Grok (`grok-4.20-non-reasoning`) for shopping + case write-ups |
| Web | Next.js, MapLibre, deck.gl, H3 hexes, OpenFreeMap |

```
programs/rescu     transfer hook + registry + treasury
packages/chain     client, TxSender, error decode
packages/aid-model need model (33 tests) + allocation
packages/oracle    detectors + isolation forest
packages/live      shared wire contract (REST, WS, tools)
apps/server        sim, indexer, Grok, MCP
apps/web           Command Center, /aid, /merchant, /oracle
```

`pnpm e2e -- --server https://rescu.tech` walks the public demo loop (REST, WebSocket, MCP) as a black box.

## Data

NOAA HURDAT2 best tracks, PRISM rainfall, USGS high-water marks, Census 2020 tracts (83,241), CDC SVI 2022, OpenFEMA approvals across 23 storms (scorecard only — never an input at landfall).

## Honest limits

No weather model sees a levee failure (New Orleans 2005) or every tree that fell in upstate South Carolina. Katrina's Cat 1 pass over Miami qualifies Miami-Dade and Broward; FEMA gave Florida no household aid. Officials can override the county list; that editor is next. Identity is mocked. Delivery is out of scope — money stays in open local stores.

## License

Hackathon demo. Not affiliated with FEMA, NOAA, or any merchant whose name we invented.
