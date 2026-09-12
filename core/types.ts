/**
 * TrueTick internal normalized schema.
 *
 * THE shared contract. Every source adapter -- Ethereum/Ondo via Uniswap v4
 * today, Base/Aerodrome once our subgraph syncs, Substreams later -- produces
 * exactly this shape. Adding a source is a new adapter, never a change here.
 * If a source cannot fill a field, it sets null and records why in `quality`.
 *
 * Types only. Nothing here is executed, so the project needs no build step;
 * adapters are .mjs and reference these via JSDoc @typedef imports.
 */

// ---------------------------------------------------------------- identity --

/**
 * Which VENUE produced the on-chain side of a point -- not which issuer.
 *
 * Issuer is registry metadata, deliberately separate: Ondo and Backed both
 * trade on Uniswap v4 Ethereum, so one adapter serves both. Naming an adapter
 * after an issuer would have forced a pointless second copy of it.
 */
export type AdapterId =
  | 'ethereum-univ4'
  | 'base-aerodrome'
  | (string & {}) // future adapters, without widening to bare string

export type MarketSession = 'regular' | 'pre' | 'post' | 'closed'

// --------------------------------------------------------------- sub-shapes --

/**
 * Where the reference (real-world) price came from, and how much to trust it.
 *
 * Tokenized stocks trade 24/7; the underlying does not. Off-hours the reference
 * is a stale last-trade, so a large deviation is usually the token pricing in
 * news since the close -- NOT a mispricing to arb. Consumers need session and
 * age to tell those apart, so they are part of the contract, not extras.
 */
export interface ReferenceMeta {
  /** Provider id, e.g. 'yahoo-chart' | 'finnhub'. */
  source: string
  /** Ticker queried at the provider, e.g. 'NVDA'. */
  symbol: string
  /** ISO time the quote itself is stamped with (not when we fetched it). */
  asOf: string
  /** Age of that quote in seconds at fetch time. */
  ageSeconds: number
  session: MarketSession
  marketOpen: boolean
  /** Previous regular-session close, when the provider gives one. */
  previousCloseUsd: number | null
}

/** Provenance and liveness of the on-chain side. */
export interface SourceMeta {
  adapter: AdapterId
  /** Subgraph id, Substreams package, etc. */
  endpointId: string
  /** Block the index had reached when we queried. */
  indexedBlock: number
  indexedAt: string
  /** How far the index trails chain head. The liveness proof. */
  indexedLagSeconds: number
  hasIndexingErrors: boolean
}

/** One pool backing the price, kept so a consumer can audit the number. */
export interface PoolSnapshot {
  /** 20-byte address (v3/Aerodrome) or 32-byte pool id (v4). Do not assume. */
  id: string
  pairSymbol: string
  quoteSymbol: string
  feeTier: number | null
  /**
   * Null when the source cannot observe reserves. An event-stream source
   * (Substreams) sees swaps, not pool state, so TVL is genuinely unknown there
   * -- null, never 0.
   */
  tvlUsd: number | null
  volume24hUsd: number
  /** Price of our token denominated in the pool's other token. */
  priceInQuote: number | null
}

/**
 * Legal wrapper / backing. Editorial metadata about the issuer's structure,
 * NOT live data -- so it carries its own provenance and must never be presented
 * with the same confidence as an on-chain read.
 */
export interface BackingNote {
  /** Legal issuing entity, e.g. 'Ondo Global Markets'. */
  wrapper: string
  jurisdiction: string | null
  /** e.g. '1:1 against shares held with a custodian'. */
  backing: string
  /** Whether holders can redeem for the underlying, and under what conditions. */
  redemption: string
  /** Allowlists, prohibited persons, US-person limits. */
  transferRestrictions: string
  /** URL the above was read from. */
  sourceUrl: string
  /** When a human last checked it. */
  checkedAt: string
}

/**
 * Why a number may not mean what it appears to.
 *
 * The failure mode this whole project has been avoiding is a plausible-looking
 * $0 or a confident-looking deviation computed from junk. Rather than hide such
 * cases, compute them and mark them.
 */
export interface Quality {
  /** Safe to show a user as a real market price. */
  priceReliable: boolean
  /** Safe to act on. False off-hours, on stale references, on dead pools. */
  deviationReliable: boolean
  /** Pools hold TVL but effectively no recent trading. */
  phantomLiquidity: boolean
  /** Machine-readable reasons, e.g. 'market-closed', 'no-reference-price'. */
  caveats: QualityCaveat[]
}

