#!/usr/bin/env node
/**
 * x402 paying client for the Hedera testnet service in x402-server.mjs.
 *
 * Shows the full loop: unpaid request -> 402 challenge -> pay -> real data.
 * Payment is a native Hedera TransferTransaction settled by Blocky402, so the
 * receipt is a Hedera transaction id (0.0.x@sec.nanos), not an EVM 0x hash.
 *
 * Run:  node x402-client.mjs      (with x402-server.mjs already running)
 */
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";

try {
  process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)));
} catch { /* env may already be exported */ }

const NETWORK = "hedera:testnet";
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
const HASHSCAN = "https://hashscan.io/testnet";

const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL || "https://api.testnet.blocky402.com";

/**
 * Hard requirement guard.
 *
 * The Hedera "AI & Agentic Payments" track requires settlement through the
 * Blocky402 facilitator SPECIFICALLY, not any conformant x402 facilitator.
 *
 * This is easy to break by accident: the official Hedera PoC
 * (hedera-dev/x402-inference-pay-per-request-poc) points testnet at
 * https://x402.org/facilitator and uses Blocky402 only on mainnet. Anyone
 * "aligning" this project with that repo -- a teammate, a future me, or a
 * coding assistant told to "match the reference implementation" -- would
 * produce a build where every test still passes, payments still settle, and
 * the track requirement is silently failed. There is no runtime symptom.
 *
 * So: fail loudly instead of paying through the wrong facilitator. Hostname
 * match, not substring -- `https://evil.test/?x=blocky402.com` contains the
 * string but is not Blocky402.
 */
function assertBlocky402(url) {
  let host;
  try {
    host = new globalThis.URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`X402_FACILITATOR_URL is not a valid URL: ${url}`);
  }
  if (host !== "blocky402.com" && !host.endsWith(".blocky402.com")) {
    throw new Error(
      `\n\n  FACILITATOR REQUIREMENT VIOLATED\n` +
        `  Resolved facilitator : ${url}  (host: ${host})\n` +
        `  Required             : *.blocky402.com\n\n` +
        `  The Hedera AI & Agentic Payments track mandates the Blocky402\n` +
        `  facilitator. x402.org/facilitator is a conformant x402 facilitator\n` +
        `  and everything would appear to work -- but it does NOT satisfy the\n` +
        `  track requirement. Do not "fix" this by relaxing the check.\n`
    );
  }
  return url;
}

assertBlocky402(FACILITATOR_URL);

/**
 * The URL check above only guards THIS file's config. The facilitator that
 * actually settles is chosen by the SERVER, which the client does not control.
 *
 * The 402 challenge advertises `extra.feePayer` -- the account that co-signs
 * and submits the transfer, i.e. the facilitator itself. Comparing it against
 * the signers Blocky402 publishes at /supported proves the server really is
 * settling through Blocky402, and does so BEFORE any HBAR is spent. A server
 * pointed at x402.org would advertise a different feePayer and be caught here.
 */
async function assertChallengeSettlesViaBlocky402(feePayer) {
  if (!feePayer) {
    throw new Error(
      "402 challenge advertised no feePayer -- cannot confirm Blocky402 settlement."
    );
  }
  const res = await fetch(`${FACILITATOR_URL}/supported`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`Blocky402 /supported returned HTTP ${res.status}.`);
  }
  const body = await res.json();
  const kind = (body.kinds || []).find(
    (k) => k.network === NETWORK && k.scheme === "exact"
  );
  const expected = kind?.extra?.feePayer;
  const signers = body.signers?.["hedera:*"] || [];
  const accepted = new Set([expected, ...signers].filter(Boolean));

  if (!accepted.has(feePayer)) {
    throw new Error(
      `\n\n  FACILITATOR MISMATCH\n` +
        `  Server's 402 advertises feePayer : ${feePayer}\n` +
        `  Blocky402 publishes              : ${[...accepted].join(", ") || "(none)"}\n\n` +
        `  The service is settling through a DIFFERENT facilitator. Payment\n` +
        `  aborted before spending. Point the server at Blocky402.\n`
    );
  }
  return feePayer;
}
const URL_UNDER_TEST =
  process.env.X402_SERVICE_URL || `http://localhost:${process.env.X402_PORT || 4021}/price`;

function fail(...lines) {
  console.error("\n  x " + lines.join("\n    ") + "\n");
  process.exit(1);
}

// --- key ------------------------------------------------------------------
let pk = (process.env.OPERATOR_PRIVATE_KEY || "").trim();
if (!pk) fail("OPERATOR_PRIVATE_KEY is not set (same key send-hbar.mjs uses).");
if (!pk.startsWith("0x")) pk = "0x" + pk;
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  fail("OPERATOR_PRIVATE_KEY is not a 32-byte hex ECDSA key.");
}

