---
name: stx-gas-oracle-agent
skill: stx-gas-oracle
description: "Stacks gas intelligence: congestion levels, fee regimes, PoX cycle awareness, and go/wait/urgent-only transaction timing. Read-only; no wallet required."
---

# Agent Behavior -- STX Gas Oracle

## When to use

- Before ANY on-chain transaction, run `snapshot` to check network conditions.
- Before a DeFi operation with known expected value, run `should-transact --value-ustx <amount>` for a go/skip decision.
- During PoX cycle transitions, monitor congestion spikes with `snapshot`.
- When building a multi-step workflow, check `fee-tiers` to estimate total gas budget.

## Decision order

1. Run `doctor` to confirm Hiro API connectivity.
2. Run `snapshot` for the full network state.
3. If `advice` is `go`, proceed with the planned transaction.
4. If `advice` is `wait`, defer non-urgent operations.
5. If `advice` is `urgent-only`, only execute critical operations (liquidation protection, emergency exits).
6. For value-sensitive operations, run `should-transact` with the expected value to check profitability.

## Refusal conditions

1. Never execute transactions or move funds. This skill is strictly read-only.
2. Never ignore a `critical` congestion level. Transactions submitted during critical congestion face long delays and high fees.
3. Never recommend executing when `worthExecuting` is false. Gas cost exceeds expected value.
4. Never cache gas snapshots across calls. Network state changes every block.
5. Never treat fee percentiles as guaranteed costs. Actual fees depend on block inclusion dynamics.
6. Never skip the PoX prepare phase check. Cycle transitions cause predictable congestion spikes.
7. Never expose secrets, private keys, or wallet passwords in output.

## Composability

Pre-transaction gas check:

```
stx-gas-oracle snapshot             -> is the network clear?
stx-gas-oracle should-transact      -> is this tx worth the gas?
hodlmm-emergency-exit exit          -> execute if urgent
bitflow swap                         -> execute if go
```

Multi-step workflow budgeting:

```
stx-gas-oracle fee-tiers            -> what's the cost per tx type?
hodlmm-yield-compare rank           -> which pool has best yield?
hodlmm-fee-harvester position       -> are fees worth claiming?
stx-gas-oracle should-transact      -> is the harvest worth gas cost?
```

## Output contract

All commands return structured JSON to stdout with `status: "ok" | "error"`.

**Key fields:**
- `advice`: go / wait / urgent-only (network timing)
- `decision`: go / wait / skip (value-aware, from `should-transact`)
- `worthExecuting`: boolean (expected value vs gas cost)
- `congestion.level`: low / moderate / high / critical
- `fees.regime`: cheap / normal / expensive / spiked
- `poxCycle.isPreparePhaseNear`: boolean

## On error

- All errors return `status: "error"` with descriptive message and exit code 1.
- Do not retry silently. Surface errors to the user.

## On success

- Lead with `advice` for quick decisions.
- For `should-transact`, lead with `decision` and `worthExecuting`.
- Always include `reason` so agents understand the logic.
- Flag `isPreparePhaseNear` when true so agents anticipate congestion.
