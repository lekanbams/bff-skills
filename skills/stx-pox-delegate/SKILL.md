---
name: stx-pox-delegate
description: "Authorize and revoke PoX-4 stacking delegation on Stacks mainnet — the write companion to read-only stacking monitors."
metadata:
  author: "lekanbams"
  author-agent: "Lekan Bams"
  user-invocable: "true"
  arguments: "doctor | status | delegate --delegate-to <addr> --amount-stx <n> [--until-burn-ht <h>] [--confirm] | revoke [--confirm]"
  entry: "stx-pox-delegate/stx-pox-delegate.ts"
  requires: "wallet, signing, settings"
  tags: "l2, write, mainnet-only, requires-funds, infrastructure"
---

# STX PoX Delegate

## What it does

Broadcasts `delegate-stx` and `revoke-delegate-stx` calls to the canonical Stacks PoX-4 contract (`SP000000000000000000002Q6VF78.pox-4`). This is the write side of stacking delegation: solo stacking requires 80k+ STX, so most STX holders earn PoX yield by delegating to a stacking pool. This skill performs that authorization on-chain.

This is the write companion to the read-only `stacking-delegation` skill in this registry — that one monitors, this one acts.

## Why agents need it

An autonomous yield agent on Stacks needs a programmatic way to opt into PoX-4 stacking via a pool. Without this, every delegation step requires a human wallet popup. With it, the agent can: check current delegation, decide whether to (re)delegate based on signals from monitors like `stacking-delegation` or `hodlmm-risk`, and broadcast the authorization with explicit safety gates.

## Safety notes

- **Mainnet write.** Calls a public PoX-4 function. Real STX gas is spent (~0.001 STX per tx).
- **Funds stay in your wallet.** `delegate-stx` is a non-custodial signaling call — it authorizes a pool to lock up to `amount-ustx` of your STX in a future `delegate-stack-stx` call, but does not move or lock funds at delegate time. The agent that runs the actual stacking is the principal you pass via `--delegate-to`. Choose pools you trust.
- **Double-confirmation required.** `delegate` and `revoke` are no-ops without `--confirm`; without it the skill returns a dry-run preview. This is intentional — accidental delegation to a malicious principal would let that principal stack your STX without further consent.
- **Post-conditions.** `delegate-stx` is a no-asset Clarity call (it touches no fungible balances at signing time), so the broadcast uses `PostConditionMode.Deny` with an empty `postConditions` array. This is correct for this specific call shape — there is nothing to constrain — and is documented here to preempt the standard reviewer flag against empty-deny on swaps.
- **Refusal conditions.** The skill refuses if: amount < 1 STX (micro-amount), amount > 95% of wallet balance (no gas left), `--until-burn-ht` is in the past or within 10 burn blocks, `--delegate-to` parses as something other than a Stacks principal, or wallet balance is below 0.01 STX (insufficient gas).
- **No fabricated identifiers.** The pox-4 contract address is the canonical Stacks built-in (`SP000000000000000000002Q6VF78.pox-4`); the function signature is verified against `https://api.hiro.so/v2/contracts/interface/SP000000000000000000002Q6VF78/pox-4`.

## Commands

| Command | Description |
|---------|-------------|
| `doctor` | Hiro API health, wallet presence, current PoX cycle. No password needed. |
| `status` | Read-only `get-delegation-info` for the active wallet. No password needed. |
| `delegate` | **Write.** Calls `pox-4.delegate-stx`. Requires `--delegate-to`, `--amount-stx`, `--password`, `--confirm`. |
| `revoke` | **Write.** Calls `pox-4.revoke-delegate-stx`. Requires `--password`, `--confirm`. |

```bash
# Preflight
bun run skills/stx-pox-delegate/stx-pox-delegate.ts doctor
bun run skills/stx-pox-delegate/stx-pox-delegate.ts status

# Dry-run preview (no broadcast)
bun run skills/stx-pox-delegate/stx-pox-delegate.ts delegate \
  --delegate-to SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP \
  --amount-stx 1 \
  --password "$WALLET_PASSWORD"

# Real broadcast
bun run skills/stx-pox-delegate/stx-pox-delegate.ts delegate \
  --delegate-to SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP \
  --amount-stx 1 \
  --password "$WALLET_PASSWORD" \
  --confirm

# Revoke active delegation
bun run skills/stx-pox-delegate/stx-pox-delegate.ts revoke \
  --password "$WALLET_PASSWORD" \
  --confirm
```

## Output contract

All outputs are JSON to stdout. Errors go to stderr.

**Success:**
```json
{
  "status": "success",
  "action": "delegate",
  "data": {
    "txid": "0x...",
    "explorer": "https://explorer.hiro.so/txid/0x...?chain=mainnet",
    "sender": "SP...",
    "delegateTo": "SP...",
    "amountUstx": "1000000",
    "untilBurnHt": null
  },
  "error": null
}
```

**Dry-run (no `--confirm`):**
```json
{
  "status": "blocked",
  "action": "delegate",
  "data": { "preview": { ... }, "next": "rerun with --confirm to broadcast" },
  "error": null
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints

- **Mainnet only.** PoX-4 testnet uses a different deployer; this skill targets mainnet `SP000000000000000000002Q6VF78.pox-4`.
- **Wallet must be the AIBTC MCP wallet** at `~/.aibtc/wallets/<id>/keystore.json` (AES-256-GCM + scrypt format), or `STACKS_PRIVATE_KEY` env var for automation.
- **No `--pox-addr` parameter exposed.** The optional BTC reward address is a power-user feature most pools set themselves; surfacing it here would let an agent send rewards to an arbitrary BTC address, which is a footgun. Add via a follow-up if a pool requires it.
- **No `delegate-stack-stx`.** That call is what pools execute against your delegation; it is not what an end-user delegator broadcasts. This skill covers the delegator side only.
