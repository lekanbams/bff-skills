#!/usr/bin/env bun
/**
 * STX Gas Oracle skill CLI
 *
 * Real-time Stacks network gas intelligence for DeFi agents.
 * Reads mempool congestion, fee percentiles, and PoX cycle state to help
 * agents decide WHEN to transact and WHETHER a transaction's expected
 * value justifies its gas cost.
 *
 * Self-contained: uses Hiro API directly.
 *
 * Usage: bun run stx-gas-oracle/stx-gas-oracle.ts <subcommand>
 */
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HIRO_API = "https://api.mainnet.hiro.so";
const NETWORK = "mainnet";
const FETCH_TIMEOUT_MS = 30_000;
const VERSION = "0.1.0";

// Fee thresholds (hardcoded safety limits)
// 500 pending calls is the inflection point where median wait times jump from 1-2 blocks to 5+.
// Levels: <250 = low, 250-499 = moderate, 500-999 = high, 1000+ = critical (2x multiplier).
const HIGH_CONGESTION_THRESHOLD = 500;
// p95 fee reflects what priority transactions pay. Above 5000 uSTX, the fee distribution
// has a fat tail indicating bidding wars. Regimes: <2500 cheap, 2500-4999 normal, 5000-9999 expensive, 10000+ spiked.
const FEE_SPIKE_THRESHOLD_USTX = 5000;
// 5x ratio ensures gas is a small fraction of expected value. At 1x, half the profit goes to gas.
// At 5x, gas is 20% of value — acceptable for automated DeFi operations.
const MIN_VALUE_TO_FEE_RATIO = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface MempoolStats {
  tx_type_counts: {
    token_transfer: number;
    smart_contract: number;
    contract_call: number;
    poison_microblock: number;
  };
  tx_simple_fee_averages: {
    token_transfer: { p25: number | null; p50: number | null; p75: number | null; p95: number | null };
    contract_call: { p25: number | null; p50: number | null; p75: number | null; p95: number | null };
    [key: string]: { p25: number | null; p50: number | null; p75: number | null; p95: number | null };
  };
  tx_ages: {
    token_transfer: { p25: number | null; p50: number | null; p75: number | null; p95: number | null };
    contract_call: { p25: number | null; p50: number | null; p75: number | null; p95: number | null };
    [key: string]: { p25: number | null; p50: number | null; p75: number | null; p95: number | null };
  };
}

interface PoxInfo {
  contract_id: string;
  current_cycle: {
    id: number;
    min_threshold_ustx: number;
    stacked_ustx: number;
    is_pox_active: boolean;
  };
  next_cycle: {
    id: number;
    min_threshold_ustx: number;
    stacked_ustx: number;
    prepare_phase_start_block_height: number;
    blocks_until_prepare_phase: number;
    reward_phase_start_block_height: number;
    blocks_until_reward_phase: number;
  };
  total_liquid_supply_ustx: number;
  current_burnchain_block_height: number;
}

type CongestionLevel = "low" | "moderate" | "high" | "critical";
type FeeRegime = "cheap" | "normal" | "expensive" | "spiked";
type TransactAdvice = "go" | "wait" | "urgent-only";

