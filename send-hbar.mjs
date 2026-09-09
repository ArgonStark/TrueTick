#!/usr/bin/env node
/**
 * Hedera testnet EVM risk-check.
 *
 * Question this answers: can a plain ethers.js Wallet (private key only) sign
 * and broadcast a value transfer through Hedera's EVM JSON-RPC relay?
 *
 * Run:  node send-hbar.mjs
 */
import { ethers } from "ethers";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- config ---
const CHAIN_ID = 296;                                   // Hedera testnet
const DEFAULT_RPC = "https://testnet.hashio.io/api";    // Hashio public relay
const MIRROR_NODE = "https://testnet.mirrornode.hedera.com/api/v1";
const HASHSCAN = "https://hashscan.io/testnet";

// Hedera's ledger stores HBAR in tinybars (8 dp). The relay presents balances
// and values in weibar (18 dp) so ethers' formatEther/parseEther work as-is.
// 1 tinybar = 1e10 weibar, and that is the real granularity: any value that is
// not a whole multiple of 1e10 weibar cannot be represented on the ledger.
const WEIBAR_PER_TINYBAR = 10n ** 10n;

// The big one. Sending to an address that has no Hedera account yet lazily
// creates a "hollow" account, and that is charged as gas on this transfer.
// Measured on testnet: ~22,800 gas to an existing account, ~660,300 to a brand
// new address. A hardcoded 21000 limit -- the Ethereum reflex -- fails here.
// HIP-1249 refunds unused gas in full, so overshooting costs nothing; you only
// need the balance to cover gasLimit * gasPrice as an in-flight reserve.
const GAS_FLOOR_NEW_ACCOUNT = 1_000_000n;
const GAS_FLOOR_EXISTING = 100_000n;

// -------------------------------------------------------------- helpers ---
function fail(...lines) {
  console.error("\n  x " + lines.join("\n    ") + "\n");
  process.exit(1);
}

const hbar = (weibar) => `${ethers.formatEther(weibar)} HBAR`;

