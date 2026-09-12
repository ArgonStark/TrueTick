/**
 * Adapter: Ethereum mainnet, Uniswap v4, via The Graph's decentralised network.
 *
 * Produces the on-chain half of a TokenizedStockPoint. Knows about Uniswap v4's
 * schema and nothing else -- issuer, ticker and backing all come from the
 * registry, which is why one adapter serves both Ondo and Backed: they are the
 * same venue, different issuers. A second venue (Aerodrome on Base) is a new
 * adapter, not a change here.
 *
 * SCHEMA NOTES, verified against the live subgraph rather than remembered:
 *   - Token has no USD price. derivedETH x Bundle.ethPriceUSD is the USD price.
 *   - Pool.volumeUSD and Token.volumeUSD are CUMULATIVE since inception. Real
 *     24h volume only comes from PoolDayData rows.
 *   - PoolDayData calls TVL `tvlUSD`; Pool calls it `totalValueLockedUSD`.
 *   - Token.poolCount reads 0 even for tokens that demonstrably have pools, so
 *     it must never be used as a filter or an existence check.
 */

/**
 * @typedef {import('../types.ts').PoolSnapshot} PoolSnapshot
 * @typedef {import('../types.ts').SourceMeta} SourceMeta
 */

try {
  process.loadEnvFile()
} catch {
  /* env may already be exported */
}

/**
 * Uniswap v4 Ethereum mainnet, taken from Uniswap's official subgraph docs.
 * Only ever take this id from Uniswap's own docs -- a wrong-but-valid id
 * authenticates fine and then rejects every field, which reads like a broken
 * query rather than a broken endpoint.
 */
export const SUBGRAPH_ID = 'DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G'
export const ADAPTER_ID = 'ethereum-univ4'

const GATEWAY = `https://gateway.thegraph.com/api/subgraphs/id/${SUBGRAPH_ID}`

