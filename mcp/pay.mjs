/**
 * Server-side x402 payment for the TrueTick MCP server.
 *
 * THE SECURITY BOUNDARY OF THIS WHOLE INTEGRATION LIVES HERE.
 *
 * The operator's private key is read from the local env file, used to sign a
 * Hedera transfer, and never leaves this module. It is not a tool parameter,
 * not in any tool's JSON schema, not in a tool result, not in an error message,
 * and not in anything the model can read. The model's entire authority is
 * "call get_deviation with a ticker"; the decision to spend, the asset, and the
 * ceiling are all fixed in code here.
 *
 * That asymmetry is the point of the demo: an AI agent initiates a real
 * payment without ever holding the credential that makes it possible.
 *
 * Payment path is unchanged from the proven paid-client.mjs: native Hedera
 * TransferTransaction, HBAR (asset 0.0.0), settled by the Blocky402
 * facilitator, with the feePayer cross-checked BEFORE any HBAR moves.
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
} from '../core/blocky402.mjs'

try {
  process.loadEnvFile()
} catch {
  /* env may already be exported */
}

const MIRROR = 'https://testnet.mirrornode.hedera.com/api/v1'
export const HASHSCAN = 'https://hashscan.io/testnet'

/** Hard ceiling per payment. 1 HBAR unless explicitly raised. */
const MAX_TINYBAR = process.env.MAX_TINYBAR_PER_PAYMENT || '100000000'

/**
 * Redact anything key-shaped from text that may reach the model.
 *
 * Belt and braces: no code path below puts the key in an error, but errors from
 * third-party libraries are not under our control, and one careless
 * `${config}` interpolation upstream would leak a spendable credential into a
 * chat transcript. Cheap insurance against a mistake that cannot be undone.
 */
export function redact(text) {
  let s = String(text ?? '')
  const key = (process.env.OPERATOR_PRIVATE_KEY || '').trim()
  if (key) {
    for (const form of [key, key.replace(/^0x/, ''), '0x' + key.replace(/^0x/, '')]) {
      if (form.length > 16) s = s.split(form).join('[REDACTED]')
    }
  }
  // Any other 32-byte hex blob is key-shaped regardless of where it came from.
  return s.replace(/\b(0x)?[0-9a-fA-F]{64}\b/g, '[REDACTED-64HEX]')
}

/** Loaded once, cached; never returned to a caller. */
let walletCache = null

function loadWallet() {
  if (walletCache) return walletCache

  let pk = (process.env.OPERATOR_PRIVATE_KEY || '').trim()
  if (!pk) {
    const err = new Error(
      'OPERATOR_PRIVATE_KEY is not set in the environment of the MCP server process. ' +
        'Add it to the project env file, or pass it via the "env" block of the Claude ' +
        'Desktop config entry.'
    )
    err.code = 'NO_WALLET'
    throw err
  }
  if (!pk.startsWith('0x')) pk = '0x' + pk
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    const err = new Error('OPERATOR_PRIVATE_KEY is not a 32-byte hex ECDSA key.')
    err.code = 'BAD_WALLET'
    throw err
  }

  walletCache = { pk, evmAddress: new ethers.Wallet(pk).address }
  return walletCache
}

/** Public, non-sensitive wallet facts, safe to show the model. */
export function walletInfo() {
  try {
    const { evmAddress } = loadWallet()
    return { configured: true, evmAddress, accountId: accountIdCache ?? null }
  } catch (e) {
    return { configured: false, evmAddress: null, accountId: null, reason: e.message }
  }
}

let accountIdCache = process.env.HEDERA_ACCOUNT_ID || null

/**
 * Hedera addresses accounts as 0.0.x, not by EVM address, so the account id is
 * resolved from the mirror node. Cached: the public mirror node rate-limits
 * hard, and a demo that pays twice should not look it up twice.
 */
async function resolveAccountId(evmAddress) {
  if (accountIdCache) return accountIdCache

  let res
  try {
    res = await fetch(`${MIRROR}/accounts/${evmAddress}`, { signal: AbortSignal.timeout(15000) })
  } catch (e) {
    const err = new Error(
      `Hedera mirror node unreachable (${e.message}). Set HEDERA_ACCOUNT_ID=0.0.x to skip the lookup.`
    )
    err.code = 'MIRROR_UNREACHABLE'
    throw err
  }

  if (res.status === 404) {
    const err = new Error(
      `No Hedera account exists for ${evmAddress}. Fund it on testnet first.`
    )
    err.code = 'NO_ACCOUNT'
    throw err
  }
  if (res.status === 403 || res.status === 429) {
    const err = new Error(
      `Hedera mirror node is rate-limiting this host (HTTP ${res.status}). The wallet is fine — ` +
        `set HEDERA_ACCOUNT_ID=0.0.x in the MCP server env to skip the lookup entirely.`
    )
    err.code = 'MIRROR_RATE_LIMIT'
    throw err
  }
  if (!res.ok) {
    const err = new Error(`Hedera mirror node returned HTTP ${res.status}.`)
    err.code = 'MIRROR_ERROR'
    throw err
  }

  accountIdCache = (await res.json()).account
  return accountIdCache
}