// --- account id -----------------------------------------------------------
// x402 on Hedera settles over HAPI, which addresses accounts as 0.0.x rather
// than by EVM address. Derive the address from the key, then ask the mirror
// node which account it belongs to -- no extra secret needed.
async function resolveAccountId(evmAddress) {
  let res;
  try {
    res = await fetch(`${MIRROR}/accounts/${evmAddress}`, {
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    fail(
      `Mirror node unreachable: ${e.message}`,
      "Set HEDERA_ACCOUNT_ID=0.0.x to skip the lookup."
    );
  }
  if (res.status === 404) {
    fail(
      `No Hedera account found for ${evmAddress}.`,
      "Fund it first -- run send-hbar.mjs, or use the portal faucet."
    );
  }
  // The public mirror node rate-limits aggressively and answers 403/429 once
  // tripped. That is a lookup problem, not a wallet problem, so name the
  // override rather than leaving the run dead.
  if (res.status === 403 || res.status === 429) {
    fail(
      `Public mirror node is rate-limiting this host (HTTP ${res.status}).`,
      "Your account id is unaffected -- set it explicitly to skip the lookup:",
      "  HEDERA_ACCOUNT_ID=0.0.x  (find it on hashscan.io/testnet for your address)"
    );
  }
  if (!res.ok) fail(`Mirror node returned ${res.status} for ${evmAddress}.`);
  return (await res.json()).account;
}

const evmAddress = new ethers.Wallet(pk).address;
const accountId = process.env.HEDERA_ACCOUNT_ID || (await resolveAccountId(evmAddress));

console.log(`\n  x402 paying client`);
console.log(`  evm address : ${evmAddress}`);
console.log(`  account id  : ${accountId}`);
console.log(`  target      : ${URL_UNDER_TEST}`);
console.log(`  facilitator : ${FACILITATOR_URL} (Blocky402 enforced)`);

// --- step 1: unpaid request, to show the challenge ------------------------
console.log(`\n  [1] requesting WITHOUT payment...`);
let challenge;
try {
  const bare = await fetch(URL_UNDER_TEST);
  console.log(`      HTTP ${bare.status} ${bare.statusText}`);
  const header = bare.headers.get("payment-required");
  if (header) {
    challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const opt = challenge.accepts?.[0];
    console.log(`      scheme   : ${opt?.scheme}`);
    console.log(`      network  : ${opt?.network}`);
    console.log(`      payTo    : ${opt?.payTo}`);
    const amt = opt?.amount ?? opt?.maxAmountRequired;
    console.log(`      asset    : ${opt?.asset}  amount: ${amt} tinybar (${Number(amt) / 1e8} HBAR)`);
    console.log(`      feePayer : ${opt?.extra?.feePayer ?? "(none advertised)"}`);
  } else {
    console.log(`      (no PAYMENT-REQUIRED header -- is the route gated?)`);
  }
} catch (e) {
  fail(
    `Cannot reach ${URL_UNDER_TEST}: ${e.message}`,
    "Start the service first:  node x402-server.mjs"
  );
}

// Deliberately outside the try/catch above: a facilitator mismatch must abort
// the run, not be swallowed as a "cannot reach the service" message.
const advertisedFeePayer = challenge?.accepts?.[0]?.extra?.feePayer;
await assertChallengeSettlesViaBlocky402(advertisedFeePayer);
console.log(`      ✓ feePayer ${advertisedFeePayer} confirmed as Blocky402`);

// --- step 2: pay and retry -------------------------------------------------
const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(pk), {
  network: NETWORK,
});

// Spend controls default to "recognized default assets only", and on
// hedera:testnet the only default asset is USDC -- so paying in HBAR is
// rejected client-side before any transaction is built. Allowlist HBAR
// explicitly with a hard per-payment ceiling. Preferred over
// `spendControls: false`, which would let an auto-paying agent spend any
// asset in any amount a server happens to ask for.
const MAX_TINYBAR = process.env.MAX_TINYBAR_PER_PAYMENT || "100000000"; // 1 HBAR

const client = new x402Client()
  .register(NETWORK, new ExactHederaScheme(signer))
  .setSpendControls({
    allowedAssets: [
      { network: NETWORK, asset: "0.0.0", maxAmountPerPayment: MAX_TINYBAR },
    ],
  });

console.log(`  spend cap   : ${MAX_TINYBAR} tinybar (${Number(MAX_TINYBAR) / 1e8} HBAR) per payment`);

const payFetch = wrapFetchWithPayment(fetch, client);

console.log(`\n  [2] paying and re-requesting...`);
const res = await payFetch(URL_UNDER_TEST);
console.log(`      HTTP ${res.status} ${res.statusText}`);

if (!res.ok) {
  const body = await res.text().catch(() => "");
  fail(`Paid request failed: HTTP ${res.status}`, body.slice(0, 400));
}

const data = await res.json();
console.log(`\n  [3] response body:`);
console.log(`      ${JSON.stringify(data)}`);

// --- step 3: settlement receipt -------------------------------------------
const settleHeader = res.headers.get("payment-response");
if (!settleHeader) {
  console.log(`\n  (no PAYMENT-RESPONSE header -- data was served but no receipt returned)\n`);
  process.exit(0);
}

let settlement;
try {
  settlement = decodePaymentResponseHeader(settleHeader);
} catch {
  settlement = JSON.parse(Buffer.from(settleHeader, "base64").toString("utf8"));
}

console.log(`\n  [4] settlement (via Blocky402):`);
console.log(`      success     : ${settlement.success}`);
console.log(`      network     : ${settlement.network ?? NETWORK}`);
console.log(`      payer       : ${settlement.payer ?? accountId}`);

const txId = settlement.transaction;
if (txId) {
  console.log(`      transaction : ${txId}`);
  // HashScan addresses HAPI transactions as 0.0.x@sec.nanos; some views prefer
  // the dash form, so print both rather than guess which one resolves.
  const dashed = String(txId).replace("@", "-").replace(/\.(\d+)$/, "-$1");
  console.log(`\n  verify on HashScan:`);
  console.log(`      ${HASHSCAN}/transaction/${encodeURIComponent(txId)}`);
  console.log(`      ${HASHSCAN}/transaction/${dashed}`);
} else {
  console.log(`      transaction : (none reported)`);
}
console.log("");