export type QualityCaveat =
  /** US market is not in its regular session. Deviation is news, not arbitrage. */
  | 'market-closed'
  /** Market is open but the reference quote is old -- also catches holidays. */
  | 'reference-stale'
  | 'no-reference-price'
  /** TVL present, but nothing traded today or yesterday. */
  | 'phantom-liquidity'
  | 'thin-volume'
  | 'no-pools'
  | 'indexing-errors'
  | 'index-lagging'
  /**
   * The two independent on-chain price paths (derivedETH vs the deepest pool's
   * own ratio) disagree by more than the threshold, so one of them is broken.
   */
  | 'price-divergence'
  /** Registry decimals disagree with the chain -- a registry bug, not a market event. */
  | 'decimals-mismatch'
  /**
   * The venue could not be read (timeout, partial scan). Distinct from
   * 'no-pools': this says we do not KNOW, not that the market is empty.
   */
  | 'source-error'
  /**
   * This source reads events, not contract state, so pool reserves are not
   * observable. Informational -- it does not impugn the price.
   */
  | 'tvl-unavailable'
  /**
   * Volume was measured over less than a day, so `volume24hUsd` is null and the
   * real figure sits in `volumeUsd` / `volumeWindowHours`.
   */
  | 'volume-window-short'
  | (string & {})

// ------------------------------------------------------------- the contract --

/**
 * One tokenized stock, on one venue, at one moment.
 *
 * A "row" of the deviation table is several of these for the same `ticker`
 * across different issuers/chains.
 *
 * NULL vs ZERO: every price-like field is `number | null`. A missing price is
 * null, never 0. This is deliberate -- a 0 propagates silently through
 * arithmetic and renders as a real price, which is exactly how the two subgraph
 * bugs would have shipped unnoticed. null forces the consumer to handle it.
 */
export interface TokenizedStockPoint {
  // --- identity ---
  /** Underlying ticker, e.g. 'NVDA'. The join key across issuers. */
  ticker: string
  /** e.g. 'Ondo', 'Coinbase'. */
  issuer: string
  /** e.g. 'ethereum', 'base'. */
  chain: string
  chainId: number
  tokenAddress: string
  /** On-chain symbol, e.g. 'NVDAon' -- distinct from `ticker`. */
  symbol: string
  /**
   * Per TOKEN, never per chain. Ondo is 18, Coinbase B20 is 8. Subgraph
   * BigDecimal fields are already decimal-adjusted; this matters for raw
   * on-chain reads and any raw-amount conversion.
   */
  decimals: number

  // --- on-chain market ---
  priceUsd: number | null
  /** Null when the source cannot observe reserves. See PoolSnapshot.tvlUsd. */
  poolTvlUsd: number | null
  /**
   * Null when the source did not measure a full day. A shorter measurement is
   * reported in `volumeUsd` with its window in `volumeWindowHours` -- a 34-minute
   * figure must never be presented as a day's volume.
   */
  volume24hUsd: number | null
  /** Volume over the window actually measured, whatever that window was. */
  volumeUsd?: number | null
  /** Length of the window behind `volumeUsd`, in hours. */
  volumeWindowHours?: number | null

  // --- reference & deviation ---
  referencePriceUsd: number | null
  /** (onchain - reference) / reference * 100. Null if either side is null. */
  deviationPct: number | null
  deviationAbsUsd: number | null

  // --- liveness (flattened for convenience; full detail in `source`) ---
  indexedBlock: number
  indexedLagSeconds: number

  // --- grouped detail ---
  reference: ReferenceMeta | null
  source: SourceMeta
  pools: PoolSnapshot[]
  backing: BackingNote
  quality: Quality

  /** When this point was assembled. */
  fetchedAt: string
}

/** What a `/price/:ticker` style call returns: one row, many venues. */
export interface TickerComparison {
  ticker: string
  referencePriceUsd: number | null
  reference: ReferenceMeta | null
  /**
   * Why the reference price is missing, when it is. A bare null cannot be
   * distinguished from a bug; this says whether the provider failed
   * ('yahoo: HTTP 429') or whether no listed underlying exists at all, in
   * which case the null is correct and permanent.
   */
  referenceError: string | null
  points: TokenizedStockPoint[]
  fetchedAt: string
}