interface GasSnapshot {
  network: string;
  congestion: {
    level: CongestionLevel;
    pendingContractCalls: number;
    pendingTransfers: number;
    totalPending: number;
  };
  fees: {
    regime: FeeRegime;
    transferFeeUstx: number;
    contractCall: {
      p25: number;
      p50: number;
      p75: number;
      p95: number;
    };
    medianWaitBlocks: number;
  };
  poxCycle: {
    currentCycleId: number;
    blocksUntilPreparePhase: number;
    blocksUntilRewardPhase: number;
    isPreparePhaseNear: boolean;
  };
  advice: TransactAdvice;
  reason: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function printResult(data: unknown): void {
  console.log(
    JSON.stringify({ status: "ok" as const, ...data as Record<string, unknown> }, null, 2)
  );
}

function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(
    JSON.stringify({ status: "error" as const, error: message }, null, 2)
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText} (${url})`);
  return res.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText} (${url})`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Gas analysis
// ---------------------------------------------------------------------------

function classifyCongestion(pendingCalls: number): CongestionLevel {
  if (pendingCalls >= HIGH_CONGESTION_THRESHOLD * 2) return "critical";
  if (pendingCalls >= HIGH_CONGESTION_THRESHOLD) return "high";
  if (pendingCalls >= HIGH_CONGESTION_THRESHOLD / 2) return "moderate";
  return "low";
}

// p95 captures fee spikes that affect worst-case execution cost.
// p75 (used in should-transact) reflects what a reliably-included tx actually pays.
function classifyFeeRegime(p95Fee: number): FeeRegime {
  if (p95Fee >= FEE_SPIKE_THRESHOLD_USTX * 2) return "spiked";
  if (p95Fee >= FEE_SPIKE_THRESHOLD_USTX) return "expensive";
  if (p95Fee >= FEE_SPIKE_THRESHOLD_USTX / 2) return "normal";
  return "cheap";
}

function computeAdvice(
  congestion: CongestionLevel,
  feeRegime: FeeRegime,
  isPreparePhaseNear: boolean
): { advice: TransactAdvice; reason: string } {
  // PoX prepare phase causes predictable congestion spikes: stackers submit
  // stacking-extend and delegation transactions during the 100-block prepare window,
  // competing for block space with regular DeFi traffic. Defer non-urgent ops.
  if (isPreparePhaseNear && congestion !== "low") {
    return {
      advice: "wait",
      reason: "PoX prepare phase approaching. Network congestion typically spikes during cycle transitions. Defer non-urgent transactions.",
    };
  }

  if (congestion === "critical" || feeRegime === "spiked") {
    return {
      advice: "urgent-only",
      reason: `Network is ${congestion} with ${feeRegime} fees. Only execute time-sensitive transactions (liquidation protection, emergency exits).`,
    };
  }

  if (congestion === "high" || feeRegime === "expensive") {
    return {
      advice: "wait",
      reason: `Congestion is ${congestion}, fees are ${feeRegime}. Standard DeFi operations (LP adds, yield claims) should wait for lower fees.`,
    };
  }

  return {
    advice: "go",
    reason: `Network is ${congestion} with ${feeRegime} fees. Good conditions for all transaction types.`,
  };
}

async function buildGasSnapshot(): Promise<GasSnapshot> {
  const [mempool, transferFee, pox] = await Promise.all([
    fetchJson<MempoolStats>(`${HIRO_API}/extended/v1/tx/mempool/stats`),
    fetchText(`${HIRO_API}/v2/fees/transfer`),
    fetchJson<PoxInfo>(`${HIRO_API}/v2/pox`),
  ]);

  const pendingCalls = mempool.tx_type_counts.contract_call ?? 0;
  const pendingTransfers = mempool.tx_type_counts.token_transfer ?? 0;
  const totalPending = pendingCalls + pendingTransfers + (mempool.tx_type_counts.smart_contract ?? 0);

  const callFees = mempool.tx_simple_fee_averages.contract_call;
  const p25 = callFees?.p25 ?? 0;
  const p50 = callFees?.p50 ?? 0;
  const p75 = callFees?.p75 ?? 0;
  const p95 = callFees?.p95 ?? 0;

  const callAges = mempool.tx_ages.contract_call;
  const medianWaitBlocks = callAges?.p50 ?? 0;

  const congestionLevel = classifyCongestion(pendingCalls);
  const feeRegime = classifyFeeRegime(p95);

  const blocksUntilPrepare = pox.next_cycle?.blocks_until_prepare_phase ?? 999;
  const blocksUntilReward = pox.next_cycle?.blocks_until_reward_phase ?? 999;
  const isPreparePhaseNear = blocksUntilPrepare <= 100; // ~100 blocks ≈ ~16 hours

  const { advice, reason } = computeAdvice(congestionLevel, feeRegime, isPreparePhaseNear);

  return {
    network: NETWORK,
    congestion: {
      level: congestionLevel,
      pendingContractCalls: pendingCalls,
      pendingTransfers,
      totalPending,
    },
    fees: {
      regime: feeRegime,
      transferFeeUstx: parseInt(transferFee, 10) || 0,
      contractCall: { p25, p50, p75, p95 },
      medianWaitBlocks,
    },
    poxCycle: {
      currentCycleId: pox.current_cycle?.id ?? 0,
      blocksUntilPreparePhase: blocksUntilPrepare,
      blocksUntilRewardPhase: blocksUntilReward,
      isPreparePhaseNear,
    },
    advice,
    reason,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("stx-gas-oracle")
  .description(
    "Stacks network gas intelligence: mempool congestion, fee percentiles, PoX cycle " +
    "awareness, and transaction timing advice for DeFi agents. Read-only, no wallet required."
  )
  .version(VERSION);

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
program
  .command("doctor")
  .description("Health check: verify Hiro API connectivity and data availability.")
  .action(async () => {
    try {
      const checks: Record<string, unknown> = {
        network: NETWORK,
        version: VERSION,
        thresholds: {
          highCongestionPendingCalls: HIGH_CONGESTION_THRESHOLD,
          feeSpikeP95Ustx: FEE_SPIKE_THRESHOLD_USTX,
          minValueToFeeRatio: MIN_VALUE_TO_FEE_RATIO,
        },
      };

      try {
        await fetchJson<MempoolStats>(`${HIRO_API}/extended/v1/tx/mempool/stats`);
        checks.mempoolApi = { status: "ok" };
      } catch (e) {
        checks.mempoolApi = { status: "error", error: String(e) };
      }

      try {
        const fee = await fetchText(`${HIRO_API}/v2/fees/transfer`);
        checks.feeApi = { status: "ok", transferFeeUstx: parseInt(fee, 10) };
      } catch (e) {
        checks.feeApi = { status: "error", error: String(e) };
      }

      try {
        const pox = await fetchJson<PoxInfo>(`${HIRO_API}/v2/pox`);
        checks.poxApi = { status: "ok", currentCycle: pox.current_cycle?.id };
      } catch (e) {
        checks.poxApi = { status: "error", error: String(e) };
      }

      const allOk =
        (checks.mempoolApi as Record<string, unknown>).status === "ok" &&
        (checks.feeApi as Record<string, unknown>).status === "ok" &&
        (checks.poxApi as Record<string, unknown>).status === "ok";

      printResult({ ...checks, healthy: allOk, timestamp: new Date().toISOString() });
    } catch (error) {
      printError(error);
    }
  });

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------
program
  .command("snapshot")
  .description(
    "Current gas state: congestion level, fee percentiles, PoX cycle position, " +
    "and transaction timing advice."
  )
  .action(async () => {
    try {
      printResult(await buildGasSnapshot());
    } catch (error) {
      printError(error);
    }
  });

// ---------------------------------------------------------------------------
// should-transact
// ---------------------------------------------------------------------------
program
  .command("should-transact")
  .description(
    "Quick go/wait/urgent-only decision for a transaction with a given expected value."
  )
  .requiredOption("--value-ustx <amount>", "Expected value of the transaction in uSTX")
  .option("--type <type>", "Transaction type: transfer | contract_call", "contract_call")
  .action(async (opts: { valueUstx: string; type: string }) => {
    try {
      const expectedValue = parseInt(opts.valueUstx, 10);
      if (isNaN(expectedValue) || expectedValue <= 0) {
        throw new Error("--value-ustx must be a positive integer");
      }

      const snapshot = await buildGasSnapshot();
      const estimatedFee = opts.type === "transfer"
        ? snapshot.fees.transferFeeUstx
        : snapshot.fees.contractCall.p75; // Use p75 for reliable inclusion

      const valueToFeeRatio = estimatedFee > 0
        ? Number((expectedValue / estimatedFee).toFixed(2))
        : Infinity;

      const worthExecuting = valueToFeeRatio >= MIN_VALUE_TO_FEE_RATIO;

      let decision: string;
      let reasoning: string;

      if (!worthExecuting) {
        decision = "skip";
        reasoning = `Expected value (${expectedValue} uSTX) is only ${valueToFeeRatio}x the estimated fee (${estimatedFee} uSTX). Minimum ratio is ${MIN_VALUE_TO_FEE_RATIO}x. Transaction cost exceeds benefit.`;
      } else if (snapshot.advice === "urgent-only") {
        decision = "wait";
        reasoning = `Value ratio is acceptable (${valueToFeeRatio}x) but network is congested. ${snapshot.reason}`;
      } else if (snapshot.advice === "wait") {
        decision = "wait";
        reasoning = `Value ratio is good (${valueToFeeRatio}x) but conditions are suboptimal. ${snapshot.reason}`;
      } else {
        decision = "go";
        reasoning = `Value ratio is ${valueToFeeRatio}x (above ${MIN_VALUE_TO_FEE_RATIO}x minimum) and network conditions are favorable. ${snapshot.reason}`;
      }

      printResult({
        network: NETWORK,
        transaction: {
          type: opts.type,
          expectedValueUstx: expectedValue,
          estimatedFeeUstx: estimatedFee,
          valueToFeeRatio,
        },
        decision,
        worthExecuting,
        networkAdvice: snapshot.advice,
        reasoning,
        gasSnapshot: {
          congestion: snapshot.congestion.level,
          feeRegime: snapshot.fees.regime,
          p75FeeUstx: snapshot.fees.contractCall.p75,
          poxCycleId: snapshot.poxCycle.currentCycleId,
          isPreparePhaseNear: snapshot.poxCycle.isPreparePhaseNear,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      printError(error);
    }
  });

// ---------------------------------------------------------------------------
// fee-tiers
// ---------------------------------------------------------------------------
program
  .command("fee-tiers")
  .description("Fee percentile breakdown for each transaction type in the current mempool.")
  .action(async () => {
    try {
      const [mempool, transferFeeText] = await Promise.all([
        fetchJson<MempoolStats>(`${HIRO_API}/extended/v1/tx/mempool/stats`),
        fetchText(`${HIRO_API}/v2/fees/transfer`),
      ]);
      const transferFee = parseInt(transferFeeText, 10) || 0;

      const tiers: Record<string, unknown>[] = [];

      for (const [txType, fees] of Object.entries(mempool.tx_simple_fee_averages)) {
        if (fees.p50 === null) continue; // Skip types with no data
        const ages = mempool.tx_ages[txType];
        tiers.push({
          type: txType,
          pending: mempool.tx_type_counts[txType as keyof typeof mempool.tx_type_counts] ?? 0,
          fees: {
            p25: fees.p25 ?? 0,
            p50: fees.p50 ?? 0,
            p75: fees.p75 ?? 0,
            p95: fees.p95 ?? 0,
          },
          medianWaitBlocks: ages?.p50 ?? 0,
        });
      }

      printResult({
        network: NETWORK,
        baseTransferFeeUstx: transferFee,
        tiers,
        note: "p25 = budget (may be slow), p50 = standard, p75 = reliable, p95 = priority. All values in uSTX.",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      printError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
program.parse(process.argv);
