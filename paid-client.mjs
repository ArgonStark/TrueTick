#!/usr/bin/env node
/**
 * TrueTick buying agent: pays real HBAR for real tokenized-stock data.
 *
 * The full loop against the PRODUCT endpoint, not a dummy one:
 *   1. request /price/NVDA unpaid            -> HTTP 402 + challenge
 *   2. verify the challenge settles via Blocky402  (BEFORE spending)
 *   3. pay, retry                            -> real normalized deviation data
 *   4. print the Hedera transaction id       -> verifiable on HashScan
 *
 * Payment is a native Hedera TransferTransaction settled by Blocky402, so the
 * receipt is a Hedera transaction id (0.0.x@sec.nanos), not an EVM 0x hash.
 *
 * Run:  node paid-client.mjs [TICKER]        (default NVDA)
 *       with paid-service.mjs already running
 */
import { ethers } from 'ethers'
import { wrapFetchWithPayment, decodePaymentResponseHeader } from '@x402/fetch'
import { x402Client } from '@x402/core/client'
import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { createClientHederaSigner, PrivateKey } from '@x402/hedera'

import {
  assertBlocky402,
  assertChallengeSettlesViaBlocky402,
  FACILITATOR_URL,
  NETWORK,
} from './core/blocky402.mjs'

try {
  process.loadEnvFile()
} catch {
  /* env may already be exported */
}

const MIRROR = 'https://testnet.mirrornode.hedera.com/api/v1'
const HASHSCAN = 'https://hashscan.io/testnet'

assertBlocky402(FACILITATOR_URL)

const TICKER = (process.argv[2] || 'NVDA').toUpperCase()
const BASE = process.env.TRUETICK_URL || `http://localhost:${process.env.X402_PRICE_PORT || 4402}`
const TARGET = `${BASE}/price/${TICKER}`

function fail(...lines) {
  console.error('\n  x ' + lines.join('\n    ') + '\n')
  process.exit(1)
}

const usd = (n) =>
  n === null || n === undefined
    ? 'null'
    : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// --- key --------------------------------------------------------------------
let pk = (process.env.OPERATOR_PRIVATE_KEY || '').trim()
if (!pk) fail('OPERATOR_PRIVATE_KEY is not set (same key send-hbar.mjs uses).')
if (!pk.startsWith('0x')) pk = '0x' + pk
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) fail('OPERATOR_PRIVATE_KEY is not a 32-byte hex ECDSA key.')

// --- account id -------------------------------------------------------------
// x402 on Hedera settles over HAPI, which addresses accounts as 0.0.x rather
// than by EVM address. Derive the address from the key, then ask the mirror
// node which account it belongs to -- no extra secret needed.
async function resolveAccountId(evmAddress) {
  let res
  try {
    res = await fetch(`${MIRROR}/accounts/${evmAddress}`, { signal: AbortSignal.timeout(15000) })
  } catch (e) {
    fail(`Mirror node unreachable: ${e.message}`, 'Set HEDERA_ACCOUNT_ID=0.0.x to skip the lookup.')
  }
  if (res.status === 404) {
    fail(`No Hedera account found for ${evmAddress}.`, 'Fund it first -- run send-hbar.mjs, or use the portal faucet.')
  }
  // The public mirror node rate-limits aggressively and answers 403/429 once
  // tripped. That is a lookup problem, not a wallet problem, so name the
  // override rather than leaving the run dead.
  if (res.status === 403 || res.status === 429) {
    fail(
      `Public mirror node is rate-limiting this host (HTTP ${res.status}).`,
      'Your account id is unaffected -- set it explicitly to skip the lookup:',
      '  HEDERA_ACCOUNT_ID=0.0.x  (find it on hashscan.io/testnet for your address)'
    )
  }
  if (!res.ok) fail(`Mirror node returned ${res.status} for ${evmAddress}.`)
  return (await res.json()).account
}

const evmAddress = new ethers.Wallet(pk).address
const accountId = process.env.HEDERA_ACCOUNT_ID || (await resolveAccountId(evmAddress))

console.log(`\n  TrueTick buying agent`)
console.log(`  ticker      : ${TICKER}`)
console.log(`  evm address : ${evmAddress}`)
console.log(`  account id  : ${accountId}`)
console.log(`  target      : ${TARGET}`)
console.log(`  facilitator : ${FACILITATOR_URL} (Blocky402 enforced)`)

// --- step 1: unpaid request, to show the challenge --------------------------
console.log(`\n  [1] requesting WITHOUT payment...`)
let challenge
try {
  const bare = await fetch(TARGET)
  console.log(`      HTTP ${bare.status} ${bare.statusText}`)
  const header = bare.headers.get('payment-required')
  if (header) {
    challenge = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    const opt = challenge.accepts?.[0]
    console.log(`      scheme   : ${opt?.scheme}`)
    console.log(`      network  : ${opt?.network}`)
    console.log(`      payTo    : ${opt?.payTo}`)
    const amt = opt?.amount ?? opt?.maxAmountRequired
    console.log(`      asset    : ${opt?.asset}  amount: ${amt} tinybar (${Number(amt) / 1e8} HBAR)`)
    console.log(`      feePayer : ${opt?.extra?.feePayer ?? '(none advertised)'}`)
  } else {
    console.log(`      (no PAYMENT-REQUIRED header -- is the route gated?)`)
  }
} catch (e) {
  fail(`Cannot reach ${TARGET}: ${e.message}`, 'Start the service first:  node paid-service.mjs')
}

