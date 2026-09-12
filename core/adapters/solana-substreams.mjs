/**
 * Adapter: Solana mainnet, Raydium CLMM, via SUBSTREAMS on The Graph.
 *
 * THE POINT OF THIS FILE, for the composability track
 *   Solana is not EVM. Different address format (base58), no chain id, a
 *   completely different DEX design, and no `Swap` event to decode -- Solana
 *   emits instructions, not logs. And yet this adapter produces the SAME
 *   `TokenizedStockPoint` as the Ethereum subgraph adapter, with ZERO changes
 *   to the shared schema, the quality rules, the service or the UI.
 *
 *   That is the standards leverage: one query pattern (`GET /price/NVDA`)
 *   spanning three protocols on three chains through two different Graph
 *   products -- Subgraphs (Uniswap v4, Ethereum) and Substreams (Uniswap V3 on
 *   Robinhood Chain, Raydium CLMM on Solana). Adding a chain is a new adapter,
 *   never a schema migration.
 *
 * WHY SUBSTREAMS AND NOT A SUBGRAPH
 *   The Graph's networks registry lists `"subgraphs": []` for
 *   `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` -- Firehose and Substreams only.
 *   As with Robinhood Chain, Substreams is not a preference here, it is the
 *   only Graph-native route to this chain's data.
 *
 * HOW PRICE IS DERIVED, and why not by decoding instructions
 *   Solana swaps carry no price field, and every AMM encodes its instructions
 *   differently. But every transaction carries `meta.preTokenBalances` and
 *   `meta.postTokenBalances`. The delta on the POOL'S OWN VAULTS is the trade:
 *
 *       price = |Δ quote vault| / |Δ base vault|
 *
 *   That is the realised execution price, it is AMM-agnostic, and it survives
 *   Raydium changing its instruction layout. It is also why the pool's vault
 *   addresses are in the registry: routed swaps touch several pools in one
 *   transaction, so summing deltas by MINT would credit another pool's flow to
 *   ours. Only the deltas on this pool's two vaults are this pool's trade.
 *
 *   Vault addresses were decoded from the Raydium CLMM PoolState account and
 *   validated by checking the decoded mints against the mints we already knew.
 */

/**
 * @typedef {import('../types.ts').PoolSnapshot} PoolSnapshot
 * @typedef {import('../types.ts').SourceMeta} SourceMeta
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

try {
  process.loadEnvFile()
} catch {
  /* env may already be exported */
}

export const ADAPTER_ID = 'solana-substreams'

/** CAIP-2, the identifier The Graph's own networks registry uses. */
export const CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

export const ENDPOINT =
  process.env.SUBSTREAMS_ENDPOINT_SOLANA || 'mainnet.sol.streamingfast.io:443'

/** Vendored for the same reason as the EVM package -- see robinhood-substreams.mjs. */
export const PACKAGE =
  process.env.SUBSTREAMS_PACKAGE_SOLANA ||
  fileURLToPath(new URL('../../vendor/solana-common-v0.4.0.spkg', import.meta.url))

const MODULE = 'transactions_by_programid_and_account_without_votes'
const SUBSTREAMS_BIN = process.env.SUBSTREAMS_BIN || 'substreams'

/** Raydium Concentrated Liquidity Market Maker. Verified as the owner of every pool below. */
export const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

/**
 * ~400ms slots. 2,000 slots is ~13 minutes -- plenty for a current price, and
 * NOT a day, which is why volume is labelled with its real window rather than
 * called 24h volume.
 */
const DEFAULT_WINDOW_SLOTS = Number(process.env.SUBSTREAMS_SOLANA_WINDOW_SLOTS || 2_000)
const SLOT_SECONDS = 0.4
const FULL_DAY_HOURS = 23

/** Only one stream at a time: the Graph Market tier allows 2 concurrent sessions. */
let streamLock = Promise.resolve()
function withStreamLock(fn) {
  const run = streamLock.then(fn, fn)
  streamLock = run.then(() => {}, () => {})
  return run
}

const liveChildren = new Set()
function killAllChildren() {
  for (const c of liveChildren) {
    try { c.kill('SIGKILL') } catch { /* already gone */ }
  }
  liveChildren.clear()
}
process.once('exit', killAllChildren)

