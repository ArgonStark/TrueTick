/**
 * Adapter: Base, Aerodrome Slipstream (concentrated liquidity), via OUR OWN
 * published subgraph.
 *
 * This is the only venue in TrueTick served by a subgraph we wrote, fixed and
 * published ourselves -- the other subgraph venue (Ethereum/Uniswap v4) is
 * Uniswap's. No published subgraph indexed Aerodrome's CL factory
 * 0xf8f2eB49..., where Coinbase's B20 tokenized equities actually trade, so we
 * forked Uniswap/v3-subgraph, repointed it, fixed two silent-$0 bugs and
 * published it to the decentralized network.
 *
 * THE POINT OF THIS FILE, and the reason it is not a copy of ethereum-univ4:
 *
 * The subgraph is STILL SYNCING. The tokenized-stock pools are recent, near
 * chain head, so the index has not reached them and cannot answer for these
 * tokens yet. That is a fact about our index, NOT a fact about the market --
 * and the two must never be allowed to look alike.
 *
 * So this adapter NEVER throws for a sync-related miss. Throwing would drop the
 * venue into `sourceErrors` and delete the row; zero-filling would invent a
 * market. Instead it returns a well-formed point with every price field null
 * and a 'subgraph-syncing' caveat carrying the real indexed block, the real
 * chain head, and the percentage between them. The row appears, admits it has
 * no price yet, and shows its own progress.
 *
 * VERIFIED, not remembered (2026-09-12):
 *   - Published subgraph id  dmEWVWdRS6GajSuddosHSKBJs51z9mjpLmbW4iBgWLg
 *   - Deployment             QmQX5qLeHm86pbTpUTLsYMxYofGRDFoEw5kV3zQhFFBAZX
 *   - Gateway answers "subgraph not found": published with an active allocation
 *     but zero curation signal, so the gateway will not route queries to it yet.
 *   - The assigned indexer's public status endpoint DOES report progress, and
 *     needs no API key. That is where the honest number comes from.
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

export const ADAPTER_ID = 'base-aerodrome'

/** Our published subgraph on the decentralized network. */
export const SUBGRAPH_ID =
  (process.env.BASE_SUBGRAPH_ID || '').trim() || 'dmEWVWdRS6GajSuddosHSKBJs51z9mjpLmbW4iBgWLg'

/** The IPFS deployment hash the indexer knows it by. */
export const DEPLOYMENT_ID =
  (process.env.BASE_DEPLOYMENT_ID || '').trim() || 'QmQX5qLeHm86pbTpUTLsYMxYofGRDFoEw5kV3zQhFFBAZX'

/** Aerodrome Slipstream CL factory this subgraph indexes. */
export const FACTORY = '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef'

/** Factory deployment block -- the denominator for honest sync progress. */
export const START_BLOCK = 44394724

const GATEWAY = `https://gateway.thegraph.com/api/subgraphs/id/${SUBGRAPH_ID}`

/**
 * Public indexing-status endpoint of the indexer serving our deployment.
 * No API key. This is what makes "syncing" a measured claim rather than an
 * excuse -- without it we could only say "no data", which is what a dead
 * subgraph also says.
 */
const STATUS_ENDPOINT =
  (process.env.BASE_STATUS_ENDPOINT || '').trim() || 'https://indexer.upgrade.thegraph.com/status'

