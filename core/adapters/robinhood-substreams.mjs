/**
 * Adapter: Robinhood Chain (chainId 4663) via SUBSTREAMS on The Graph.
 *
 * This is the Graph-native path for a chain that has no published subgraph.
 * The Graph's networks registry lists `"subgraphs": []` for eip155:4663 --
 * Firehose and Substreams only -- so Substreams is not a nicety here, it is the
 * only way to get this chain's data through The Graph at all.
 *
 * HOW IT WORKS, and why there is no Rust in this repo
 *   StreamingFast publish a prebuilt foundational package, `ethereum_common`,
 *   whose `filtered_events` module takes a QUERY STRING parameter:
 *       evt_sig:0x<topic0> && (evt_addr:0x<pool> || evt_addr:0x<pool>)
 *   So the filtering we need -- Uniswap V3 Swap events on specific pools -- is
 *   expressed as a parameter, not as a custom WASM module. No Rust toolchain,
 *   no compile step, no package to publish.
 *
 * WHY THERE IS NO SYNC WAIT
 *   `filtered_events` is a map module with no stores, so it has no historical
 *   state to rebuild. We stream a recent block range and the data arrives
 *   immediately. This is the key difference from the Base subgraph, which needed
 *   ~10 days of backfill: nothing here is backfilled.
 *
 * WHAT SUBSTREAMS CAN AND CANNOT GIVE US
 *   A Swap event carries `sqrtPriceX96`, so the latest swap IS the current
 *   price -- that is real, live, event-sourced market data.
 *   It does NOT carry pool reserves. TVL is contract STATE, not an event, so it
 *   is not derivable from an event stream. This adapter therefore reports
 *   poolTvlUsd as null with a 'tvl-unavailable' caveat rather than inventing a
 *   number or quietly emitting 0. That is the same null-never-zero rule applied
 *   to a field we genuinely cannot see from here.
 *
 * AUTH
 *   Needs SUBSTREAMS_API_TOKEN (a JWT) in the local env file. It is a Graph
 *   Market credential and is NOT the same as GRAPH_API_KEY -- the Subgraph
 *   Studio key is rejected by both StreamingFast and Pinax auth endpoints.
 *   Get one at https://thegraph.market then run `substreams auth`.
 */

/**
 * @typedef {import('../types.ts').PoolSnapshot} PoolSnapshot
 * @typedef {import('../types.ts').SourceMeta} SourceMeta
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ethers } from 'ethers'

try {
  process.loadEnvFile()
} catch {
  /* env may already be exported */
}

export const ADAPTER_ID = 'robinhood-substreams'
export const CHAIN_ID = 4663

/** Registry-listed Substreams endpoint for Robinhood Chain mainnet. */
export const ENDPOINT =
  process.env.SUBSTREAMS_ENDPOINT_ROBINHOOD || 'mainnet.robinhood.streamingfast.io:443'

/**
 * Prebuilt foundational package -- nothing of ours is compiled.
 *
 * VENDORED ON PURPOSE. Fetching it from the registry at runtime failed mid-demo
 * with "access denied to package on the Substreams registry" (and spkg.io
 * returns 403 to direct download, token or not), which took the whole venue off
 * the table. The identical package is published on GitHub releases, so it is
 * committed to vendor/ and read from disk. A third-party registry being
 * reachable is not something a live demo should depend on.
 *
 * Refresh with:
 *   curl -sL -o vendor/ethereum-common-v0.3.3.spkg \
 *     https://github.com/streamingfast/substreams-foundational-modules/releases/download/ethereum-common-v0.3.3/ethereum-common-v0.3.3.spkg
 */
export const PACKAGE =
  process.env.SUBSTREAMS_PACKAGE ||
  fileURLToPath(new URL('../../vendor/ethereum-common-v0.3.3.spkg', import.meta.url))

const MODULE = 'filtered_events'
const SUBSTREAMS_BIN = process.env.SUBSTREAMS_BIN || 'substreams'

const SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)')

/** USDG ("Global Dollar"), 6 decimals, treated as exactly $1. See registry notes. */
const USDG_DECIMALS = 6

/**
 * How many recent blocks to stream. ~0.101s/block, so 855,785 blocks is 24h.
 *
 * Smaller windows are honest but must not be LABELLED as 24h -- see
 * `windowHours` below, which is reported alongside the number so a 1h sample can
 * never be presented as a day's volume.
 */