// Deliberately outside the try/catch above: a facilitator mismatch must abort
// the run, not be swallowed as a "cannot reach the service" message.
const advertisedFeePayer = challenge?.accepts?.[0]?.extra?.feePayer
await assertChallengeSettlesViaBlocky402(advertisedFeePayer)
console.log(`      OK feePayer ${advertisedFeePayer} confirmed as Blocky402`)

// --- step 2: pay and retry --------------------------------------------------
const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(pk), { network: NETWORK })

// Spend controls default to "recognized default assets only", and on
// hedera:testnet the only default asset is USDC -- so paying in HBAR is
// rejected client-side before any transaction is built. Allowlist HBAR
// explicitly with a hard per-payment ceiling. Preferred over
// `spendControls: false`, which would let an auto-paying agent spend any asset
// in any amount a server happens to ask for.
const MAX_TINYBAR = process.env.MAX_TINYBAR_PER_PAYMENT || '100000000' // 1 HBAR

const client = new x402Client()
  .register(NETWORK, new ExactHederaScheme(signer))
  .setSpendControls({
    allowedAssets: [{ network: NETWORK, asset: '0.0.0', maxAmountPerPayment: MAX_TINYBAR }],
  })

console.log(`  spend cap   : ${MAX_TINYBAR} tinybar (${Number(MAX_TINYBAR) / 1e8} HBAR) per payment`)

const payFetch = wrapFetchWithPayment(fetch, client)

console.log(`\n  [2] paying and re-requesting...`)
const res = await payFetch(TARGET)
console.log(`      HTTP ${res.status} ${res.statusText}`)

if (!res.ok) {
  const body = await res.text().catch(() => '')
  fail(`Paid request failed: HTTP ${res.status}`, body.slice(0, 400))
}

const data = await res.json()

// --- step 3: the data actually bought ---------------------------------------
console.log(`\n  [3] PURCHASED DATA -- ${data.ticker} across ${data.points.length} issuer(s):`)

const ref = data.reference
console.log(`\n      reference : ${usd(data.referencePriceUsd)}  via ${ref?.source ?? 'none'}`)
if (ref) {
  console.log(`                  asOf ${ref.asOf}  (${ref.ageSeconds}s old)`)
  console.log(`                  session ${ref.session}, marketOpen=${ref.marketOpen}`)
} else if (data.referenceError) {
  console.log(`                  unavailable: ${data.referenceError}`)
}

for (const p of data.points) {
  const dev = p.deviationPct === null ? 'null' : `${p.deviationPct >= 0 ? '+' : ''}${p.deviationPct.toFixed(3)}%`
  const devAbs = p.deviationAbsUsd === null ? 'null' : usd(p.deviationAbsUsd)
  console.log(`\n      ${p.symbol}  (${p.issuer})`)
  console.log(`        on-chain price : ${usd(p.priceUsd)}`)
  console.log(`        deviation      : ${dev}   (${devAbs})`)
  console.log(`        pool TVL       : ${usd(p.poolTvlUsd)}   24h vol ${usd(p.volume24hUsd)}`)
  console.log(`        indexed block  : ${p.indexedBlock}  (${p.indexedLagSeconds}s behind head)`)
  console.log(`        priceReliable  : ${p.quality.priceReliable}   deviationReliable: ${p.quality.deviationReliable}`)
  console.log(`        caveats        : ${p.quality.caveats.length ? p.quality.caveats.join(', ') : '(none)'}`)
}

// --- step 4: settlement receipt ---------------------------------------------
const settleHeader = res.headers.get('payment-response')
if (!settleHeader) {
  console.log(`\n  (no PAYMENT-RESPONSE header -- data was served but no receipt returned)\n`)
  process.exit(0)
}

let settlement
try {
  settlement = decodePaymentResponseHeader(settleHeader)
} catch {
  settlement = JSON.parse(Buffer.from(settleHeader, 'base64').toString('utf8'))
}

console.log(`\n  [4] settlement (via Blocky402):`)
console.log(`      success     : ${settlement.success}`)
console.log(`      network     : ${settlement.network ?? NETWORK}`)
console.log(`      payer       : ${settlement.payer ?? accountId}`)

const txId = settlement.transaction
if (txId) {
  console.log(`      transaction : ${txId}`)
  // HashScan addresses HAPI transactions as 0.0.x@sec.nanos; some views prefer
  // the dash form, so print both rather than guess which one resolves.
  const dashed = String(txId).replace('@', '-').replace(/\.(\d+)$/, '-$1')
  console.log(`\n  verify on HashScan:`)
  console.log(`      ${HASHSCAN}/transaction/${encodeURIComponent(txId)}`)
  console.log(`      ${HASHSCAN}/transaction/${dashed}`)
} else {
  console.log(`      transaction : (none reported)`)
}
console.log('')
