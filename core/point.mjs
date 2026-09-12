/**
 * Assembly and quality judgement.
 *
 * Adapters report what the chain says. Reference providers report what the
 * market says. This module is where the two meet, the deviation is computed,
 * and -- the part that matters -- where a number that should not be trusted is
 * labelled rather than hidden.
 *
 * The rule we agreed: COMPUTE AND FLAG, never silently suppress. Off-hours the
 * deviation is still interesting (it is the token pricing in overnight news);
 * it just is not arbitrage. So it is returned with deviationReliable false and
 * a 'market-closed' caveat, not replaced by null.
 *
 * Null is reserved for "we do not know", never for "we know it is zero".
 */

import { ISSUERS } from './registry.mjs'
import * as ethereumUniV4 from './adapters/ethereum-univ4.mjs'
import * as robinhoodRpc from './adapters/robinhood-rpc.mjs'
import * as robinhoodSubstreams from './adapters/robinhood-substreams.mjs'
import * as solanaSubstreams from './adapters/solana-substreams.mjs'
import { getReferencePriceCached } from './reference-price.mjs'

/**
 * Adapter registry. Adding a venue is an entry here plus a file -- the schema,
 * the quality rules, the service and the UI are all untouched. That was the
 * point of the shared contract.
 *
 * Every adapter exposes the same two functions:
 *   fetchOnChain(addresses) -> { meta, ethPriceUSD, tokens }
 *   shapeToken(raw, address, ethPriceUSD, decimals) -> shaped
 */
const ADAPTERS = {
  [ethereumUniV4.ADAPTER_ID]: ethereumUniV4,
  [robinhoodRpc.ADAPTER_ID]: robinhoodRpc,
  [robinhoodSubstreams.ADAPTER_ID]: robinhoodSubstreams,
  [solanaSubstreams.ADAPTER_ID]: solanaSubstreams,
}

/**
 * Adapters that need pool descriptors and a head block supplied by the caller.
 *
 * Substreams reads EVENTS; pool membership and vault addresses are chain STATE,
 * so they come from the registry rather than being discovered mid-stream. Both
 * Substreams adapters share this shape, EVM and non-EVM alike.
 */
const NEEDS_POOL_CONTEXT = new Set([solanaSubstreams.ADAPTER_ID, robinhoodSubstreams.ADAPTER_ID])

/**
 * Escape hatch: ROBINHOOD_ADAPTER=rpc swaps the Substreams adapter for the
 * direct-RPC one. Substreams is the Graph-native path and the default; the RPC
 * adapter stays available so a missing Substreams credential cannot take the
 * whole venue offline.
 */
function resolveAdapterId(id) {
  if (id === robinhoodSubstreams.ADAPTER_ID && (process.env.ROBINHOOD_ADAPTER || '').toLowerCase() === 'rpc') {
    return robinhoodRpc.ADAPTER_ID
  }
  return id
}

const ADAPTER_ID = ethereumUniV4.ADAPTER_ID

/**
 * @typedef {import('./types.ts').TokenizedStockPoint} TokenizedStockPoint
 * @typedef {import('./types.ts').TickerComparison} TickerComparison
 * @typedef {import('./types.ts').Quality} Quality
 */

/**
 * Every judgement threshold, in one place, so tuning them is a review of this
 * block rather than an archaeology dig through the code.
 */
export const THRESHOLDS = {
  /**
   * Max acceptable gap between the two independent on-chain price paths
   * (derivedETH vs the deepest pool's own ratio) before we distrust both.
   * Set at 1%: the paths differ by rounding and by which pools each weighs, so
   * sub-1% gaps are normal and flagging them would be noise. A real breakage
   * shows up as tens of percent, not tenths.
   */
  priceDivergencePct: 1,

  /** Two-day volume below this means the price has no real trading behind it. */
  thinVolumeUsd: 1_000,

  /**
   * A reference quote older than this WHILE the market is open means the feed
   * is lagging. Also the safety net for the clock-based session fallback not
   * knowing about market holidays: on a holiday the quote is a day old, so this
   * fires even though the clock claims 'regular'.
   */
  referenceStaleSecondsWhenOpen: 900,

  /** Index lag beyond this and the "live data" claim weakens. */
  indexLagSeconds: 300,
}

/**
 * @param {object} args
 * @returns {Quality}
 */