/** Best-effort: does this EVM address already map to a Hedera account? */
async function accountExists(address) {
  try {
    const res = await fetch(`${MIRROR_NODE}/accounts/${address}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return false;
    if (!res.ok) return null;                        // unknown, don't guess
    return true;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- env ---
// Node 20.6+ reads .env natively -- no dotenv dependency. Missing file is fine
// if the variables are already exported in the shell.
try {
  process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)));
} catch { /* fall through to the check below */ }

const RPC_URL = process.env.HEDERA_RPC_URL || DEFAULT_RPC;
const AMOUNT_HBAR = process.env.TRANSFER_HBAR || "0.01";

let pk = (process.env.OPERATOR_PRIVATE_KEY || "").trim();
if (!pk) {
  fail(
    "OPERATOR_PRIVATE_KEY is not set.",
    "Put it in a .env file next to this script (see the setup notes)."
  );
}
if (!pk.startsWith("0x")) pk = "0x" + pk;            // the portal shows it bare
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  fail(
    "OPERATOR_PRIVATE_KEY is not a 32-byte hex key.",
    "Use the ECDSA *hex-encoded* private key. The 96-char DER form (starts",
    "3030...) is wrapped -- take its trailing 64 chars. ED25519 keys cannot",
    "sign EVM transactions at all."
  );
}

// ------------------------------------------------------------------ main ---
console.log(`\n  Hedera testnet EVM check`);
console.log(`  relay:    ${RPC_URL}`);

// staticNetwork stops ethers re-probing eth_chainId before every call, which
// halves the request count against a rate-limited public relay. batchMaxCount:1
// disables request batching: Hashio does accept batches, but one call per
// request keeps a 429 or a relay error attributable to the call that caused it.
const provider = new ethers.JsonRpcProvider(
  RPC_URL,
  new ethers.Network("hedera-testnet", CHAIN_ID),
  { staticNetwork: true, batchMaxCount: 1, pollingInterval: 3000 }
);

const net = await provider.getNetwork().catch((e) =>
  fail(`Cannot reach the relay: ${e.shortMessage || e.message}`)
);
if (net.chainId !== BigInt(CHAIN_ID)) {
  fail(`Relay reports chainId ${net.chainId}, expected ${CHAIN_ID}.`);
}
console.log(`  chainId:  ${net.chainId} ok`);

const wallet = new ethers.Wallet(pk, provider);
const balance = await provider.getBalance(wallet.address);

console.log(`\n  from:     ${wallet.address}`);
console.log(`  balance:  ${hbar(balance)}  (${balance / WEIBAR_PER_TINYBAR} tinybars)`);

if (balance === 0n) {
  fail(
    "Balance is zero at this EVM address.",
    "Either the account is unfunded, or the key does not match the funded",
    `account. Cross-check at ${HASHSCAN}/account/${wallet.address}`
  );
}

// --- recipient -------------------------------------------------------------
let to = (process.env.RECIPIENT_ADDRESS || "").trim();
if (to) {
  if (!ethers.isAddress(to)) fail(`RECIPIENT_ADDRESS is not a valid address: ${to}`);
  to = ethers.getAddress(to);
} else {
  // Address only. The key is deliberately never held or printed -- this
  // recipient exists to exercise the lazy-create path, not to be spent from.
  to = ethers.Wallet.createRandom().address;
  console.log(`\n  recipient: ${to}`);
  console.log(`             (generated throwaway -- no RECIPIENT_ADDRESS set)`);
}

// --- value -----------------------------------------------------------------
const value = ethers.parseEther(AMOUNT_HBAR);
if (value % WEIBAR_PER_TINYBAR !== 0n) {
  fail(
    `${AMOUNT_HBAR} HBAR is finer than one tinybar (8 decimal places).`,
    "Hedera cannot represent it. Use at most 8 decimals."
  );
}

// --- gas -------------------------------------------------------------------
const exists = await accountExists(to);
const gasFloor = exists === true ? GAS_FLOOR_EXISTING : GAS_FLOOR_NEW_ACCOUNT;
if (exists === false) {
  console.log(`\n  Recipient has no Hedera account yet -- this transfer will`);
  console.log(`  lazy-create a hollow account, costing well above 21000 gas.`);
}

let estimated;
try {
  estimated = await provider.estimateGas({ from: wallet.address, to, value });
} catch (e) {
  console.log(`  (eth_estimateGas failed: ${e.shortMessage || e.message} -- using floor)`);
  estimated = 21_000n;
}
const gasLimit = estimated * 2n > gasFloor ? estimated * 2n : gasFloor;

// Hedera has no priority-fee auction -- the relay returns 0 for
// eth_maxPriorityFeePerGas and a flat network gas price. Type-2 txs do work,
// but a legacy (type 0) tx with an explicit gasPrice keeps the fee we sign
// exactly the fee we computed, with nothing inferred by ethers in between.
const { gasPrice } = await provider.getFeeData();
if (!gasPrice) fail("Relay returned no gasPrice.");
const bidGasPrice = (gasPrice * 120n) / 100n;        // headroom for a mid-flight bump

const reserve = gasLimit * bidGasPrice;
console.log(`\n  amount:   ${hbar(value)}`);
console.log(`  gas:      estimate ${estimated} -> limit ${gasLimit} @ ${ethers.formatUnits(bidGasPrice, "gwei")} gwei`);
console.log(`  reserve:  up to ${hbar(reserve)} held for gas (unused gas is refunded)`);

if (balance < value + reserve) {
  fail(
    `Balance ${hbar(balance)} is below amount + gas reserve ${hbar(value + reserve)}.`,
    "Top up at https://portal.hedera.com/faucet"
  );
}

// --- send ------------------------------------------------------------------
console.log(`\n  signing and broadcasting...`);
const tx = await wallet.sendTransaction({
  to,
  value,
  gasLimit,
  gasPrice: bidGasPrice,
  type: 0,
  chainId: CHAIN_ID,
});

console.log(`\n  tx hash:  ${tx.hash}`);
console.log(`            ${HASHSCAN}/tx/${tx.hash}`);

// The relay confirms by polling the mirror node, so the receipt lags the hash
// by a couple of seconds. The hash above is already valid either way -- a
// receipt timeout is not a failed transaction.
try {
  const receipt = await tx.wait(1, 60_000);
  console.log(`\n  status:   ${receipt.status === 1 ? "SUCCESS" : "FAILED"}`);
  console.log(`  block:    ${receipt.blockNumber}`);
  console.log(`  gas used: ${receipt.gasUsed} of ${gasLimit}`);
  console.log(`  fee paid: ${hbar(receipt.gasUsed * receipt.gasPrice)}`);
  console.log(`\n  from:     ${hbar(await provider.getBalance(wallet.address))}`);
  console.log(`  to:       ${hbar(await provider.getBalance(to))}`);
} catch (e) {
  console.log(`\n  status:   INCONCLUSIVE -- no receipt within 60s`);
  console.log(`            (${e.shortMessage || e.message})`);
  console.log(`  This is NOT a failure. The transaction was broadcast and may`);
  console.log(`  well have succeeded. Confirm the hash above on HashScan.`);
}

console.log("");
