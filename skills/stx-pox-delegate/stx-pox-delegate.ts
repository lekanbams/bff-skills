#!/usr/bin/env bun
/**
 * stx-pox-delegate — Authorize and revoke PoX-4 stacking delegation on Stacks mainnet.
 *
 * Wraps the canonical pox-4 functions:
 *   - delegate-stx(amount-ustx, delegate-to, until-burn-ht?, pox-addr?)
 *   - revoke-delegate-stx()
 *
 * Contract: SP000000000000000000002Q6VF78.pox-4
 * Verified against: https://api.hiro.so/v2/contracts/interface/SP000000000000000000002Q6VF78/pox-4
 *
 * Usage: bun run skills/stx-pox-delegate/stx-pox-delegate.ts <command> [options]
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

const POX_DEPLOYER = "SP000000000000000000002Q6VF78";
const POX_CONTRACT = "pox-4";
const STACKS_API = "https://api.hiro.so";
const EXPLORER_BASE = "https://explorer.hiro.so/txid";
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");

const MIN_DELEGATE_USTX = 1_000_000n;        // 1 STX
const MIN_GAS_BALANCE_USTX = 10_000n;        // 0.01 STX
const MAX_PCT_OF_BALANCE = 95n;              // never let amount > 95% of balance
const DEFAULT_FEE_USTX = 1000n;              // 0.001 STX — pox-4 calls are cheap
const FETCH_TIMEOUT_MS = 10_000;
const MIN_BURN_HT_LEAD = 10n;                // refuse until-burn-ht < current+10

// ─── Types & output helpers ───────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

function out(o: SkillOutput): void {
  process.stdout.write(JSON.stringify(o, null, 2) + "\n");
}

function flatErr(message: string): never {
  process.stdout.write(JSON.stringify({ error: message }) + "\n");
  process.exit(1);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wallet helpers (mirrors the dca skill convention) ────────────────────────

async function decryptAibtcKeystore(enc: any, password: string): Promise<string> {
  const { scryptSync, createDecipheriv } = await import("crypto" as any);
  const { N, r, p, keyLen } = enc.scryptParams;
  const salt = Buffer.from(enc.salt, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key = scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8").trim();
}

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } = await import("@stacks/transactions" as any);
    const key = process.env.STACKS_PRIVATE_KEY;
    return { stxPrivateKey: key, stxAddress: getAddressFromPrivateKey(key, TransactionVersion.Mainnet) };
  }

  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as any);

  if (fs.existsSync(WALLETS_FILE)) {
    const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
    const activeWallet = (walletsJson.wallets ?? [])[0];
    if (activeWallet?.id) {
      const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
      if (fs.existsSync(keystorePath)) {
        const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
        const enc = keystore.encrypted;
        if (enc?.ciphertext) {
          const mnemonic = await decryptAibtcKeystore(enc, password);
          const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
        }
      }
    }
  }

  throw new Error(
    "No wallet found or decryption failed. " +
    "Run: npx @aibtc/mcp-server@latest --install, or set STACKS_PRIVATE_KEY."
  );
}

function walletExists(): boolean {
  return fs.existsSync(WALLETS_FILE) && (JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8")).wallets ?? []).length > 0;
}

function getActiveWalletAddress(): string | null {
  if (!walletExists()) return null;
  const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
  return walletsJson.wallets[0]?.stxAddress ?? walletsJson.wallets[0]?.address ?? null;
}

// ─── Chain helpers ────────────────────────────────────────────────────────────

async function getStxBalanceUstx(address: string): Promise<bigint> {
  const data = await fetchJson<{ balance: string }>(`${STACKS_API}/v2/accounts/${address}?proof=0`);
  return BigInt(data.balance);
}

async function getCurrentBurnHeight(): Promise<bigint> {
  const data = await fetchJson<{ burn_block_height: number }>(`${STACKS_API}/v2/info`);
  return BigInt(data.burn_block_height);
}

async function getPoxInfo(): Promise<{ current_cycle: { id: number }; reward_cycle_length: number }> {
  return fetchJson(`${STACKS_API}/v2/pox`);
}

async function getDelegationInfo(stxAddress: string): Promise<unknown> {
  // Read-only contract call: pox-4.get-delegation-info(user principal)
  const { cvToValue, hexToCV, principalCV, serializeCV } = await import("@stacks/transactions" as any);
  // serializeCV in @stacks/transactions v7 returns a hex string directly.
  const argHex = "0x" + serializeCV(principalCV(stxAddress));
  const body = JSON.stringify({ sender: stxAddress, arguments: [argHex] });
  const res = await fetch(
    `${STACKS_API}/v2/contracts/call-read/${POX_DEPLOYER}/${POX_CONTRACT}/get-delegation-info`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`call-read get-delegation-info → HTTP ${res.status}`);
  const j = (await res.json()) as { okay: boolean; result: string };
  if (!j.okay) throw new Error("call-read returned not-okay");
  return cvToValue(hexToCV(j.result), true);
}

function isStacksPrincipal(s: string): boolean {
  // SP/SM (mainnet standard/contract) — 28-41 alphanumeric chars after the prefix
  return /^S[PM][A-Z0-9]{38,40}(\.[a-z0-9-]+)?$/.test(s);
}

// ─── Commander setup ──────────────────────────────────────────────────────────

const program = new Command();
program
  .name("stx-pox-delegate")
  .description("Authorize and revoke PoX-4 stacking delegation on Stacks mainnet");

// ─── doctor ───────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check Hiro API health, wallet presence, and current PoX cycle")
  .action(async () => {
    try {
      const [pox, info] = await Promise.all([getPoxInfo(), fetchJson<{ stacks_tip_height: number; burn_block_height: number }>(`${STACKS_API}/v2/info`)]);
      const wallet = walletExists() ? getActiveWalletAddress() : null;
      out({
        status: "success",
        action: "doctor",
        data: {
          hiro: "healthy",
          current_pox_cycle: pox.current_cycle?.id,
          burn_block_height: info.burn_block_height,
          stacks_tip: info.stacks_tip_height,
          wallet_present: walletExists(),
          wallet_address: wallet,
          pox_contract: `${POX_DEPLOYER}.${POX_CONTRACT}`,
        },
        error: null,
      });
    } catch (e: any) {
      out({ status: "error", action: "doctor", data: {}, error: { code: "DOCTOR_FAIL", message: e.message, next: "Check network and ~/.aibtc/wallets.json" } });
      process.exit(1);
    }
  });

// ─── status ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Read on-chain delegation state for the active wallet")
  .option("--stx-address <addr>", "Override address to inspect (defaults to active wallet)")
  .action(async (opts: { stxAddress?: string }) => {
    try {
      const address = opts.stxAddress ?? getActiveWalletAddress();
      if (!address) flatErr("No address — pass --stx-address or install AIBTC wallet.");
      if (!isStacksPrincipal(address!)) flatErr(`Invalid Stacks address: ${address}`);
      const [delegation, balance] = await Promise.all([
        getDelegationInfo(address!),
        getStxBalanceUstx(address!),
      ]);
      out({
        status: "success",
        action: "status",
        data: {
          address,
          balance_ustx: balance.toString(),
          balance_stx: (Number(balance) / 1_000_000).toFixed(6),
          delegation: delegation,
        },
        error: null,
      });
    } catch (e: any) {
      flatErr(e.message);
    }
  });

// ─── delegate (write) ─────────────────────────────────────────────────────────

program
  .command("delegate")
  .description("Broadcast pox-4.delegate-stx (requires --confirm)")
  .requiredOption("--delegate-to <addr>", "Principal authorized to stack on your behalf (a pool, or your own address for testing)")
  .requiredOption("--amount-stx <n>", "Amount of STX to authorize (whole STX, e.g. 1.5)")
  .option("--until-burn-ht <h>", "Optional Bitcoin burn height after which delegation expires", "")
  .option("--password <pw>", "AIBTC wallet password (omit to read STACKS_PRIVATE_KEY env)")
  .option("--confirm", "Actually broadcast. Without this flag the skill returns a dry-run preview.", false)
  .action(async (opts: { delegateTo: string; amountStx: string; untilBurnHt: string; password: string; confirm: boolean }) => {
    try {
      // ── validation ──
      if (!isStacksPrincipal(opts.delegateTo)) flatErr(`--delegate-to is not a valid Stacks principal: ${opts.delegateTo}`);

      const amountFloat = Number(opts.amountStx);
      if (!isFinite(amountFloat) || amountFloat <= 0) flatErr(`--amount-stx must be a positive number, got: ${opts.amountStx}`);
      const amountUstx = BigInt(Math.round(amountFloat * 1_000_000));
      if (amountUstx < MIN_DELEGATE_USTX) flatErr(`--amount-stx too small (min 1 STX). Got ${amountFloat}.`);

      // burn-ht validation
      let untilBurnHt: bigint | null = null;
      if (opts.untilBurnHt && opts.untilBurnHt !== "") {
        const h = BigInt(opts.untilBurnHt);
        const current = await getCurrentBurnHeight();
        if (h <= current + MIN_BURN_HT_LEAD) flatErr(`--until-burn-ht ${h} is in the past or too soon (current burn height ${current}).`);
        untilBurnHt = h;
      }

      // ── build tx (preview always, broadcast only on confirm) ──
      const stx = await import("@stacks/transactions" as any);
      const { STACKS_MAINNET } = await import("@stacks/network" as any);
      const network = STACKS_MAINNET;

      const functionArgs = [
        stx.uintCV(amountUstx),
        stx.principalCV(opts.delegateTo),
        untilBurnHt === null ? stx.noneCV() : stx.someCV(stx.uintCV(untilBurnHt)),
        stx.noneCV(), // pox-addr — intentionally not exposed (see SKILL.md "Known constraints")
      ];

      const preview = {
        contract: `${POX_DEPLOYER}.${POX_CONTRACT}`,
        function: "delegate-stx",
        amount_ustx: amountUstx.toString(),
        amount_stx: amountFloat,
        delegate_to: opts.delegateTo,
        until_burn_ht: untilBurnHt?.toString() ?? null,
        pox_addr: null,
        fee_ustx: DEFAULT_FEE_USTX.toString(),
      };

      if (!opts.confirm) {
        out({
          status: "blocked",
          action: "delegate",
          data: { preview, next: "rerun with --confirm to broadcast" },
          error: null,
        });
        return;
      }

      // ── broadcast path ──
      if (!opts.password && !process.env.STACKS_PRIVATE_KEY) flatErr("--password is required (or set STACKS_PRIVATE_KEY env).");
      const { stxPrivateKey, stxAddress } = await getWalletKeys(opts.password);

      // ── balance precheck ──
      const balance = await getStxBalanceUstx(stxAddress);
      if (balance < MIN_GAS_BALANCE_USTX + DEFAULT_FEE_USTX) flatErr(`Insufficient gas: balance ${balance} ustx < min ${MIN_GAS_BALANCE_USTX + DEFAULT_FEE_USTX}`);
      if (amountUstx * 100n > balance * MAX_PCT_OF_BALANCE) {
        flatErr(`--amount-stx ${amountFloat} exceeds 95% of wallet balance (${(Number(balance) / 1_000_000).toFixed(6)} STX). Reduce amount or top up.`);
      }

      const tx = await stx.makeContractCall({
        contractAddress: POX_DEPLOYER,
        contractName: POX_CONTRACT,
        functionName: "delegate-stx",
        functionArgs,
        // delegate-stx is a no-asset Clarity call — it touches no fungible balances at signing.
        // PostConditionMode.Deny with empty postConditions is correct for this specific call shape.
        postConditionMode: stx.PostConditionMode.Deny,
        postConditions: [],
        network,
        senderKey: stxPrivateKey,
        anchorMode: stx.AnchorMode.Any,
        fee: DEFAULT_FEE_USTX,
      });

      const broadcastRes = await stx.broadcastTransaction({ transaction: tx, network });
      if (broadcastRes.error) {
        flatErr(`Broadcast failed: ${broadcastRes.error} — ${broadcastRes.reason ?? ""}`);
      }
      const txid = broadcastRes.txid as string;
      out({
        status: "success",
        action: "delegate",
        data: {
          txid,
          explorer: `${EXPLORER_BASE}/${txid}?chain=mainnet`,
          sender: stxAddress,
          delegate_to: opts.delegateTo,
          amount_ustx: amountUstx.toString(),
          until_burn_ht: untilBurnHt?.toString() ?? null,
        },
        error: null,
      });
    } catch (e: any) {
      flatErr(e.message ?? String(e));
    }
  });

// ─── revoke (write) ───────────────────────────────────────────────────────────

program
  .command("revoke")
  .description("Broadcast pox-4.revoke-delegate-stx (requires --confirm)")
  .option("--password <pw>", "AIBTC wallet password (omit to read STACKS_PRIVATE_KEY env)")
  .option("--confirm", "Actually broadcast.", false)
  .action(async (opts: { password: string; confirm: boolean }) => {
    try {
      const preview = {
        contract: `${POX_DEPLOYER}.${POX_CONTRACT}`,
        function: "revoke-delegate-stx",
        fee_ustx: DEFAULT_FEE_USTX.toString(),
      };
      if (!opts.confirm) {
        out({ status: "blocked", action: "revoke", data: { preview, next: "rerun with --confirm to broadcast" }, error: null });
        return;
      }
      if (!opts.password && !process.env.STACKS_PRIVATE_KEY) flatErr("--password is required (or set STACKS_PRIVATE_KEY env).");

      const stx = await import("@stacks/transactions" as any);
      const { STACKS_MAINNET } = await import("@stacks/network" as any);
      const { stxPrivateKey, stxAddress } = await getWalletKeys(opts.password);

      const balance = await getStxBalanceUstx(stxAddress);
      if (balance < MIN_GAS_BALANCE_USTX + DEFAULT_FEE_USTX) flatErr(`Insufficient gas: balance ${balance} ustx`);

      const tx = await stx.makeContractCall({
        contractAddress: POX_DEPLOYER,
        contractName: POX_CONTRACT,
        functionName: "revoke-delegate-stx",
        functionArgs: [],
        postConditionMode: stx.PostConditionMode.Deny,
        postConditions: [],
        network: STACKS_MAINNET,
        senderKey: stxPrivateKey,
        anchorMode: stx.AnchorMode.Any,
        fee: DEFAULT_FEE_USTX,
      });
      const broadcastRes = await stx.broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
      if (broadcastRes.error) flatErr(`Broadcast failed: ${broadcastRes.error} — ${broadcastRes.reason ?? ""}`);
      const txid = broadcastRes.txid as string;
      out({
        status: "success",
        action: "revoke",
        data: { txid, explorer: `${EXPLORER_BASE}/${txid}?chain=mainnet`, sender: stxAddress },
        error: null,
      });
    } catch (e: any) {
      flatErr(e.message ?? String(e));
    }
  });

program.parseAsync().catch((e) => flatErr(e.message ?? String(e)));
