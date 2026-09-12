/**
 * Adapter: Robinhood Chain (chainId 4663), Uniswap V3, read over plain RPC.
 *
 * WHY THIS ONE IS NOT THE GRAPH -- read this before judging it.
 *
 * Robinhood Chain has NO published subgraph. The Graph's own networks registry
 * lists `"subgraphs": []` for eip155:4663 -- only Firehose and Substreams. So
 * forking a subgraph, as we did for Base, is not slow here: it is unavailable.
 * The Graph-native route is a Substreams pipeline, which needs a Rust toolchain,
 * a separate Graph Market credential, and hours we did not have before the demo.
 *
 * So this one venue is read directly from the chain, and it says so: the adapter
 * id is `robinhood-rpc` and endpointId is the RPC host, so any consumer can see
 * this row did not come from The Graph. Ethereum remains the Graph-backed
 * source. Substreams is the intended upgrade for this adapter, and replacing it
 * changes only this file.
 *
 * MECHANICS
 *   - Pool discovery: Uniswap V3 `PoolCreated` indexes token0 and token1, so
 *     pools for a token are fetched with a topic filter instead of scanning.
 *   - Price: from the pool's own `slot0.sqrtPriceX96`, which IS the current
 *     price -- no indexing, no lag, no backfill.
 *   - Volume: `Swap` events over the last 24h of blocks.
 *   - Batching: Multicall3 (deployed at the canonical address here), so a whole
 *     token's pool set costs a couple of RPC round trips rather than hundreds.
 */

/**
 * @typedef {import('../types.ts').PoolSnapshot} PoolSnapshot
 * @typedef {import('../types.ts').SourceMeta} SourceMeta
 */

import { ethers } from 'ethers'

try {
  process.loadEnvFile()
} catch {
  /* env may already be exported; this adapter needs no key */
}

export const ADAPTER_ID = 'robinhood-rpc'
export const CHAIN_ID = 4663

/**
 * Pinax's RPC, not the public one. The public endpoint
 * (rpc.mainnet.chain.robinhood.com) refuses eth_getLogs on any useful range,
 * which makes pool discovery impossible; Pinax serves multi-million-block
 * ranges. Override with ROBINHOOD_RPC_URL if this ever changes.
 */
export const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://robinhood.rpc.service.pinax.network'

const FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa'
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

/**
 * USDG ("Global Dollar"), 6 decimals -- the chain's USD quote asset.
 *
 * ASSUMPTION, stated rather than buried: USDG is treated as exactly $1. It is a
 * USD stablecoin, but we do not verify its peg, so every USD figure from this
 * adapter inherits that assumption. If USDG were to depeg, these prices would be
 * wrong in proportion. Ethereum's adapter does not share this assumption -- it
 * derives USD through ETH.
 */
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const USDG_DECIMALS = 6

/** Measured 2026-09-10: ~0.101s/block. Used only to size the 24h window. */
const BLOCKS_PER_24H = 855_785

const POOL_CREATED = ethers.id('PoolCreated(address,address,uint24,int24,address)')
const SWAP = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)')

const erc20 = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])
const poolAbi = new ethers.Interface([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function liquidity() view returns (uint128)',
])
const multicallAbi = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
])

const coder = ethers.AbiCoder.defaultAbiCoder()
const pad32 = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')

let _provider = null
function provider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, {
      staticNetwork: true,
      batchMaxCount: 1,
    })
  }
  return _provider
}

/** Positive finite, or null. Never 0 standing in for "unknown". */
function price(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Batch calls through Multicall3 so a token costs round trips, not hundreds. */
async function multicall(calls) {
  if (!calls.length) return []
  const out = []
  const BATCH = 200
  for (let i = 0; i < calls.length; i += BATCH) {
    const slice = calls.slice(i, i + BATCH)
    const data = multicallAbi.encodeFunctionData('aggregate3', [
      slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData })),
    ])
    const res = await provider().call({ to: MULTICALL3, data })
    out.push(...multicallAbi.decodeFunctionResult('aggregate3', res)[0])
  }
  return out
}

/**
 * Uniswap V3 price from sqrtPriceX96, kept in BigInt until the final divide.
 *
 * price(token0 in token1) = (sqrtPriceX96 / 2^96)^2 * 10^dec0 / 10^dec1
 *
 * Done in floating point this loses precision badly for a 6-decimal quote
 * against an 18-decimal token, so the whole ratio is computed as integers and
 * scaled by 1e18 once at the end.
 */
