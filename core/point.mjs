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
import { fetchOnChain, shapeToken, ADAPTER_ID } from './adapters/ethereum-univ4.mjs'
import { getReferencePriceCached } from './reference-price.mjs'

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
}) {
  /** @type {string[]} */
  const caveats = []

  if (poolCount === 0) caveats.push('no-pools')

  // Phantom liquidity: capital sitting in pools that nobody trades against.
  // Judged over today AND yesterday so a quiet morning is not mistaken for a
  // dead market.
  const recentVolume = volume24hUsd + volumePrevDayUsd
  const phantomLiquidity = poolTvlUsd > 0 && recentVolume === 0
  if (phantomLiquidity) caveats.push('phantom-liquidity')
  else if (poolCount > 0 && recentVolume < THRESHOLDS.thinVolumeUsd) caveats.push('thin-volume')

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
  })

  return {
    ticker: entry.ticker,
    issuer: ISSUERS[entry.issuer]?.wrapper ?? entry.issuer,
    chain: entry.chain,
    chainId: entry.chainId,
    tokenAddress: address,
    symbol: entry.symbol,
    decimals: entry.decimals,

    priceUsd,
    poolTvlUsd: shaped.poolTvlUsd,
    volume24hUsd: shaped.volume24hUsd,

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
      points: [],
      fetchedAt: new Date().toISOString(),
    }
  }

  // Every entry for a ticker shares an underlying, so one reference fetch
  // serves them all. referenceSymbol is null for tokens with no listed
  // underlying (SpaceX), and that null flows through to a null deviation.
  const referenceSymbol = entries.find((e) => e.referenceSymbol)?.referenceSymbol ?? null

  // On-chain and reference fetches are independent -- run them together, and
  // let either fail without taking the other down.
  const [onChainResult, referenceResult] = await Promise.allSettled([
    fetchOnChain(entries.map((e) => e.address)),
    getReferencePriceCached(referenceSymbol),
  ])

  if (onChainResult.status === 'rejected') {
    // The on-chain side is the product. Without it there is no point to return,
    // so this surfaces as an error rather than a row full of nulls pretending
    // to be data.
    throw new Error(`on-chain fetch failed: ${onChainResult.reason?.message ?? onChainResult.reason}`)
  }

  const { meta: source, ethPriceUSD, tokens } = onChainResult.value

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

  const points = entries.map((entry) => {
    const raw = tokens.get(entry.address) ?? { token: null, pools: [] }
    const shaped = shapeToken(raw, entry.address, ethPriceUSD)
    return buildPoint({ address: entry.address, entry, shaped, source, reference, referencePriceUsd })
  })

  // Deepest market first: that is the price a reader should weigh most.
  points.sort((a, b) => b.poolTvlUsd - a.poolTvlUsd)

  return {
    ticker,
    referencePriceUsd,
    reference,
    referenceError,
    points,
    fetchedAt: new Date().toISOString(),
  }
}

export { ADAPTER_ID }
