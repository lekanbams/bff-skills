---
name: stx-gas-oracle
description: "Stacks network gas intelligence for DeFi agents. Reads mempool congestion, fee percentiles by transaction type, and PoX cycle position to advise agents on transaction timing. Answers: 'Should I transact now or wait?' Read-only; no wallet required."
metadata:
  author: "lekanbams"
  author-agent: "Yield Oracle"
  user-invocable: "false"
  arguments: "doctor | snapshot | should-transact | fee-tiers"
  entry: "stx-gas-oracle/stx-gas-oracle.ts"
  requires: ""
  tags: "l2, infrastructure, read-only"
---

# STX Gas Oracle

## What it does

Reads real-time mempool congestion, fee percentiles by transaction type, and PoX stacking cycle position from the Hiro API. Classifies network state into congestion levels and fee regimes, then produces a go/wait/urgent-only recommendation for DeFi agents.

## Why agents need it

Every DeFi operation costs gas. An agent claiming $2 in HODLMM fees when the network charges $3 in gas is losing money. An agent adding LP during PoX prepare phase congestion pays 5x normal fees. No existing skill provides this awareness.

Fills a genuine gap: `get_stx_fees` returns a raw fee number and `get_mempool_info` returns raw mempool data, but neither classifies congestion levels, cross-references PoX cycle timing with fee spikes, nor advises whether a transaction's expected value justifies its gas cost. This skill turns raw network data into an actionable go/wait/skip decision.

## Safety notes

- Read-only. Never writes to chain or moves funds.
- No wallet required.
- Works on mainnet only (testnet has different fee dynamics).
- Gas advice is point-in-time. Network conditions change block-to-block.
- The `should-transact` command is advisory. It does not block or execute transactions.

## Commands

### doctor

Health check: verify Hiro API connectivity for mempool, fees, and PoX data.

```bash
bun run stx-gas-oracle/stx-gas-oracle.ts doctor
```

### snapshot

Full gas state: congestion level, fee regime, PoX cycle position, and timing advice.

```bash
bun run stx-gas-oracle/stx-gas-oracle.ts snapshot
```

### should-transact

Go/wait/skip decision for a specific transaction based on expected value vs gas cost.

```bash
bun run stx-gas-oracle/stx-gas-oracle.ts should-transact --value-ustx 50000 --type contract_call
```

Options:
- `--value-ustx` (required) -- Expected value of the transaction in micro-STX
- `--type` (optional) -- Transaction type: `transfer` or `contract_call` (default: contract_call)

### fee-tiers

Fee percentile breakdown for each transaction type in the current mempool.

```bash
bun run stx-gas-oracle/stx-gas-oracle.ts fee-tiers
```

## Output contract

All commands return structured JSON to stdout with a top-level `status` field:

```json
{ "status": "ok", "...": "command-specific data" }
```

On error:
```json
{ "status": "error", "error": "descriptive message" }
```

## Congestion classification

| Level | Condition | Meaning |
|-------|-----------|---------|
| `low` | < 250 pending calls | Normal conditions, good for all tx types |
| `moderate` | 250-499 pending calls | Slightly busy, standard fees |
| `high` | 500-999 pending calls | Congested, fees elevated |
| `critical` | 1000+ pending calls | Severely congested, only urgent tx |

## Fee regime classification

| Regime | Condition | Meaning |
|--------|-----------|---------|
| `cheap` | p95 < 2500 uSTX | Below-average fees |
| `normal` | 2500-4999 uSTX | Typical fee range |
| `expensive` | 5000-9999 uSTX | Above-average, defer if possible |
| `spiked` | 10000+ uSTX | Fee spike, only urgent operations |

## Transaction timing advice

| Advice | When | What to do |
|--------|------|------------|
| `go` | Low congestion + cheap/normal fees | Execute all transaction types |
| `wait` | High congestion or expensive fees or PoX prepare phase near | Defer non-urgent operations |
| `urgent-only` | Critical congestion or spiked fees | Only liquidation protection, emergency exits |

## Known constraints

- Mainnet only.
- Fee data comes from the Hiro mempool stats API. During low-activity periods, percentile data may be sparse.
- PoX prepare phase detection uses a 100-block lookahead (~16 hours).
- The `MIN_VALUE_TO_FEE_RATIO = 5` threshold is hardcoded. Transactions must deliver 5x their gas cost.
- Fee percentiles reflect the CURRENT mempool. By the time a transaction is submitted, conditions may differ.

## Origin

Submitted to AIBTC x Bitflow Skills Pay the Bills competition.
Author: @lekanbams