function priceToken0InToken1(sqrtPriceX96, dec0, dec1) {
  try {
    const sqrt = BigInt(sqrtPriceX96)
    if (sqrt <= 0n) return null
    const num = sqrt * sqrt * 10n ** BigInt(dec0) * 10n ** 18n
    const den = 2n ** 192n * 10n ** BigInt(dec1)
    const scaled = num / den
    const v = Number(scaled) / 1e18
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

/**
 * Pool discovery cache. Pools are created once and never move, so re-scanning
 * history on every request is pure waste -- and it is what makes the UI feel
 * instant on the second load.
 */
const poolCache = new Map()
const POOL_CACHE_TTL_MS = 10 * 60 * 1000

/** Run tasks with bounded concurrency; the node 504s if we fan out too wide. */
async function pooled(tasks, limit = 4) {
  const out = []
  let i = 0
  async function worker() {
    while (i < tasks.length) {
      const idx = i++
      out[idx] = await tasks[idx]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return out
}

/**
 * Every USDG-quoted pool for one token, via indexed topics.
 *
 * CHUNKED DELIBERATELY. A single fromBlock:0 -> latest query returns
 * "504 Gateway Timeout" on a 59M-block chain -- and the first version of this
 * adapter did exactly that, swallowed the error, and reported the token as
 * having NO POOLS. A failed read that renders as "nothing here" is the same
 * class of bug as a null rendering as $0, so the failure is now surfaced.
 *
 * @returns {Promise<{pools: Array<object>, windowsFailed: number, windowsTotal: number}>}
 */
async function poolsForToken(address, head) {
  const cached = poolCache.get(address)
  if (cached && Date.now() - cached.at < POOL_CACHE_TTL_MS) return cached.value

  // 10M-block windows answer in ~400ms each. Wider (full range) 504s; narrower
  // just multiplies round trips. Concurrency 2 -- fanning out to 4 also 504s,
  // and a 504 here previously surfaced as a false "no pools".
  const CHUNK = 10_000_000
  const ranges = []
  for (let to = head; to > 0; to -= CHUNK) ranges.push([Math.max(0, to - CHUNK + 1), to])

  let windowsFailed = 0
  const scan = (topics) =>
    ranges.map(([from, to]) => async () => {
      try {
        return await provider().send('eth_getLogs', [{
          address: FACTORY, topics,
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + to.toString(16),
        }])
      } catch {
        windowsFailed++
        return []
      }
    })

  const batches = await pooled(
    // Uniswap orders token0 < token1 by ADDRESS, so which side USDG sits on
    // differs per token (USDG 0x5fc5... is token0 for NVDA 0xd060..., but
    // token1 for a token sorting below it). Both directions are always scanned
    // -- assuming one would silently return zero pools for half the registry.
    [...scan([POOL_CREATED, pad32(address), pad32(USDG)]), ...scan([POOL_CREATED, pad32(USDG), pad32(address)])],
    2
  )

  const pools = batches.flat().map((log) => {
    const [, pool] = coder.decode(['int24', 'address'], log.data)
    const token0 = ('0x' + log.topics[1].slice(26)).toLowerCase()
    const token1 = ('0x' + log.topics[2].slice(26)).toLowerCase()
    return {
      pool: pool.toLowerCase(),
      token0,
      token1,
      fee: Number(BigInt(log.topics[3])),
      /** true when OUR token is token0 and USDG is token1 */
      ourTokenIsToken0: token0 === address.toLowerCase(),
    }
  })

  const value = { pools, windowsFailed, windowsTotal: ranges.length * 2 }
  // Only cache a clean scan; a partial one must be retried, not remembered.
  if (windowsFailed === 0) poolCache.set(address, { at: Date.now(), value })
  return value
}

/**
 * 24h swap volume per pool, measured in USDG.
 *
 * One eth_getLogs across all of the token's pools at once. Volume is the
 * absolute USDG amount moved, which is the honest read of "how much traded" --
 * and it is what separates a real market from parked capital.
 */
async function volume24hByPool(poolAddresses, fromBlock, head) {
  if (!poolAddresses.length) return { totals: {}, windowsFailed: 0, windowsTotal: 0 }

  // 855k blocks at 0.1s/block. Asked in one shot the node answers 504, so the
  // window is split. A failed window is counted, never silently treated as
  // "no trades" -- zero volume is what triggers the phantom-liquidity flag, so
  // a swallowed timeout here would libel a healthy market as dead.
  const CHUNK = 150_000
  const ranges = []
  for (let to = head; to > fromBlock; to -= CHUNK) ranges.push([Math.max(fromBlock, to - CHUNK + 1), to])

  let windowsFailed = 0
  const tasks = ranges.map(([from, to]) => async () => {
    try {
      return await provider().send('eth_getLogs', [{
        address: poolAddresses,
        topics: [SWAP],
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
      }])
    } catch {
      windowsFailed++
      return []
    }
  })

  const batches = await pooled(tasks, 3)

  const totals = {}
  for (const log of batches.flat()) {
    const addr = log.address.toLowerCase()
    try {
      const [amount0, amount1] = coder.decode(['int256', 'int256', 'uint160', 'uint128', 'int24'], log.data)
      totals[addr] ||= { swaps: 0, a0: 0n, a1: 0n }
      totals[addr].swaps++
      totals[addr].a0 += amount0 < 0n ? -amount0 : amount0
      totals[addr].a1 += amount1 < 0n ? -amount1 : amount1
    } catch {
      /* a malformed log must not sink the whole read */
    }
  }
  return { totals, windowsFailed, windowsTotal: ranges.length }
}

/**
 * Same signature as the Ethereum adapter so the two are interchangeable.
 *
 * @param {string[]} addresses lowercase token contract addresses
 * @returns {Promise<{ meta: SourceMeta, ethPriceUSD: number|null, tokens: Map<string, object> }>}
 */
/**
 * Result cache.
 *
 * The 24h volume read is the expensive part: NVDA's main pool alone emits
 * ~94,000 Swap events a day and the node has to return every one of them, so a
 * cold read costs ~75s. Nothing else here is slow. A short TTL keeps the served
 * numbers honest while making every request after the first instant -- and
 * `npm run robinhood:warm` primes it before a demo.
 *
 * Deliberately NOT a longer TTL: these are live prices, and a stale price
 * presented as live is the thing this project refuses to do.
 */
const resultCache = new Map()
const RESULT_TTL_MS = 90_000

export async function fetchOnChain(addresses) {
  const addrs = addresses.map((a) => a.trim().toLowerCase())
  const p = provider()

  const cacheKey = addrs.slice().sort().join(',')
  const hit = resultCache.get(cacheKey)
  if (hit && Date.now() - hit.at < RESULT_TTL_MS) return hit.value

  const head = await p.getBlockNumber()
  const block = await p.getBlock(head)
  const nowSec = Math.floor(Date.now() / 1000)
  const fromBlock = Math.max(0, head - BLOCKS_PER_24H)

  /** @type {SourceMeta} */
  const meta = {
    adapter: ADAPTER_ID,
    // Deliberately the RPC host: this row is NOT from The Graph and must not
    // be able to masquerade as though it were.
    endpointId: RPC_URL,
    indexedBlock: head,
    indexedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    // Direct chain read, so "lag" is the age of the head block -- effectively
    // zero. There is no index to fall behind.
    indexedLagSeconds: Math.max(0, nowSec - Number(block.timestamp)),
    hasIndexingErrors: false,
  }

  const tokens = new Map()

  for (const address of addrs) {
    try {
      const { pools, windowsFailed, windowsTotal } = await poolsForToken(address, head)

      if (!pools.length) {
        // Distinguish "scanned cleanly, genuinely no pools" from "the scan
        // failed so we do not know". Reporting the second as the first is a lie.
        tokens.set(address, {
          pools: [],
          found: windowsFailed === 0,
          error: windowsFailed
            ? `pool discovery incomplete: ${windowsFailed}/${windowsTotal} block ranges failed`
            : null,
        })
        continue
      }

      const poolAddresses = pools.map((x) => x.pool)

      // slot0 + both balances for every pool, in one batched round trip.
      const calls = pools.flatMap((x) => [
        { target: x.pool, callData: poolAbi.encodeFunctionData('slot0') },
        { target: USDG, callData: erc20.encodeFunctionData('balanceOf', [x.pool]) },
        { target: address, callData: erc20.encodeFunctionData('balanceOf', [x.pool]) },
      ])
      const [results, volume] = await Promise.all([
        multicall(calls),
        volume24hByPool(poolAddresses, fromBlock, head),
      ])
      const volumes = volume.totals

      pools.forEach((x, i) => {
        const slotRes = results[i * 3]
        const usdgRes = results[i * 3 + 1]
        const tokRes = results[i * 3 + 2]

        let sqrtPriceX96 = null
        try {
          if (slotRes?.success) sqrtPriceX96 = poolAbi.decodeFunctionResult('slot0', slotRes.returnData)[0]
        } catch { /* unreadable pool stays null */ }

        const bal = (r) => {
          try { return r?.success ? erc20.decodeFunctionResult('balanceOf', r.returnData)[0] : 0n } catch { return 0n }
        }
        x.usdgBalance = Number(ethers.formatUnits(bal(usdgRes), USDG_DECIMALS))
        x.tokenBalance = Number(ethers.formatUnits(bal(tokRes), 18))
        x.sqrtPriceX96 = sqrtPriceX96

        const v = volumes[x.pool]
        // The USDG side of each swap is the volume figure we want.
        const usdgRaw = v ? (x.ourTokenIsToken0 ? v.a1 : v.a0) ?? 0n : 0n
        x.volume24hUsd = Number(ethers.formatUnits(usdgRaw, USDG_DECIMALS))
        x.swaps24h = v?.swaps ?? 0
      })

      const problems = []
      if (windowsFailed) problems.push(`pool discovery partial: ${windowsFailed}/${windowsTotal} ranges failed`)
      if (volume.windowsFailed) {
        problems.push(`24h volume incomplete: ${volume.windowsFailed}/${volume.windowsTotal} ranges failed`)
      }

      tokens.set(address, {
        pools,
        found: true,
        // Volume drives the phantom-liquidity judgement, so an incomplete
        // volume read has to be admitted rather than rounded down to zero.
        error: problems.length ? problems.join('; ') : null,
      })
    } catch (e) {
      tokens.set(address, { pools: [], found: false, error: String(e.message || e) })
    }
  }

  // ETH is not the pricing route on this chain -- USDG is. Returned for
  // signature compatibility only; shapeToken here never uses it.
  const value = { meta, ethPriceUSD: null, tokens }
  resultCache.set(cacheKey, { at: Date.now(), value })
  return value
}

/**
 * Same signature and return shape as the Ethereum adapter's shapeToken.
 */
export function shapeToken(raw, address, _ethPriceUSD, decimals = 18) {
  const empty = {
    sourceError: raw?.error ?? null,
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
  if (!raw || !raw.found || !raw.pools.length) return empty

  /** @type {PoolSnapshot[]} */
  const pools = []
  let poolTvlUsd = 0
  let volume24hUsd = 0

  for (const x of raw.pools) {
    const p0 = priceToken0InToken1(
      x.sqrtPriceX96 ?? 0n,
      x.ourTokenIsToken0 ? decimals : USDG_DECIMALS,
      x.ourTokenIsToken0 ? USDG_DECIMALS : decimals
    )
    // USDG per unit of our token, whichever side we sit on.
    const priceInQuote = p0 === null ? null : x.ourTokenIsToken0 ? p0 : 1 / p0

    // USDG is treated as $1 (see the note at the top of this file).
    const tvlUsd = x.usdgBalance + (priceInQuote !== null ? x.tokenBalance * priceInQuote : 0)

    poolTvlUsd += tvlUsd
    volume24hUsd += x.volume24hUsd

    pools.push({
      id: x.pool,
      pairSymbol: x.ourTokenIsToken0 ? 'TOKEN/USDG' : 'USDG/TOKEN',
      quoteSymbol: 'USDG',
      feeTier: Number.isFinite(x.fee) ? x.fee : null,
      tvlUsd,
      volume24hUsd: x.volume24hUsd,
      priceInQuote,
    })
  }

  pools.sort((a, b) => b.tvlUsd - a.tvlUsd)

  // Headline price: the deepest pool that actually traded in the last 24h.
  // A pool with no trades has a price nothing is enforcing, which is exactly
  // the phantom-liquidity case -- so it must not set the headline.
  const traded = pools.filter((x) => x.volume24hUsd > 0 && x.priceInQuote !== null)
  const candidates = traded.length ? traded : pools.filter((x) => x.priceInQuote !== null)
  const priceUsd = candidates.length ? candidates[0].priceInQuote : null

  // Independent cross-check: the next deepest traded pool. Same purpose as the
  // Ethereum adapter's derivedETH-vs-pool comparison -- two paths that should
  // agree, and a loud flag when they do not.
  const second = candidates[1] ?? null
  const deepestPoolPriceUsd = second ? second.priceInQuote : null
  const priceDivergencePct =
    priceUsd !== null && deepestPoolPriceUsd !== null && priceUsd > 0
      ? (Math.abs(priceUsd - deepestPoolPriceUsd) / priceUsd) * 100
      : null

  return {
    sourceError: raw.error ?? null,
    indexed: true,
    priceUsd,
    poolTvlUsd,
    volume24hUsd,
    // Only a 24h window is measured here, so there is no previous-day figure.
    // Reported as 0 rather than invented; phantom-liquidity is judged on the
    // 24h number alone for this venue.
    volumePrevDayUsd: 0,
    pools,
    deepestPoolPriceUsd,
    priceDivergencePct,
    onChainSymbol: null,
    onChainDecimals: null,
  }
}
