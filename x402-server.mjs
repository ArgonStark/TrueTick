#!/usr/bin/env node
/**
 * x402-gated service on Hedera testnet, settled via the Blocky402 facilitator.
 *
 * ONE endpoint: GET /price -> {"ticker":"AAPL","price":42}
 * Unpaid requests get HTTP 402 + payment requirements. Paid requests get data.
 *
 * Run:  node x402-server.mjs
 */
import express from "express";
import { fileURLToPath } from "node:url";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

try {
  process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)));
} catch { /* env may already be exported */ }

const NETWORK = "hedera:testnet";

// HBAR as an x402 asset. Deliberately NOT the SDK default: DEFAULT_ASSETS maps
// hedera:testnet to USDC 0.0.429274, which requires an HTS token association
// and testnet USDC before any payment can settle. HBAR asset id 0.0.0 needs
// neither, so it is the only unblocked path for a cold wallet.
const HBAR_ASSET = "0.0.0";

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
 * So: fail loudly at startup instead of shipping a green build that does not
 * qualify. Hostname match, not substring -- `https://evil.test/?x=blocky402.com`
 * contains the string but is not Blocky402.
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

// Where payments land. Defaults to the hollow account created by send-hbar.mjs;
// receiving HBAR needs no signature, so a keyless account is a valid payee.
const PAY_TO = process.env.PAY_TO_ACCOUNT_ID || "0.0.10439151";

// Price in tinybars (HBAR has 8 decimals). 1_000_000 tinybar = 0.01 HBAR.
const PRICE_TINYBAR = process.env.PRICE_TINYBAR || "1000000";

const PORT = Number(process.env.X402_PORT || 4021);

if (!/^\d+\.\d+\.\d+$/.test(PAY_TO)) {
  console.error(`\n  x PAY_TO_ACCOUNT_ID must be a Hedera account id (0.0.x), got: ${PAY_TO}\n`);
  process.exit(1);
}

// --- x402 wiring -----------------------------------------------------------
// The resource server never signs anything. It only builds the 402 challenge
// and asks the facilitator to verify + settle, so it needs no key of its own.
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const x402 = new x402ResourceServer(facilitator).register(
  NETWORK,
  new ExactHederaScheme()
);

const routes = {
  "GET /price": {
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO,
        // Explicit AssetAmount, not a "$0.001" money string -- a money string
        // would be resolved against DEFAULT_ASSETS and land on USDC.
        price: { asset: HBAR_ASSET, amount: String(PRICE_TINYBAR) },
      },
    ],
    description: "Dummy ticker quote (throwaway PoC)",
    mimeType: "application/json",
  },
};

const app = express();
app.use(paymentMiddleware(routes, x402));

// Only reached once payment has been verified by Blocky402.
app.get("/price", (_req, res) => {
  res.json({ ticker: "AAPL", price: 42 });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  const hbar = Number(PRICE_TINYBAR) / 1e8;
  console.log(`\n  x402 service listening on http://localhost:${PORT}`);
  console.log(`  endpoint    : GET /price  (402-gated)`);
  console.log(`  network     : ${NETWORK}`);
  console.log(`  facilitator : ${FACILITATOR_URL}`);
  console.log(`  price       : ${PRICE_TINYBAR} tinybar (${hbar} HBAR, asset ${HBAR_ASSET})`);
  console.log(`  payTo       : ${PAY_TO}`);
  console.log(`\n  waiting for a paid request...\n`);
});