function judge({
  priceUsd,
  poolCount,
  poolTvlUsd,
  volume24hUsd,
  volumePrevDayUsd,
  priceDivergencePct,
  referencePriceUsd,
  reference,
  source,
  decimalsMatch,
  sourceError,
  extraCaveats = [],
}) {
  /** @type {string[]} */
  const caveats = []

  // A read that FAILED must never render as "this token has no pools". One is
  // a fact about the market; the other is a fact about our plumbing, and
  // dressing the second up as the first is exactly the silent lie this project
  // keeps designing against.
  if (sourceError) caveats.push('source-error')
  else if (poolCount === 0) caveats.push('no-pools')

  // Phantom liquidity: capital sitting in pools that nobody trades against.
  // Judged over today AND yesterday so a quiet morning is not mistaken for a
  // dead market.
  // volume24hUsd is null when the source measured a shorter window than a day.
  // NOTE the trap: `null + 0` is 0 in JavaScript, so summing first would turn
  // "we did not measure" into "nothing traded" and flag a live market as thin.
  // Unknown stays unknown.
  const volumeKnown = volume24hUsd !== null && volume24hUsd !== undefined
  const recentVolume = volumeKnown ? volume24hUsd + volumePrevDayUsd : null
  // poolTvlUsd is null when the venue cannot observe reserves (event-only
  // sources). Unknown TVL must not be read as "TVL exists but nothing trades".
  const phantomLiquidity =
    poolTvlUsd !== null && poolTvlUsd > 0 && recentVolume !== null && recentVolume === 0
  if (phantomLiquidity) caveats.push('phantom-liquidity')
  else if (poolCount > 0 && recentVolume !== null && recentVolume < THRESHOLDS.thinVolumeUsd) {
    caveats.push('thin-volume')
  }

  if (priceDivergencePct !== null && priceDivergencePct > THRESHOLDS.priceDivergencePct) {
    caveats.push('price-divergence')
  }

  if (source.hasIndexingErrors) caveats.push('indexing-errors')
  if (source.indexedLagSeconds > THRESHOLDS.indexLagSeconds) caveats.push('index-lagging')

  // A registry entry whose decimals disagree with the chain is a registry bug,
  // and registry bugs are the ones that produce confidently wrong answers.
  if (decimalsMatch === false) caveats.push('decimals-mismatch')

  if (referencePriceUsd === null) caveats.push('no-reference-price')
  if (reference && !reference.marketOpen) caveats.push('market-closed')

  const referenceStale =
    reference !== null &&
    reference.marketOpen &&
    reference.ageSeconds > THRESHOLDS.referenceStaleSecondsWhenOpen
  if (referenceStale) caveats.push('reference-stale')

  const priceReliable =
    !sourceError &&
    priceUsd !== null &&
    poolCount > 0 &&
    !phantomLiquidity &&
    !source.hasIndexingErrors &&
    !caveats.includes('price-divergence') &&
    decimalsMatch !== false

  // Deviation is only actionable when BOTH sides are trustworthy at the same
  // moment: a real on-chain price, a real reference, and a market actually open
  // to arbitrage against.
  const deviationReliable =
    priceReliable &&
    referencePriceUsd !== null &&
    reference !== null &&
    reference.marketOpen &&
    !referenceStale

  // Adapter-specific caveats (e.g. 'tvl-unavailable' from an event-only source)
  // are informational: they describe what a venue cannot see, not a fault in
  // the price, so they do not by themselves make a price unreliable.
  for (const c of extraCaveats) if (!caveats.includes(c)) caveats.push(c)

  return { priceReliable, deviationReliable, phantomLiquidity, caveats }
}

/**
 * Build one normalized point from a registry entry plus already-fetched data.
 *
 * @returns {TokenizedStockPoint}
 */