const DEFAULT_WINDOW_BLOCKS = Number(process.env.SUBSTREAMS_WINDOW_BLOCKS || 20_000)

/**
 * MEASURED: the stream processes ~190 blocks/sec, so a full 24h window
 * (855,785 blocks) takes roughly 70 minutes -- not viable on demand. The
 * default is therefore ~34 minutes of chain, which is ample for PRICE (the
 * latest swap is the price) but is NOT a day's volume.
 *
 * So volume is reported for the window actually streamed and is labelled with
 * that window. `volume24hUsd` stays null unless a genuine 24h window was
 * streamed -- calling a 34-minute figure "24h volume" would be exactly the kind
 * of quiet mislabelling this project exists to avoid.
 */
const FULL_DAY_HOURS = 23
const BLOCK_SECONDS = 0.101

const coder = ethers.AbiCoder.defaultAbiCoder()

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'

const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)'])
const multicallAbi = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
])

/**
 * Pool reserves, read as contract STATE.
 *
 * Substreams streams events, and reserves are not an event -- they are storage.
 * Reconstructing them from the event log would mean replaying every transfer
 * since pool creation (~50M blocks here), which is exactly the backfill this
 * adapter exists to avoid.
 *
 * So TVL comes from one batched balanceOf read while PRICE and VOLUME still
 * come from the Substreams stream. That split is real, so it is labelled rather
 * than blurred: the point carries a `tvl-via-state-read` caveat and the UI
 * shows TVL's provenance separately. Set SUBSTREAMS_TVL=off to drop TVL back to
 * null and keep the row purely event-sourced.
 */
async function fetchPoolReserves(pools, tokenDecimals) {
  if ((process.env.SUBSTREAMS_TVL || '').toLowerCase() === 'off') return null
  if (!pools.length) return null

  const url = process.env.ROBINHOOD_RPC_URL || 'https://robinhood.rpc.service.pinax.network'
  const calls = pools.flatMap((p) => [
    { target: USDG, callData: erc20.encodeFunctionData('balanceOf', [p.pool]) },
    { target: p.tokenAddress, callData: erc20.encodeFunctionData('balanceOf', [p.pool]) },
  ])

  const data = multicallAbi.encodeFunctionData('aggregate3', [
    calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData })),
  ])

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: MULTICALL3, data }, 'latest'],
    }),
    signal: AbortSignal.timeout(30000),
  })
  const j = await res.json()
  if (!j.result) throw new Error(j.error?.message || 'multicall failed')

  const decoded = multicallAbi.decodeFunctionResult('aggregate3', j.result)[0]
  const out = {}
  pools.forEach((p, i) => {
    const get = (r) => {
      try { return r?.success ? erc20.decodeFunctionResult('balanceOf', r.returnData)[0] : null } catch { return null }
    }
    const usdgRaw = get(decoded[i * 2])
    const tokRaw = get(decoded[i * 2 + 1])
    out[p.pool.toLowerCase()] = {
      usdg: usdgRaw === null ? null : Number(ethers.formatUnits(usdgRaw, USDG_DECIMALS)),
      token: tokRaw === null ? null : Number(ethers.formatUnits(tokRaw, tokenDecimals)),
    }
  })
  return out
}

/**
 * Current chain head.
 *
 * A Substreams run needs an absolute block range, and the CLI's relative
 * start-block form cannot be combined with a relative stop. One cheap RPC call
 * gives the anchor; it supplies no market data -- every price and volume figure
 * below comes from the Substreams stream.
 */
export async function currentHead() {
  const url = process.env.ROBINHOOD_RPC_URL || 'https://robinhood.rpc.service.pinax.network'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(20000),
  })
  const j = await res.json()
  if (!j.result) throw new Error('could not read Robinhood chain head')
  return parseInt(j.result, 16)
}

/**
 * Only ONE stream at a time, and only one recent result.
 *
 * MEASURED THE HARD WAY: the Graph Market tier allows 2 concurrent Substreams
 * sessions, and every page load was opening another. Past two, the server
 * answers `ResourceExhausted: Concurrent stream limit exceeded` and the venue
 * silently vanished from the table. So runs are serialised through a mutex,
 * results are cached, and stray child processes are killed rather than left
 * holding a session.
 */
