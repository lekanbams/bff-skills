---
name: stx-pox-delegate-agent
skill: stx-pox-delegate
description: "Authorize and revoke PoX-4 stacking delegation on Stacks mainnet with explicit double-confirmation."
---

# Agent Behavior — STX PoX Delegate

## Decision order

1. Run `doctor` first. If Hiro is unreachable or no wallet is present, stop and surface the blocker.
2. Run `status` to determine current delegation state. If a delegation already exists and the user wants to redelegate, the agent must `revoke` first (delegate-stx fails if a delegation already exists).
3. For any delegate target the user has not previously confirmed, present the dry-run preview (skill returns `status: blocked` without `--confirm`) and require explicit user confirmation before re-running with `--confirm`.
4. After broadcast, persist the txid and report the explorer URL. Do not assume success — the on-chain status may be `abort_by_post_condition` or similar even after a successful broadcast.

## Guardrails

- **Never broadcast without `--confirm`.** The skill enforces this; the agent must not socially engineer around it by passing `--confirm` automatically. If the human did not type "confirm," do not pass the flag.
- **Never expose the wallet password in logs, args echo, error messages, or chat history.** Pass `--password` via env var or stdin where possible; never inline-print the option string.
- **Never delegate to an unfamiliar principal without explicit user awareness.** A misdirected delegation lets that principal stack the user's STX in their own reward cycles. If the agent has no record that the user has previously approved this `--delegate-to` address, it must surface the address and require fresh confirmation.
- **Refuse if status shows an existing active delegation** unless the user has explicitly asked to redelegate (in which case the agent runs `revoke` first, waits for confirmation, then runs `delegate`).
- **Refuse to chain broadcasts.** If `delegate` has just broadcast and the next instruction is another write, wait for the prior tx to confirm (or be rejected) before composing the next one. Mempool replacement is not the agent's concern to handle automatically.

## On error

- Log the JSON error payload verbatim to the user.
- Do not retry silently. If the error is a balance-precheck failure, surface the actual balance vs. the requested amount and ask the user to top up or reduce.
- If the broadcast fails with a network error after the wallet has been unlocked, do NOT retry without explicit user confirmation — the tx may have actually been accepted by a different node.

## On success

- Confirm the on-chain result by polling `https://api.hiro.so/extended/v1/tx/<txid>` until `tx_status` is no longer `pending`.
- If `tx_status` is `success`, report the cycle in which delegation becomes effective (next reward cycle boundary).
- If `tx_status` is anything else (`abort_by_post_condition`, `abort_by_response`, `dropped_*`), surface the failure and do not claim success.
- Update any agent state tracking the user's delegation status; future `status` calls should reflect the new on-chain state.