const resultCache = new Map()
const RESULT_TTL_MS = 120_000

export function isConfigured() {
  return Boolean((process.env.SUBSTREAMS_API_TOKEN || '').trim())
}

async function solanaRpc(method, params) {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(25000),
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}

/** Current slot -- the anchor for an absolute Substreams range. Carries no market data. */
export async function currentHead() {
  return solanaRpc('getSlot', [])
}

function runSubstreams({ params, startBlock, stopBlock, timeoutMs = 240_000 }) {
  return new Promise((resolve, reject) => {
    const token = (process.env.SUBSTREAMS_API_TOKEN || '').trim()
    if (!token) {
      reject(
        new Error(
          'SUBSTREAMS_API_TOKEN is not set. Substreams needs a Graph Market credential, ' +
            'which is NOT the Subgraph Studio GRAPH_API_KEY. Create one at ' +
            'https://thegraph.market and run `substreams auth`.'
        )
      )
      return
    }

    const args = [
      'run', PACKAGE, MODULE,
      '-e', ENDPOINT,
      '-s', String(startBlock),
      '-t', String(stopBlock),
      '-p', `${MODULE}=${params}`,
      '-o', 'jsonl',
      '--limit-processed-blocks', String(stopBlock - startBlock + 1000),
    ]

    const child = spawn(SUBSTREAMS_BIN, args, {
      env: { ...process.env, SUBSTREAMS_API_TOKEN: token },
    })
    liveChildren.add(child)

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      liveChildren.delete(child)
      child.kill('SIGKILL')
      reject(new Error(`substreams run timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      liveChildren.delete(child)
      reject(new Error(
        e.code === 'ENOENT'
          ? `substreams CLI not found (tried "${SUBSTREAMS_BIN}"). Install: brew install streamingfast/tap/substreams`
          : e.message
      ))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      liveChildren.delete(child)
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`substreams exited ${code}: ${stderr.trim().slice(0, 400)}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * Full account list for a transaction.
 *
 * `accountIndex` in the token-balance entries indexes into accountKeys FOLLOWED
 * BY the address-lookup-table addresses. Ignoring the loaded addresses silently
 * mis-maps indices on any transaction that uses a lookup table -- which on
 * Solana is most of them.
 */
function accountList(tx) {
  const msg = tx?.transaction?.message ?? {}
  const meta = tx?.meta ?? {}
  return [
    ...(msg.accountKeys ?? []),
    ...(meta.loadedWritableAddresses ?? []),
    ...(meta.loadedReadonlyAddresses ?? []),
  ]
}

/** Raw amount for a vault address, or null when the vault is not in this tx. */
function vaultAmount(entries, accounts, vault) {
  for (const e of entries ?? []) {
    if (accounts[e.accountIndex] !== vault) continue
    const amt = e.uiTokenAmount?.amount
    const dec = Number(e.uiTokenAmount?.decimals ?? 0)
    if (amt === undefined || amt === null) continue
    try {
      return { raw: BigInt(amt), decimals: dec }
    } catch {
      return null
    }
  }
  return null
}

function toUi(raw, decimals) {
  return Number(raw) / 10 ** decimals
}

/**
 * @param {string[]} addresses token mints (registry keys)
 * @param {object} opts
 * @param {Map<string, Array<object>>} opts.poolsByToken registry pool descriptors
 * @param {number} opts.head current slot
 */
export async function fetchOnChain(addresses, opts = {}) {
  const mints = addresses.map((a) => a.trim())
  const { poolsByToken = new Map(), head } = opts
  if (!head) throw new Error('solana-substreams: head slot is required')

  const windowSlots = DEFAULT_WINDOW_SLOTS
  const startBlock = Math.max(0, head - windowSlots)
  const stopBlock = head
  const windowHours = (windowSlots * SLOT_SECONDS) / 3600

  const allPools = []
  for (const m of mints) for (const p of poolsByToken.get(m) ?? []) allPools.push(p)

  if (!allPools.length) {
    return {
      meta: sourceMeta(head, windowHours),
      ethPriceUSD: null,
      tokens: new Map(mints.map((m) => [m, { pools: [], found: false, error: 'no pools supplied' }])),
    }
  }

  const cacheKey = `${mints.slice().sort().join(',')}|${Math.floor(head / 2000)}`
  const hit = resultCache.get(cacheKey)
  if (hit && Date.now() - hit.at < RESULT_TTL_MS) return hit.value

  // One filter expression for every pool: one stream, not one per token.
  const filter = allPools
    .map((p) => `(account:${p.pool} && program:${RAYDIUM_CLMM})`)
    .join(' || ')

  const { stdout } = await withStreamLock(async () => {
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await runSubstreams({ params: filter, startBlock, stopBlock })
      } catch (e) {
        lastErr = e
        if (!/ResourceExhausted|Concurrent stream limit/i.test(e.message)) throw e
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
      }
    }
    throw new Error(`substreams stream limit exhausted: ${lastErr?.message?.slice(0, 200)}`)
  })

  // --- decode: vault deltas per pool ---------------------------------------
  const byPool = {}
  for (const p of allPools) byPool[p.pool] = { swaps: 0, quoteVolume: 0, lastPrice: null, lastSlot: -1 }

  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let obj
    try { obj = JSON.parse(t) } catch { continue }

    const slot = Number(obj['@block'] ?? 0)
    for (const tx of obj['@data']?.transactions ?? []) {
      const accounts = accountList(tx)
      const meta = tx.meta ?? {}
      if (meta.err) continue // a failed transaction moved nothing

      for (const p of allPools) {
        const preB = vaultAmount(meta.preTokenBalances, accounts, p.vaultBase)
        const postB = vaultAmount(meta.postTokenBalances, accounts, p.vaultBase)
        const preQ = vaultAmount(meta.preTokenBalances, accounts, p.vaultQuote)
        const postQ = vaultAmount(meta.postTokenBalances, accounts, p.vaultQuote)
        if (!preB || !postB || !preQ || !postQ) continue

        const dBase = postB.raw - preB.raw
        const dQuote = postQ.raw - preQ.raw
        if (dBase === 0n || dQuote === 0n) continue
        // A swap moves the two sides in OPPOSITE directions. Same-sign deltas
        // are a liquidity add/remove, which has no execution price.
        if ((dBase > 0n) === (dQuote > 0n)) continue

        const baseUi = Math.abs(toUi(dBase, preB.decimals))
        const quoteUi = Math.abs(toUi(dQuote, preQ.decimals))
        if (!(baseUi > 0) || !(quoteUi > 0)) continue

        const slot_ = byPool[p.pool]
        slot_.swaps++
        slot_.quoteVolume += quoteUi
        if (slot >= slot_.lastSlot) {
          slot_.lastSlot = slot
          slot_.lastPrice = quoteUi / baseUi
        }
      }
    }
  }

  // --- vault balances for TVL (state, not events -- labelled downstream) ----
  let reserves = null
  let reserveError = null
  try {
    reserves = await fetchVaultBalances(allPools)
  } catch (e) {
    reserveError = String(e.message || e)
  }

  const tokens = new Map()
  for (const m of mints) {
    const pools = (poolsByToken.get(m) ?? []).map((p) => ({
      ...p,
      stats: byPool[p.pool] ?? null,
      reserves: reserves?.[p.pool] ?? null,
    }))
    tokens.set(m, {
      pools,
      found: true,
      windowHours,
      swapsSeen: pools.reduce((n, p) => n + (p.stats?.swaps ?? 0), 0),
      error: reserveError ? `reserves unavailable: ${reserveError}` : null,
    })
  }

  const value = { meta: sourceMeta(head, windowHours), ethPriceUSD: null, tokens }
  resultCache.set(cacheKey, { at: Date.now(), value })
  return value
}

/**
 * Pool reserves, read as account STATE.
 *
 * Same split as the Robinhood adapter and labelled the same way: price and
 * volume are event-sourced from Substreams; reserves are not in the event
 * stream, so TVL is a state read and says so via `tvl-via-state-read`.
 * SUBSTREAMS_TVL=off drops TVL to null and keeps the row purely event-sourced.
 */
async function fetchVaultBalances(pools) {
  if ((process.env.SUBSTREAMS_TVL || '').toLowerCase() === 'off') return null
  const out = {}
  for (const p of pools) {
    const [b, q] = await Promise.all([
      solanaRpc('getTokenAccountBalance', [p.vaultBase]).catch(() => null),
      solanaRpc('getTokenAccountBalance', [p.vaultQuote]).catch(() => null),
    ])
    out[p.pool] = {
      base: b?.value ? Number(b.value.uiAmount) : null,
      quote: q?.value ? Number(q.value.uiAmount) : null,
    }
  }
  return out
}

/** @returns {SourceMeta} */
function sourceMeta(head, windowHours) {
  return {
    adapter: ADAPTER_ID,
    protocol: 'Raydium CLMM',
    product: 'Substreams',
    endpointId: `substreams:${ENDPOINT}/${MODULE} (window ${windowHours.toFixed(2)}h)`,
    indexedBlock: head,
    indexedAt: new Date().toISOString(),
    indexedLagSeconds: 0,
    hasIndexingErrors: false,
  }
}

export function shapeToken(raw, address, _ethPriceUSD, decimals = 8, symbol = 'TOKEN') {
  const empty = {
    sourceError: raw?.error ?? null,
    indexed: false,
    priceUsd: null,
    poolTvlUsd: null,
    volume24hUsd: null,
    volumeUsd: 0,
    volumeWindowHours: null,
    volumePrevDayUsd: 0,
    pools: [],
    deepestPoolPriceUsd: null,
    priceDivergencePct: null,
    onChainSymbol: null,
    onChainDecimals: null,
    extraCaveats: ['tvl-unavailable'],
  }
  if (!raw || !raw.found || !raw.pools.length) return empty

  const windowHours = raw.windowHours ?? 0
  /** @type {PoolSnapshot[]} */
  const pools = []
  let volumeUsd = 0

  for (const p of raw.pools) {
    const s = p.stats
    const priceInQuote = s?.lastPrice ?? null
    volumeUsd += s?.quoteVolume ?? 0

    // USDC is the quote and is treated as $1 -- the same stated assumption the
    // Robinhood adapter makes about USDG.
    let tvlUsd = null
    if (p.reserves && p.reserves.quote !== null) {
      const baseSide = p.reserves.base !== null && priceInQuote !== null ? p.reserves.base * priceInQuote : 0
      tvlUsd = p.reserves.quote + baseSide
    }

    pools.push({
      id: p.pool,
      pairSymbol: `${symbol}/USDC`,
      quoteSymbol: 'USDC',
      feeTier: p.fee ?? null,
      tvlUsd,
      volume24hUsd: s?.quoteVolume ?? 0,
      priceInQuote,
    })
  }

  pools.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))

  const traded = pools.filter((x) => x.volume24hUsd > 0 && x.priceInQuote !== null)
  traded.sort((a, b) => b.volume24hUsd - a.volume24hUsd)
  const priceUsd = traded.length ? traded[0].priceInQuote : null

  const second = traded[1] ?? null
  const deepestPoolPriceUsd = second ? second.priceInQuote : null
  const priceDivergencePct =
    priceUsd !== null && deepestPoolPriceUsd !== null && priceUsd > 0
      ? (Math.abs(priceUsd - deepestPoolPriceUsd) / priceUsd) * 100
      : null

  const tvlValues = pools.map((x) => x.tvlUsd).filter((v) => v !== null)
  const poolTvlUsd = tvlValues.length ? tvlValues.reduce((a, b) => a + b, 0) : null

  const isFullDay = windowHours >= FULL_DAY_HOURS
  const caveats = [poolTvlUsd === null ? 'tvl-unavailable' : 'tvl-via-state-read']
  if (!isFullDay) caveats.push('volume-window-short')

  return {
    sourceError: raw.error ?? null,
    indexed: true,
    priceUsd,
    poolTvlUsd,
    volume24hUsd: isFullDay ? volumeUsd : null,
    volumeUsd,
    volumeWindowHours: windowHours,
    volumePrevDayUsd: 0,
    pools,
    deepestPoolPriceUsd,
    priceDivergencePct,
    onChainSymbol: null,
    onChainDecimals: null,
    extraCaveats: caveats,
  }
}

export { USDC_MINT }
