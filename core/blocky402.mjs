/**
 * Blocky402 facilitator enforcement.
 *
 * The Hedera "AI & Agentic Payments" track requires settlement through the
 * Blocky402 facilitator SPECIFICALLY, not any conformant x402 facilitator.
 *
 * This is the single easiest requirement in the whole project to fail without
 * noticing, because failing it produces NO runtime symptom: the official Hedera
 * PoC (hedera-dev/x402-inference-pay-per-request-poc) points testnet at
 * https://x402.org/facilitator and uses Blocky402 only on mainnet. Anyone
 * "aligning" this project with that reference -- a teammate, a future me, or a
 * coding assistant told to match it -- would produce a build where every test
 * passes, payments settle, HashScan shows real transactions, and the track
 * requirement is silently missed.
 *
 * So both checks below fail LOUDLY rather than let a green build ship.
 *
 * NOTE ON DUPLICATION: x402-server.mjs and x402-client.mjs carry their own
 * inline copies of assertBlocky402. That is deliberate -- they are the proven
 * standalone artefacts referenced in DEMO_EVIDENCE.md and are left byte-for-byte
 * untouched. This module is the shared implementation for everything built
 * afterwards. The logic is identical; if you change one, change both.
 */

export const NETWORK = 'hedera:testnet'

/** HBAR as an x402 asset id. */
export const HBAR_ASSET = '0.0.0'

export const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL || 'https://api.testnet.blocky402.com'

/**
 * Guard THIS process's configured facilitator URL.
 *
 * Hostname match, not substring: `https://evil.test/?x=blocky402.com` contains
 * the string but is not Blocky402.
 */
export function assertBlocky402(url = FACILITATOR_URL) {
  let host
  try {
    host = new globalThis.URL(url).hostname.toLowerCase()
  } catch {
    throw new Error(`X402_FACILITATOR_URL is not a valid URL: ${url}`)
  }
  if (host !== 'blocky402.com' && !host.endsWith('.blocky402.com')) {
    throw new Error(
      `\n\n  FACILITATOR REQUIREMENT VIOLATED\n` +
        `  Resolved facilitator : ${url}  (host: ${host})\n` +
        `  Required             : *.blocky402.com\n\n` +
        `  The Hedera AI & Agentic Payments track mandates the Blocky402\n` +
        `  facilitator. x402.org/facilitator is a conformant x402 facilitator\n` +
        `  and everything would appear to work -- but it does NOT satisfy the\n` +
        `  track requirement. Do not "fix" this by relaxing the check.\n`
    )
  }
  return url
}

/**
 * Guard the facilitator the SERVER actually settles through.
 *
 * assertBlocky402 only covers this process's own config, and a paying client
 * does not choose the facilitator -- the server does. The 402 challenge
 * advertises `extra.feePayer`, the account that co-signs and submits the
 * transfer, which is the facilitator itself. Cross-checking that against the
 * signers Blocky402 publishes at /supported proves the server is genuinely
 * settling through Blocky402 -- and does so BEFORE any HBAR leaves the wallet.
 * A server pointed at x402.org advertises a different feePayer and is caught.
 */
export async function assertChallengeSettlesViaBlocky402(feePayer, url = FACILITATOR_URL) {
  if (!feePayer) {
    throw new Error('402 challenge advertised no feePayer -- cannot confirm Blocky402 settlement.')
  }

  const res = await fetch(`${url}/supported`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`Blocky402 /supported returned HTTP ${res.status}.`)

  const body = await res.json()
  const kind = (body.kinds || []).find((k) => k.network === NETWORK && k.scheme === 'exact')
  const expected = kind?.extra?.feePayer
  const signers = body.signers?.['hedera:*'] || []
  const accepted = new Set([expected, ...signers].filter(Boolean))

  if (!accepted.has(feePayer)) {
    throw new Error(
      `\n\n  FACILITATOR MISMATCH\n` +
        `  Server's 402 advertises feePayer : ${feePayer}\n` +
        `  Blocky402 publishes              : ${[...accepted].join(', ') || '(none)'}\n\n` +
        `  The service is settling through a DIFFERENT facilitator. Payment\n` +
        `  aborted before spending. Point the server at Blocky402.\n`
    )
  }
  return feePayer
}