export function buildPoint({ address, entry, shaped, source, reference, referencePriceUsd }) {
  const priceUsd = shaped.priceUsd

  // Deviation: null if either side is unknown. Never computed against a zero,
  // never defaulted to 0.
  let deviationPct = null
  let deviationAbsUsd = null
  if (priceUsd !== null && referencePriceUsd !== null && referencePriceUsd > 0) {
    deviationAbsUsd = priceUsd - referencePriceUsd
    deviationPct = (deviationAbsUsd / referencePriceUsd) * 100
  }

  const decimalsMatch =
    shaped.onChainDecimals === null ? null : shaped.onChainDecimals === entry.decimals

  const quality = judge({
    priceUsd,
    poolCount: shaped.pools.length,
    poolTvlUsd: shaped.poolTvlUsd,
    volume24hUsd: shaped.volume24hUsd,
    volumePrevDayUsd: shaped.volumePrevDayUsd,
    priceDivergencePct: shaped.priceDivergencePct,
    referencePriceUsd,
    reference,
    source,
    decimalsMatch,
    sourceError: shaped.sourceError ?? null,
    extraCaveats: shaped.extraCaveats ?? [],
  })

  return {
    ticker: entry.ticker,
    issuer: ISSUERS[entry.issuer]?.wrapper ?? entry.issuer,
    chain: entry.chain,
    chainId: entry.chainId ?? null,
    caip2: entry.caip2 ?? (entry.chainId ? `eip155:${entry.chainId}` : null),
    tokenAddress: address,
    symbol: entry.symbol,
    decimals: entry.decimals,

    priceUsd,
    poolTvlUsd: shaped.poolTvlUsd,
    volume24hUsd: shaped.volume24hUsd,
    // Present when the source measured a window shorter than 24h, so a partial
    // figure can be shown truthfully instead of being dropped or mislabelled.
    volumeUsd: shaped.volumeUsd ?? null,
    volumeWindowHours: shaped.volumeWindowHours ?? null,

    referencePriceUsd,
    deviationPct,
    deviationAbsUsd,

    indexedBlock: source.indexedBlock,
    indexedLagSeconds: source.indexedLagSeconds,

    reference,
    source,
    pools: shaped.pools,
    backing: ISSUERS[entry.issuer] ?? null,
    quality,

    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Full comparison row for one ticker: every registered token for that
 * underlying, priced at the same indexed block, against one reference price.
 *
 * @param {string} ticker
 * @param {Array<object>} entries from registry.byTicker()
 * @returns {Promise<TickerComparison>}
 */
export async function buildComparison(ticker, entries) {
  if (!entries.length) {
    return {
      ticker,
      referencePriceUsd: null,
      reference: null,
      referenceError: 'no registered tokens for this ticker',
      sourceErrors: [],
      points: [],
      fetchedAt: new Date().toISOString(),
    }
  }

  // Every entry for a ticker shares an underlying, so one reference fetch
  // serves them all. referenceSymbol is null for tokens with no listed
  // underlying (SpaceX), and that null flows through to a null deviation.
  const referenceSymbol = entries.find((e) => e.referenceSymbol)?.referenceSymbol ?? null

  // Group by adapter: one ticker can now span venues on different chains.
  /** @type {Record<string, Array<object>>} */
  const byAdapter = {}
  for (const e of entries) {
    const id = resolveAdapterId(e.adapter || ADAPTER_ID)
    if (!ADAPTERS[id]) continue // unknown adapter: skipped, never faked
    ;(byAdapter[id] ||= []).push(e)
  }

  // Every adapter and the reference run together; any one may fail without
  // taking the others down.
  const adapterIds = Object.keys(byAdapter)
  const settled = await Promise.allSettled([
    ...adapterIds.map((id) => {
      const group = byAdapter[id]
      const addrs = group.map((e) => e.address)
      if (!NEEDS_POOL_CONTEXT.has(id)) return ADAPTERS[id].fetchOnChain(addrs)
      // Substreams reads events; pool membership is state, so it comes from the
      // registry, and the head block comes from a single cheap RPC call.
      const mod = ADAPTERS[id]
      const poolsByToken = new Map(group.map((e) => [e.address, e.pools ?? []]))
      return mod.currentHead().then((head) => mod.fetchOnChain(addrs, { poolsByToken, head }))
    }),
    getReferencePriceCached(referenceSymbol),
  ])

  const referenceResult = settled[settled.length - 1]
  const adapterResults = settled.slice(0, adapterIds.length)

  // If EVERY venue failed there is nothing to return but errors -- say so
  // rather than emitting a row of nulls that reads like real, calm data.
  if (adapterResults.every((r) => r.status === 'rejected')) {
    throw new Error(
      'all on-chain sources failed: ' +
        adapterResults.map((r) => r.reason?.message ?? r.reason).join('; ')
    )
  }

  const reference = referenceResult.status === 'fulfilled' ? referenceResult.value.meta : null
  const referencePriceUsd =
    referenceResult.status === 'fulfilled' ? referenceResult.value.priceUsd : null

  // WHY the reference is missing, not just THAT it is. A bare null cannot be
  // told apart from a bug; "yahoo: HTTP 429" is immediately actionable, and
  // "no listed underlying" says the null is correct and permanent.
  const referenceError =
    referenceResult.status === 'fulfilled'
      ? referenceResult.value.error
      : String(referenceResult.reason?.message ?? referenceResult.reason)

  const points = []
  adapterIds.forEach((id, i) => {
    const result = adapterResults[i]
    // A venue that failed is omitted, and the omission is recorded in
    // sourceErrors -- never silently rendered as an empty or zeroed row.
    if (result.status === 'rejected') return
    const { meta: source, ethPriceUSD, tokens } = result.value
    const mod = ADAPTERS[id]
    for (const entry of byAdapter[id]) {
      const raw = tokens.get(entry.address) ?? { token: null, pools: [] }
      const shaped = mod.shapeToken(raw, entry.address, ethPriceUSD, entry.decimals, entry.symbol)
      points.push(
        buildPoint({ address: entry.address, entry, shaped, source, reference, referencePriceUsd })
      )
    }
  })

  const sourceErrors = adapterIds
    .map((id, i) => (adapterResults[i].status === 'rejected'
      ? { adapter: id, error: String(adapterResults[i].reason?.message ?? adapterResults[i].reason) }
      : null))
    .filter(Boolean)

  // Deepest market first: that is the price a reader should weigh most.
  points.sort((a, b) => b.poolTvlUsd - a.poolTvlUsd)

  return {
    ticker,
    referencePriceUsd,
    reference,
    referenceError,
    // Venues that failed this request. Empty array is the normal case.
    sourceErrors,
    points,
    fetchedAt: new Date().toISOString(),
  }
}

export { ADAPTER_ID }