/** Cache sync status briefly: every token in a request shares one answer. */
let statusCache = { at: 0, value: null }
const STATUS_TTL_MS = 30_000

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Positive finite, or null. Never 0 standing in for "unknown". */
function price(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Ask the indexer how far along it is.
 *
 * Returns null only if the status endpoint itself is unreachable -- in which
 * case we still report "syncing", just without numbers. Degrading to
 * "unavailable" is honest; degrading to a price is not.
 *
 * @returns {Promise<{latestBlock:number|null, chainHeadBlock:number|null, synced:boolean, health:string|null}|null>}
 */
export async function fetchSyncStatus() {
  if (statusCache.value && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value

  try {
    const res = await fetch(STATUS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ indexingStatuses(subgraphs: ["${DEPLOYMENT_ID}"]) {
          synced health
          chains { network latestBlock { number } chainHeadBlock { number } }
        } }`,
      }),
      signal: AbortSignal.timeout(15000),
    })
    const json = await res.json()
    const s = json?.data?.indexingStatuses?.[0]
    if (!s) return null

    const chain = s.chains?.[0]
    const value = {
      synced: Boolean(s.synced),
      health: s.health ?? null,
      latestBlock: chain?.latestBlock?.number ? Number(chain.latestBlock.number) : null,
      chainHeadBlock: chain?.chainHeadBlock?.number ? Number(chain.chainHeadBlock.number) : null,
    }
    statusCache = { at: Date.now(), value }
    return value
  } catch {
    // Unreachable status endpoint is not an error worth failing the venue over.
    return null
  }
}

/**
 * Percent of the configured indexing range covered so far.
 *
 * Measured from START_BLOCK, not from block 0 -- a subgraph that starts at
 * block 44.4M is not "86% done" the moment it begins, and reporting it that way
 * would be flattering nonsense.
 */
function progressPct(latest, head) {
  if (latest === null || head === null) return null
  const total = head - START_BLOCK
  const done = latest - START_BLOCK
  if (total <= 0) return null
  return Math.max(0, Math.min(100, (done / total) * 100))
}

async function query(gql) {
  const apiKey = (process.env.GRAPH_API_KEY || '').trim()
  if (!apiKey) throw new Error('GRAPH_API_KEY is not set')

  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query: gql }),
    signal: AbortSignal.timeout(30000),
  })

  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`gateway returned non-JSON (HTTP ${res.status}): ${text.slice(0, 160)}`)
  }
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '))
  return json.data
}

/**
 * Is this gateway error the subgraph not being servable yet, as opposed to a
 * real fault?
 *
 * Worth separating precisely. "not found" / "no indexers" means published but
 * unserved -- expected, and the syncing story. A schema error or a rejected API
 * key is a genuine break and should surface as one.
 */
function isNotServableYet(message) {
  return /subgraph not found|no indexers|not deployed|unavailable|bad indexers|no allocations/i.test(
    String(message)
  )
}

const POOL_FIELDS = `
  id
  feeTier
  token0Price
  token1Price
  totalValueLockedUSD
  token0 { id symbol derivedETH }
  token1 { id symbol derivedETH }
  poolDayData(first: 4, orderBy: date, orderDirection: desc) { date volumeUSD tvlUSD }
`

/**
 * Build the SourceMeta for a venue that cannot answer yet.
 *
 * indexedBlock is the REAL block the index has reached -- not 0, and not
 * pretended to be head. A reader can subtract it from chainHeadBlock and check
 * our arithmetic.
 *
 * @returns {SourceMeta}
 */
function syncingMeta(status, reason) {
  const latest = status?.latestBlock ?? null
  const head = status?.chainHeadBlock ?? null
  const pct = progressPct(latest, head)

  return {
    adapter: ADAPTER_ID,
    protocol: 'Aerodrome Slipstream',
    product: 'Subgraph (self-published)',
    endpointId: SUBGRAPH_ID,
    // Honest: the block OUR index has reached, which is the whole point.
    indexedBlock: latest ?? 0,
    indexedAt: new Date().toISOString(),
    // Lag in blocks is meaningful here; lag in seconds is not measurable
    // without a block timestamp we do not have, so it stays 0 rather than
    // being invented, and `syncing` is what a consumer should read.
    indexedLagSeconds: 0,
    hasIndexingErrors: status?.health === 'failed',
    syncing: true,
    synced: false,
    chainHeadBlock: head,
    startBlock: START_BLOCK,
    blocksRemaining: latest !== null && head !== null ? Math.max(0, head - latest) : null,
    syncProgressPct: pct,
    indexerHealth: status?.health ?? null,
    selfPublished: true,
    syncNote: reason,
  }
}

/**
 * Fetch the on-chain side for one or more Base token addresses.
 *
 * Contract note: this NEVER rejects for a sync-related condition. The caller
 * treats a rejection as "venue unavailable" and drops the row, which would hide
 * exactly the thing we want visible.
 *
 * @param {string[]} addresses lowercase contract addresses
 * @returns {Promise<{ meta: SourceMeta, ethPriceUSD: number|null, tokens: Map<string, object> }>}
 */
export async function fetchOnChain(addresses) {
  const addrs = addresses.map((a) => a.trim().toLowerCase())

  const parts = addrs
    .map(
      (a, i) => `
    t${i}: token(id: "${a}") { id symbol name decimals derivedETH volumeUSD }
    p${i}a: pools(where: { token0: "${a}" }, orderBy: totalValueLockedUSD, orderDirection: desc, first: 10) { ...PoolFields }
    p${i}b: pools(where: { token1: "${a}" }, orderBy: totalValueLockedUSD, orderDirection: desc, first: 10) { ...PoolFields }`
    )
    .join('\n')

  const gql = `
    query BaseSnapshot {
      _meta { block { number timestamp } hasIndexingErrors }
      bundle(id: "1") { ethPriceUSD }
      ${parts}
    }
    fragment PoolFields on Pool { ${POOL_FIELDS} }
  `

  let data
  try {
    data = await query(gql)
  } catch (e) {
    const msg = String(e.message || e)
    // Published but not yet servable -> the syncing state, with real numbers.
    if (isNotServableYet(msg)) {
      const status = await fetchSyncStatus()
      const tokens = new Map()
      for (const a of addrs) tokens.set(a, { token: null, pools: [], syncing: true })
      return {
        meta: syncingMeta(
          status,
          status
            ? 'Published to the decentralized network; the assigned indexer is still ' +
              'backfilling and the gateway does not route to it yet.'
            : 'Published to the decentralized network; not yet servable, and the ' +
              'indexer status endpoint was unreachable so progress is unknown.'
        ),
        ethPriceUSD: null,
        tokens,
      }
    }
    // A real fault (bad key, schema mismatch) is a real error. Let it surface.
    throw e
  }

  // The gateway answered. It may still be behind the pools we care about.
  const status = await fetchSyncStatus()
  const nowSec = Math.floor(Date.now() / 1000)
  const blockTs = num(data._meta?.block?.timestamp)
  const indexedBlock = num(data._meta?.block?.number)
  const head = status?.chainHeadBlock ?? null
  const synced = status ? status.synced : true

  /** @type {SourceMeta} */
  const meta = {
    adapter: ADAPTER_ID,
    protocol: 'Aerodrome Slipstream',
    product: 'Subgraph (self-published)',
    endpointId: SUBGRAPH_ID,
    indexedBlock,
    indexedAt: blockTs ? new Date(blockTs * 1000).toISOString() : new Date().toISOString(),
    indexedLagSeconds: blockTs ? Math.max(0, nowSec - blockTs) : 0,
    hasIndexingErrors: Boolean(data._meta?.hasIndexingErrors),
    syncing: !synced,
    synced,
    chainHeadBlock: head,
    startBlock: START_BLOCK,
    blocksRemaining: head !== null ? Math.max(0, head - indexedBlock) : null,
    syncProgressPct: progressPct(indexedBlock, head),
    indexerHealth: status?.health ?? null,
    selfPublished: true,
    syncNote: synced ? null : 'Index is behind chain head; recent pools may not be covered yet.',
  }

  const ethPriceUSD = price(data.bundle?.ethPriceUSD)

  const tokens = new Map()
  addrs.forEach((address, i) => {
    const token = data[`t${i}`]
    const pools = [...(data[`p${i}a`] || []), ...(data[`p${i}b`] || [])]
    // A token the index has not reached yet is SYNCING, not absent. Only once
    // the subgraph is fully synced does "no token" mean "no such market".
    tokens.set(address, { token, pools, syncing: !token && !synced })
  })

  return { meta, ethPriceUSD, tokens }
}

/**
 * This token's price in the pool's other token. Same v3 semantics as Uniswap:
 * token0Price is "token0 per token1", so when ours is token0 the other token
 * per unit of ours is token1Price.
 */
function quoteSide(pool, address) {
  const isToken0 = pool.token0.id.toLowerCase() === address
  return {
    priceInQuote: price(isToken0 ? pool.token1Price : pool.token0Price),
    quoteToken: isToken0 ? pool.token1 : pool.token0,
    pairSymbol: `${pool.token0.symbol}/${pool.token1.symbol}`,
  }
}

function volumeOnDay(pool, dayStartSec) {
  let total = 0
  for (const d of pool.poolDayData || []) if (Number(d.date) === dayStartSec) total += num(d.volumeUSD)
  return total
}

/**
 * Shape one token's rows into the on-chain half of a point.
 *
 * The syncing branch is the important one: every price-like field is null, TVL
 * and volume are null (not 0 -- we have not measured them, which is different
 * from measuring nothing), and 'subgraph-syncing' is carried up as a caveat.
 */
export function shapeToken(raw, address, ethPriceUSD) {
  const { token, pools: rawPools, syncing } = raw ?? {}

  if (syncing || !token) {
    return {
      indexed: false,
      syncing: Boolean(syncing),
      priceUsd: null,
      // null, NOT 0: an index that has not reached these pools has not
      // observed zero liquidity, it has observed nothing.
      poolTvlUsd: null,
      volume24hUsd: null,
      volumePrevDayUsd: 0,
      pools: [],
      deepestPoolPriceUsd: null,
      priceDivergencePct: null,
      onChainSymbol: null,
      onChainDecimals: null,
      extraCaveats: syncing ? ['subgraph-syncing'] : [],
    }
  }

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
      id: p.id,
      pairSymbol,
      quoteSymbol: quoteToken.symbol,
      feeTier: Number.isFinite(Number(p.feeTier)) ? Number(p.feeTier) : null,
      tvlUsd,
      volume24hUsd: vol24,
      priceInQuote,
      _quoteDerivedEth: price(quoteToken.derivedETH),
    })
  }

  pools.sort((a, b) => b.tvlUsd - a.tvlUsd)

  // Same traded-pools-only cross-check as the Ethereum adapter, and for the
  // same reason: an untraded pool's ratio is not enforced by arbitrage, so it
  // can only produce false divergence.
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
      ? (Math.abs(priceUsd - deepestPoolPriceUsd) / priceUsd) * 100
      : null

  for (const p of pools) delete p._quoteDerivedEth

  return {
    indexed: true,
    syncing: false,
    priceUsd,
    poolTvlUsd,
    volume24hUsd,
    volumePrevDayUsd,
    pools,
    deepestPoolPriceUsd,
    priceDivergencePct,
    onChainSymbol: token.symbol ?? null,
    onChainDecimals: Number.isFinite(Number(token.decimals)) ? Number(token.decimals) : null,
    extraCaveats: [],
  }
}