const POOL_FIELDS = `
  id
  feeTier
  token0Price
  token1Price
  totalValueLockedUSD
  txCount
  token0 { id symbol derivedETH }
  token1 { id symbol derivedETH }
  poolDayData(first: 4, orderBy: date, orderDirection: desc) {
    date
    volumeUSD
    tvlUSD
  }
`

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Positive finite, or null. Never 0 standing in for "unknown". */
function price(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

async function query(gql, variables = {}) {
  const apiKey = (process.env.GRAPH_API_KEY || '').trim()
  if (!apiKey) {
    throw new Error(
      'GRAPH_API_KEY is not set. Create one free at https://thegraph.com/studio -> API Keys ' +
        'and add it to your local env file.'
    )
  }

  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query: gql, variables }),
    signal: AbortSignal.timeout(30000),
  })

  // The gateway answers auth and schema failures with HTTP 200 and an `errors`
  // array, so res.ok proves nothing. Always inspect the body.
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`gateway returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }

  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join('; ')
    if (/auth error|api key/i.test(msg)) throw new Error(`gateway rejected the API key: ${msg}`)
    if (/no field|cannot query field|unknown field/i.test(msg)) {
      throw new Error(
        `schema mismatch against ${SUBGRAPH_ID}: ${msg.slice(0, 300)} ` +
          `(dump the real schema with: node graph-price.mjs --introspect ${SUBGRAPH_ID})`
      )
    }
    throw new Error(`gateway errors: ${msg}`)
  }
  return json.data
}

/**
 * This token's price expressed in the pool's other token.
 *
 * v4 schema semantics: token0Price is "token0 per token1", token1Price is
 * "token1 per token0". So when our token is token0, the amount of the OTHER
 * token per unit of ours is token1Price. Reversing this silently inverts the
 * price -- 0.0044 instead of 225 -- which still looks like a number.
 */
function quoteSide(pool, address) {
  const isToken0 = pool.token0.id.toLowerCase() === address
  return {
    priceInQuote: price(isToken0 ? pool.token1Price : pool.token0Price),
    quoteToken: isToken0 ? pool.token1 : pool.token0,
    pairSymbol: `${pool.token0.symbol}/${pool.token1.symbol}`,
  }
}

/**
 * Volume for a specific UTC day, summed from the day rows.
 *
 * PoolDayData rows exist ONLY for days a pool actually traded. So the newest
 * row is not necessarily today -- on a quiet pool it can be months old.
 * Matching on the exact day boundary is what stops a stale row being reported
 * as "24h volume", which would hide a dead pool behind a real-looking number.
 */
function volumeOnDay(pool, dayStartSec) {
  let total = 0
  for (const d of pool.poolDayData || []) {
    if (Number(d.date) === dayStartSec) total += num(d.volumeUSD)
  }
  return total
}

/**
 * Fetch the on-chain side for one or more token addresses in a single request.
 *
 * Batched via GraphQL aliases: a comparison row needs several tokens, and one
 * request keeps us inside the gateway's rate limits and guarantees every token
 * is read at the SAME indexed block -- otherwise two issuers could be compared
 * across different blocks, which is a subtly wrong comparison.
 *
 * @param {string[]} addresses lowercase contract addresses
 * @returns {Promise<{ meta: SourceMeta, ethPriceUSD: number|null, tokens: Map<string, object> }>}
 */
export async function fetchOnChain(addresses) {
  const addrs = addresses.map((a) => a.trim().toLowerCase())

  const parts = addrs
    .map(
      (a, i) => `
    t${i}: token(id: "${a}") { id symbol name decimals derivedETH totalValueLockedUSD volumeUSD txCount }
    p${i}a: pools(where: { token0: "${a}" }, orderBy: totalValueLockedUSD, orderDirection: desc, first: 10) { ...PoolFields }
    p${i}b: pools(where: { token1: "${a}" }, orderBy: totalValueLockedUSD, orderDirection: desc, first: 10) { ...PoolFields }`
    )
    .join('\n')

  const gql = `
    query Snapshot {
      _meta { block { number timestamp } hasIndexingErrors }
      bundle(id: "1") { ethPriceUSD }
      ${parts}
    }
    fragment PoolFields on Pool { ${POOL_FIELDS} }
  `

  const data = await query(gql)

  const nowSec = Math.floor(Date.now() / 1000)
  const blockTs = num(data._meta?.block?.timestamp)

  /** @type {SourceMeta} */
  const meta = {
    adapter: ADAPTER_ID,
    protocol: 'Uniswap v4',
    product: 'Subgraph',
    endpointId: SUBGRAPH_ID,
    indexedBlock: num(data._meta?.block?.number),
    indexedAt: new Date(blockTs * 1000).toISOString(),
    indexedLagSeconds: Math.max(0, nowSec - blockTs),
    hasIndexingErrors: Boolean(data._meta?.hasIndexingErrors),
  }

  const ethPriceUSD = price(data.bundle?.ethPriceUSD)

  const tokens = new Map()
  addrs.forEach((address, i) => {
    const token = data[`t${i}`]
    const pools = [...(data[`p${i}a`] || []), ...(data[`p${i}b`] || [])]
    tokens.set(address, { token, pools })
  })

  return { meta, ethPriceUSD, tokens }
}

/**
 * Turn the raw subgraph rows for one token into the on-chain half of a point.
 *
 * @returns {{
 *   indexed: boolean,
 *   priceUsd: number|null,
 *   poolTvlUsd: number,
 *   volume24hUsd: number,
 *   volumePrevDayUsd: number,
 *   pools: PoolSnapshot[],
 *   deepestPoolPriceUsd: number|null,
 *   priceDivergencePct: number|null,
 *   onChainSymbol: string|null,
 *   onChainDecimals: number|null
 * }}
 */
export function shapeToken(raw, address, ethPriceUSD) {
  const { token, pools: rawPools } = raw

  if (!token) {
    return {
      indexed: false,
      priceUsd: null,
      poolTvlUsd: 0,
      volume24hUsd: 0,
      volumePrevDayUsd: 0,
      pools: [],
      deepestPoolPriceUsd: null,
      priceDivergencePct: null,
      onChainSymbol: null,
      onChainDecimals: null,
    }
  }

  // DERIVED: v4 exposes no USD price on Token. derivedETH is the price in
  // native-ETH terms; Bundle.ethPriceUSD converts it. If either side is
  // missing the answer is null, not 0.
  const derivedEth = price(token.derivedETH)
  const priceUsd = derivedEth !== null && ethPriceUSD !== null ? derivedEth * ethPriceUSD : null

  const nowSec = Math.floor(Date.now() / 1000)
  const todayStart = Math.floor(nowSec / 86400) * 86400
  const yesterdayStart = todayStart - 86400

  /** @type {PoolSnapshot[]} */
  const pools = []
  let poolTvlUsd = 0
  let volume24hUsd = 0
  let volumePrevDayUsd = 0

  for (const p of rawPools) {
    const { priceInQuote, quoteToken, pairSymbol } = quoteSide(p, address)
    const tvlUsd = num(p.totalValueLockedUSD)
    const vol24 = volumeOnDay(p, todayStart)
    const volPrev = volumeOnDay(p, yesterdayStart)

    poolTvlUsd += tvlUsd
    volume24hUsd += vol24
    volumePrevDayUsd += volPrev

    pools.push({
      // 32-byte pool id on v4, not a 20-byte address. Consumers must not
      // assume this is an address or try to look it up as a contract.
      id: p.id,
      pairSymbol,
      quoteSymbol: quoteToken.symbol,
      feeTier: Number.isFinite(Number(p.feeTier)) ? Number(p.feeTier) : null,
      tvlUsd,
      volume24hUsd: vol24,
      priceInQuote,
      // Kept out of PoolSnapshot's contract but useful for the divergence
      // check below; stripped before the point is returned.
      _quoteDerivedEth: price(quoteToken.derivedETH),
    })
  }

  pools.sort((a, b) => b.tvlUsd - a.tvlUsd)

  /**
   * Independent cross-check of the headline price.
   *
   * A pool's own ratio is a second, unrelated path to a USD price:
   * (our token per quote token) x (quote token in ETH) x (ETH in USD). If it
   * disagrees badly with the derivedETH price, one of the two paths is broken
   * -- exactly the class of silent error this project keeps hitting.
   *
   * TRADED pools only, and that qualifier is the whole point. Picking simply
   * the deepest pool by TVL compared SPCXon against an untraded ASTEROID/SPCXon
   * memecoin pair holding $29k and reported a 4.97% divergence that was purely
   * an artefact of the reference pool, not a fault in the price. Only a pool
   * with recent trades has a price that arbitrage actually enforces, so only
   * such a pool can falsify anything. If nothing traded, there is no
   * independent check to make -- and phantom-liquidity already covers that.
   */
  const traded = pools.filter((p) => p.volume24hUsd > 0)
  const crossCheckPool = (traded.length ? traded : pools).find(
    (p) => p.priceInQuote !== null && p._quoteDerivedEth !== null && p.tvlUsd > 0
  )
  const deepestPoolPriceUsd =
    crossCheckPool && ethPriceUSD !== null
      ? crossCheckPool.priceInQuote * crossCheckPool._quoteDerivedEth * ethPriceUSD
      : null

  const priceDivergencePct =
    priceUsd !== null && deepestPoolPriceUsd !== null && priceUsd > 0
      ? Math.abs(priceUsd - deepestPoolPriceUsd) / priceUsd * 100
      : null

  for (const p of pools) delete p._quoteDerivedEth

  return {
    indexed: true,
    priceUsd,
    poolTvlUsd,
    volume24hUsd,
    volumePrevDayUsd,
    pools,
    deepestPoolPriceUsd,
    priceDivergencePct,
    onChainSymbol: token.symbol ?? null,
    onChainDecimals: Number.isFinite(Number(token.decimals)) ? Number(token.decimals) : null,
  }
}