let streamLock = Promise.resolve()
function withStreamLock(fn) {
  const run = streamLock.then(fn, fn)
  // Keep the chain alive regardless of outcome, without leaking rejections.
  streamLock = run.then(() => {}, () => {})
  return run
}

const resultCache = new Map()
const RESULT_TTL_MS = 120_000

/** Kill any stray `substreams run` children this process started. */
const liveChildren = new Set()
function killAllChildren() {
  for (const c of liveChildren) {
    try { c.kill('SIGKILL') } catch { /* already gone */ }
  }
  liveChildren.clear()
}
process.once('exit', killAllChildren)
process.once('SIGINT', () => { killAllChildren(); process.exit(130) })

export function isConfigured() {
  return Boolean((process.env.SUBSTREAMS_API_TOKEN || '').trim())
}

/**
 * Run `substreams run` and collect its JSONL output.
 *
 * The CLI is the supported way to consume a package; shelling out to it avoids
 * hand-rolling a gRPC client for a protocol whose framing we would then have to
 * keep in sync.
 */
function runSubstreams({ params, startBlock, stopBlock, timeoutMs = 240_000 }) {
  return new Promise((resolve, reject) => {
    const token = (process.env.SUBSTREAMS_API_TOKEN || '').trim()
    if (!token) {
      reject(
        new Error(
          'SUBSTREAMS_API_TOKEN is not set. Substreams needs a Graph Market credential, ' +
            'which is NOT the Subgraph Studio GRAPH_API_KEY. Create one at ' +
            'https://thegraph.market, run `substreams auth`, and put the JWT in your ' +
            'local env file as SUBSTREAMS_API_TOKEN.'
        )
      )
      return
    }

    const args = [
      'run',
      PACKAGE,
      MODULE,
      '-e',
      ENDPOINT,
      '-s',
      String(startBlock),
      '-t',
      String(stopBlock),
      '-p',
      `${MODULE}=${params}`,
      '-o',
      'jsonl',
      // The CLI refuses to process more than 10,000 blocks by default -- a
      // cost guardrail. Our window is deliberately larger, so raise the ceiling
      // to match it exactly rather than disabling the guard outright.
      '--limit-processed-blocks',
      String(stopBlock - startBlock + 1000),
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
      reject(
        new Error(
          e.code === 'ENOENT'
            ? `substreams CLI not found (tried "${SUBSTREAMS_BIN}"). Install it with: brew install streamingfast/tap/substreams`
            : e.message
        )
      )
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      liveChildren.delete(child)
      // Auth failures exit non-zero with a very specific message; surface it
      // verbatim rather than as a generic "stream failed".
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`substreams exited ${code}: ${stderr.trim().slice(0, 400)}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * Pull Swap events out of the CLI's JSONL stream.
 *
 * The exact envelope differs between CLI versions, so this walks the parsed
 * object for anything that looks like an event with topics rather than assuming
 * one fixed shape. Defensive on purpose: a shape change should degrade to
 * "found nothing" (which is visible and flagged), never to a wrong number.
 */
function parseSwapEvents(stdout) {
  const events = []

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue

    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }

    const found = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      const topics = node.topics ?? node.log?.topics
      const address = node.address ?? node.log?.address
      const data = node.data ?? node.log?.data
      if (Array.isArray(topics) && topics.length && address) {
        found.push({
          address: normaliseHex(address),
          topic0: normaliseHex(topics[0]),
          data: normaliseHex(data),
          blockNumber: Number(node.blockNumber ?? node.block_number ?? obj['@block'] ?? 0),
        })
      }
      for (const v of Object.values(node)) walk(v)
    }
    walk(obj)
    events.push(...found)
  }

  return events.filter((e) => e.topic0 && e.topic0.toLowerCase() === SWAP_TOPIC.toLowerCase())
}

/** Substreams JSON may hand back base64 bytes rather than hex; accept both. */
function normaliseHex(v) {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') return null
  if (v.startsWith('0x')) return v.toLowerCase()
  try {
    const buf = Buffer.from(v, 'base64')
    if (!buf.length) return null
    return '0x' + buf.toString('hex')
  } catch {
    return null
  }
}

/**
 * Uniswap V3 price from a Swap event's sqrtPriceX96.
 * price(token0 in token1) = (sqrt/2^96)^2 * 10^dec0 / 10^dec1, kept in BigInt
 * until the final divide so a 6-decimal quote does not lose precision.
 */
function priceFromSqrt(sqrtPriceX96, dec0, dec1) {
  try {
    const sqrt = BigInt(sqrtPriceX96)
    if (sqrt <= 0n) return null
    const scaled = (sqrt * sqrt * 10n ** BigInt(dec0) * 10n ** 18n) / (2n ** 192n * 10n ** BigInt(dec1))
    const v = Number(scaled) / 1e18
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

/**
 * @param {string[]} addresses token addresses (registry keys)
 * @param {object} opts
 * @param {Map<string, Array<{pool: string, ourTokenIsToken0: boolean, fee: number}>>} opts.poolsByToken
 *   Which pools belong to which token. Pool membership is chain STATE, not an
 *   event stream, so it is supplied by the caller (see poolsForToken in the RPC
 *   adapter, or a static registry) rather than discovered here.
 * @param {number} opts.head current chain head block
 */
export async function fetchOnChain(addresses, opts = {}) {
  const addrs = addresses.map((a) => a.trim().toLowerCase())
  const { poolsByToken = new Map(), head } = opts

  if (!head) throw new Error('robinhood-substreams: head block is required')

  const windowBlocks = DEFAULT_WINDOW_BLOCKS
  const startBlock = Math.max(0, head - windowBlocks)
  const stopBlock = head
  const windowHours = (windowBlocks * BLOCK_SECONDS) / 3600

  // Every pool we care about, in one filter expression -- one stream, not one
  // per pool.
  const allPools = []
  for (const a of addrs) for (const p of poolsByToken.get(a) ?? []) allPools.push(p.pool.toLowerCase())

  if (!allPools.length) {
    return {
      meta: sourceMeta(head, windowHours),
      ethPriceUSD: null,
      tokens: new Map(addrs.map((a) => [a, { pools: [], found: false, error: 'no pools supplied' }])),
    }
  }

  const addrFilter = allPools.map((p) => `evt_addr:${p}`).join(' || ')
  const params = `evt_sig:${SWAP_TOPIC} && (${addrFilter})`

  const cacheKey = `${addrs.slice().sort().join(',')}|${Math.floor(head / 5000)}`
  const cached = resultCache.get(cacheKey)
  if (cached && Date.now() - cached.at < RESULT_TTL_MS) return cached.value

  // Serialised: two of these at once trips the concurrent-session limit.
  const { stdout, stderr } = await withStreamLock(async () => {
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await runSubstreams({ params, startBlock, stopBlock })
      } catch (e) {
        lastErr = e
        // A session-limit error is transient: another stream is finishing.
        // Anything else (auth, bad params) will not improve by waiting.
        if (!/ResourceExhausted|Concurrent stream limit/i.test(e.message)) throw e
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
      }
    }
    throw new Error(
      `substreams stream limit still exhausted after retries: ${lastErr?.message?.slice(0, 200)}`
    )
  })
  const swaps = parseSwapEvents(stdout)

  // Aggregate per pool: latest swap sets the price, all swaps set the volume.
  const byPool = {}
  for (const ev of swaps) {
    const pool = ev.address
    byPool[pool] ||= { swaps: 0, a0: 0n, a1: 0n, lastSqrt: null, lastBlock: -1 }
    const slot = byPool[pool]
    try {
      const [amount0, amount1, sqrtPriceX96] = coder.decode(
        ['int256', 'int256', 'uint160', 'uint128', 'int24'],
        ev.data
      )
      slot.swaps++
      slot.a0 += amount0 < 0n ? -amount0 : amount0
      slot.a1 += amount1 < 0n ? -amount1 : amount1
      if (ev.blockNumber >= slot.lastBlock) {
        slot.lastBlock = ev.blockNumber
        slot.lastSqrt = sqrtPriceX96
      }
    } catch {
      /* a single undecodable log must not sink the stream */
    }
  }

  const tokens = new Map()
  for (const a of addrs) {
    const basePools = (poolsByToken.get(a) ?? []).map((p) => ({ ...p, tokenAddress: a }))

    // One batched state read for reserves; failure degrades TVL to null rather
    // than taking the (Substreams-sourced) price and volume down with it.
    let reserves = null
    let reserveError = null
    try {
      reserves = await fetchPoolReserves(basePools, 18)
    } catch (e) {
      reserveError = String(e.message || e)
    }

    const pools = basePools.map((p) => ({
      ...p,
      stats: byPool[p.pool.toLowerCase()] ?? null,
      reserves: reserves?.[p.pool.toLowerCase()] ?? null,
    }))
    tokens.set(a, {
      pools,
      found: true,
      windowHours,
      swapsSeen: pools.reduce((n, p) => n + (p.stats?.swaps ?? 0), 0),
      tvlFromStateRead: Boolean(reserves),
      error: reserveError ? `reserves unavailable: ${reserveError}` : null,
    })
  }

  if (stderr && /Unauthenticated|auth failure/i.test(stderr)) {
    throw new Error(`substreams auth failed: ${stderr.trim().slice(0, 300)}`)
  }

  const value = { meta: sourceMeta(head, windowHours), ethPriceUSD: null, tokens }
  resultCache.set(cacheKey, { at: Date.now(), value })
  return value
}

/** @returns {SourceMeta} */
function sourceMeta(head, windowHours) {
  return {
    adapter: ADAPTER_ID,
    // The Substreams endpoint, so a consumer can see this row came through
    // The Graph's Substreams rather than a plain RPC.
    endpointId: `substreams:${ENDPOINT}/${MODULE} (window ${windowHours.toFixed(1)}h)`,
    indexedBlock: head,
    indexedAt: new Date().toISOString(),
    // Event stream read up to head, so there is no index trailing the chain.
    indexedLagSeconds: 0,
    hasIndexingErrors: false,
  }
}

export function shapeToken(raw, address, _ethPriceUSD, decimals = 18, symbol = 'TOKEN') {
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
    // TVL is contract state and simply is not in an event stream. Said out
    // loud so nobody reads the null as a failure.
    extraCaveats: ['tvl-unavailable'],
  }
  if (!raw || !raw.found || !raw.pools.length) return empty

  /** @type {PoolSnapshot[]} */
  const pools = []
  let volumeUsd = 0
  const windowHours = raw.windowHours ?? 0

  for (const p of raw.pools) {
    const s = p.stats
    const dec0 = p.ourTokenIsToken0 ? decimals : USDG_DECIMALS
    const dec1 = p.ourTokenIsToken0 ? USDG_DECIMALS : decimals
    const p0 = s?.lastSqrt ? priceFromSqrt(s.lastSqrt, dec0, dec1) : null
    const priceInQuote = p0 === null ? null : p.ourTokenIsToken0 ? p0 : 1 / p0

    const usdgRaw = s ? (p.ourTokenIsToken0 ? s.a1 : s.a0) : 0n
    const vol = Number(ethers.formatUnits(usdgRaw, USDG_DECIMALS))
    volumeUsd += vol

    // USDG side + token side priced at this pool's own rate. Null unless the
    // state read succeeded -- never 0 as a stand-in for unknown.
    let tvlUsd = null
    if (p.reserves && p.reserves.usdg !== null) {
      const tokenSide = p.reserves.token !== null && priceInQuote !== null ? p.reserves.token * priceInQuote : 0
      tvlUsd = p.reserves.usdg + tokenSide
    }

    pools.push({
      id: p.pool.toLowerCase(),
      pairSymbol: p.ourTokenIsToken0 ? `${symbol}/USDG` : `USDG/${symbol}`,
      quoteSymbol: 'USDG',
      feeTier: Number.isFinite(p.fee) ? p.fee : null,
      tvlUsd,
      // Volume over the streamed window, not necessarily 24h -- see
      // volumeWindowHours on the point.
      volume24hUsd: vol,
      priceInQuote,
    })
  }

  // Most-traded pool sets the headline price: with no TVL to rank by, actual
  // trading is the better measure of which price the market is enforcing.
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
  // Price and volume are Substreams; TVL is a contract state read. Saying so
  // is the point -- a blended row that hides which field came from where would
  // misrepresent what Substreams actually provided.
  const caveats = [poolTvlUsd === null ? 'tvl-unavailable' : 'tvl-via-state-read']
  if (!isFullDay) caveats.push('volume-window-short')

  return {
    sourceError: raw.error ?? null,
    indexed: true,
    priceUsd,
    poolTvlUsd,
    // Only a real 24h window may be called 24h volume. Otherwise null, with
    // the measured figure and its window carried alongside.
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