/** The paying x402 client, built once and reused across tool calls. */
let payFetchCache = null

async function getPayFetch() {
  if (payFetchCache) return payFetchCache

  assertBlocky402(FACILITATOR_URL)
  const { pk, evmAddress } = loadWallet()
  const accountId = await resolveAccountId(evmAddress)

  const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(pk), {
    network: NETWORK,
  })

  // Spend controls, not `spendControls: false`. On hedera:testnet the only
  // DEFAULT asset is USDC, so HBAR must be allowlisted explicitly -- and it is
  // allowlisted with a hard per-payment ceiling, so a compromised or
  // misconfigured server cannot be talked into draining the account.
  const client = new x402Client()
    .register(NETWORK, new ExactHederaScheme(signer))
    .setSpendControls({
      allowedAssets: [{ network: NETWORK, asset: '0.0.0', maxAmountPerPayment: MAX_TINYBAR }],
    })

  payFetchCache = { payFetch: wrapFetchWithPayment(fetch, client), accountId, evmAddress }
  return payFetchCache
}

/** HashScan accepts both the @ and the dashed form; emit both rather than guess. */
export function hashscanLinks(txId) {
  if (!txId) return []
  const dashed = String(txId).replace('@', '-').replace(/\.(\d+)$/, '-$1')
  return [
    `${HASHSCAN}/transaction/${encodeURIComponent(txId)}`,
    `${HASHSCAN}/transaction/${dashed}`,
  ]
}

/**
 * Fetch a 402-gated URL, paying if challenged.
 *
 * Verifies the server settles through Blocky402 BEFORE spending: the challenge
 * advertises a feePayer, which is cross-checked against the signers Blocky402
 * publishes. A service pointed at a different facilitator is caught here and
 * the payment is aborted rather than refunded.
 *
 * @returns {Promise<{data:object, settlement:object|null, paid:boolean, priceTinybar:string|null}>}
 */
export async function payAndFetch(url, { timeoutMs = 180000, onProgress } = {}) {
  const note = (m) => { try { onProgress?.(m) } catch { /* progress is best-effort */ } }

  note('checking payment challenge')

  // Step 1: unpaid request, to read the challenge and confirm the facilitator.
  let priceTinybar = null
  try {
    const bare = await fetch(url, { signal: AbortSignal.timeout(20000) })
    const header = bare.headers.get('payment-required')
    if (header) {
      const challenge = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
      const opt = challenge.accepts?.[0]
      priceTinybar = String(opt?.amount ?? opt?.maxAmountRequired ?? '')
      note('verifying facilitator is Blocky402')
      await assertChallengeSettlesViaBlocky402(opt?.extra?.feePayer)
    } else if (bare.ok) {
      // Route is not gated. Return what it gave us rather than inventing a
      // payment that was never required.
      return { data: await bare.json(), settlement: null, paid: false, priceTinybar: null }
    }
  } catch (e) {
    if (/FACILITATOR MISMATCH/.test(String(e.message))) throw e
    // A failed pre-flight is not fatal: the paid attempt below is the real
    // test, and it carries its own error reporting.
    note('pre-flight check skipped: ' + e.message)
  }

  note('paying and requesting data (cold Substreams can take ~75s)')

  const { payFetch } = await getPayFetch()
  const res = await payFetch(url, { signal: AbortSignal.timeout(timeoutMs) })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(`Paid request failed: HTTP ${res.status}. ${redact(body).slice(0, 400)}`)
    err.code = 'PAID_REQUEST_FAILED'
    // The x402 middleware cancels settlement when the handler errors, so a 4xx
    // or 5xx here means the caller was NOT charged. Worth saying explicitly --
    // otherwise a failed demo looks like lost money.
    err.notCharged = true
    throw err
  }

  const data = await res.json()

  let settlement = null
  const settleHeader = res.headers.get('payment-response')
  if (settleHeader) {
    try {
      settlement = decodePaymentResponseHeader(settleHeader)
    } catch {
      try {
        settlement = JSON.parse(Buffer.from(settleHeader, 'base64').toString('utf8'))
      } catch {
        settlement = null
      }
    }
  }

  note('settled')
  return { data, settlement, paid: Boolean(settlement), priceTinybar }
}
