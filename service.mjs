#!/usr/bin/env node
/**
 * TrueTick price service.
 *
 * Ticker in, normalized JSON out. No UI, no x402 -- those layer on top of this
 * without changing it.
 *
 *   GET /health              liveness, plus which reference provider is configured
 *   GET /tickers             every ticker the registry can answer for
 *   GET /price/:ticker       TickerComparison: one ticker, every issuer, one block
 *   GET /point/:address      a single TokenizedStockPoint by contract address
 *
 * Run:   node service.mjs         (PORT env to override 8402)
 * Try:   curl -s localhost:8402/price/NVDA | jq
 */
import express from 'express'
import { fileURLToPath } from 'node:url'
import { byTicker, byAddress, tickers, TOKENS } from './core/registry.mjs'
import { buildComparison, buildPoint, THRESHOLDS } from './core/point.mjs'
import { fetchOnChain, shapeToken, ADAPTER_ID, SUBGRAPH_ID } from './core/adapters/ethereum-univ4.mjs'
import * as robinhoodSubstreams from './core/adapters/robinhood-substreams.mjs'
import * as solanaSubstreams from './core/adapters/solana-substreams.mjs'
import * as baseAerodrome from './core/adapters/base-aerodrome.mjs'
import { getReferencePriceCached } from './core/reference-price.mjs'

try {
  process.loadEnvFile()
} catch {
  /* env may already be exported */
}

const app = express()
const PORT = Number(process.env.PORT || 8402)

// JSON that is actually readable in a terminal during a demo.
app.set('json spaces', 2)

/**
 * Serve the UI from this same process, so the page and the API share an origin
 * and there is no CORS layer to misconfigure during a live demo. express.static
 * only answers requests that match a real file, so /price, /tickers and the
 * rest fall through untouched.
 */
app.use(express.static(fileURLToPath(new URL('./ui', import.meta.url))))

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    adapter: ADAPTER_ID,
    subgraph: SUBGRAPH_ID,
    graphKeyConfigured: Boolean((process.env.GRAPH_API_KEY || '').trim()),
    referencePrimary: 'yahoo-chart (no key required)',
    referenceFallback: (process.env.FINNHUB_API_KEY || '').trim()
      ? 'finnhub (key configured)'
      : 'finnhub (no key set -- fallback unavailable)',
    thresholds: THRESHOLDS,
    tickers: tickers().length,
    tokens: Object.keys(TOKENS).length,
    time: new Date().toISOString(),
  })
})

/**
 * Which Graph product serves which chain.
 *
 * The composition, made machine-readable rather than asserted in a README: two
 * distinct Graph products (Subgraphs via Subgraph Studio, Substreams via The
 * Graph Market) feeding one normalized schema across three chains and three DEX
 * protocols. `GET /price/:ticker` is a single query pattern over all of it.
 */
app.get('/sources', async (_req, res) => {
  const tokens = Object.values(TOKENS)
  const count = (adapter) => tokens.filter((t) => t.adapter === adapter).length

  // Live sync progress for our own subgraph, read from the indexer's public
  // status endpoint. Fetched per request rather than asserted, so "still
  // indexing" is a measurement a reader can re-check, not a claim in a README.
  let baseSync = null
  try {
    baseSync = await baseAerodrome.fetchSyncStatus()
  } catch {
    /* status endpoint down: reported as unknown below, never as synced */
  }
  const basePct =
    baseSync && baseSync.latestBlock !== null && baseSync.chainHeadBlock !== null
      ? ((baseSync.latestBlock - baseAerodrome.START_BLOCK) /
          (baseSync.chainHeadBlock - baseAerodrome.START_BLOCK)) *
        100
      : null

  res.json({
    schema: 'TokenizedStockPoint (core/types.ts) — one shape for every source',
    queryPattern: 'GET /price/:ticker returns every venue for that ticker, whatever chain or product served it',
    graphProducts: [
      {
        product: 'Subgraphs',
        provider: 'Subgraph Studio (decentralized network gateway)',
        credential: 'GRAPH_API_KEY',
        configured: Boolean((process.env.GRAPH_API_KEY || '').trim()),
        adapters: [
          {
            adapter: ADAPTER_ID,
            chain: 'ethereum',
            caip2: 'eip155:1',
            protocol: 'Uniswap v4',
            endpoint: SUBGRAPH_ID,
            selfPublished: false,
            note: "Uniswap's official subgraph — consumed, not published by us.",
            tokens: count(ADAPTER_ID),
          },
          {
            adapter: baseAerodrome.ADAPTER_ID,
            chain: 'base',
            caip2: 'eip155:8453',
            protocol: 'Aerodrome Slipstream',
            endpoint: baseAerodrome.SUBGRAPH_ID,
            // The publisher story, machine-readable.
            selfPublished: true,
            published: {
              slug: 'truetick-aerodrome-base',
              subgraphId: baseAerodrome.SUBGRAPH_ID,
              deployment: baseAerodrome.DEPLOYMENT_ID,
              forkedFrom: 'Uniswap/v3-subgraph @ b4a0e8d34b8238482cadd3929ae88d3426a7067b',
              indexes: `Aerodrome Slipstream CLFactory ${baseAerodrome.FACTORY}`,
              startBlock: baseAerodrome.START_BLOCK,
              reason:
                'No published subgraph indexed this factory, where Coinbase B20 tokenized ' +
                'equities actually trade. Forked, repointed, two silent-$0 bugs fixed, published.',
            },
            status: {
              state: baseSync?.synced ? 'synced' : 'indexing',
              health: baseSync?.health ?? 'unknown',
              indexedBlock: baseSync?.latestBlock ?? null,
              chainHeadBlock: baseSync?.chainHeadBlock ?? null,
              blocksRemaining:
                baseSync?.latestBlock != null && baseSync?.chainHeadBlock != null
                  ? baseSync.chainHeadBlock - baseSync.latestBlock
                  : null,
              progressPct: basePct === null ? null : Number(basePct.toFixed(2)),
              // Said plainly, because this is the field most likely to be
              // misread as "this venue has no liquidity".
              meaning:
                'Backfilling. These tokens price as null with a subgraph-syncing caveat ' +
                'until the index reaches their pools — never as 0, and never omitted.',
            },
            tokens: count(baseAerodrome.ADAPTER_ID),
          },
        ],
      },
      {
        product: 'Substreams',
        provider: 'The Graph Market',
        credential: 'SUBSTREAMS_API_TOKEN',
        configured: Boolean((process.env.SUBSTREAMS_API_TOKEN || '').trim()),
        composedPackages: [
          'ethereum_common v0.3.3 (StreamingFast foundational module)',
          'solana_common v0.4.0 (StreamingFast foundational module)',
        ],
        adapters: [
          {
            adapter: robinhoodSubstreams.ADAPTER_ID,
            chain: 'robinhood',
            caip2: 'eip155:4663',
            protocol: 'Uniswap V3',
            endpoint: robinhoodSubstreams.ENDPOINT,
            note: 'No published subgraph exists for this chain — registry lists "subgraphs": []',
            tokens: count(robinhoodSubstreams.ADAPTER_ID),
          },
          {
            adapter: solanaSubstreams.ADAPTER_ID,
            chain: 'solana',
            caip2: solanaSubstreams.CAIP2,
            protocol: 'Raydium CLMM',
            endpoint: solanaSubstreams.ENDPOINT,
            note: 'Non-EVM. Same normalized schema, zero schema changes.',
            tokens: count(solanaSubstreams.ADAPTER_ID),
          },
        ],
      },
    ],
    leverage: {
      chains: 4,
      dexProtocols: ['Uniswap v4', 'Uniswap V3', 'Raydium CLMM', 'Aerodrome Slipstream'],
      graphProducts: 2,
      subgraphsPublishedByUs: 1,
      schemaChangesToAddSolana: 0,
      note:
        'Adding a non-EVM chain required a new adapter file and registry rows. ' +
        'The shared schema, quality rules, HTTP service and UI were untouched.',
    },
  })
})

app.get('/tickers', (_req, res) => {
  res.json({
    tickers: tickers().map((t) => {
      const entries = byTicker(t)
      return {
        ticker: t,
        issuers: entries.map((e) => e.issuer),
        symbols: entries.map((e) => e.symbol),
        // Surfaced so a caller knows up front that no deviation is possible
        // here, rather than discovering a null and assuming a bug.
        hasReference: entries.some((e) => e.referenceSymbol !== null),
      }
    }),
  })
})

app.get('/price/:ticker', async (req, res) => {
  const ticker = String(req.params.ticker || '').toUpperCase()
  const entries = byTicker(ticker)

  if (!entries.length) {
    return res.status(404).json({
      error: `no registered token for ticker ${ticker}`,
      hint: 'GET /tickers for the list',
      available: tickers(),
    })
  }

  try {
    res.json(await buildComparison(ticker, entries))
  } catch (e) {
    // A failed upstream is reported as a failure. It never degrades into a
    // response full of zeros that reads like real, calm market data.
    res.status(502).json({ error: String(e.message || e), ticker })
  }
})

app.get('/point/:address', async (req, res) => {
  const address = String(req.params.address || '').toLowerCase()
  const entry = byAddress(address)

  if (!entry) {
    return res.status(404).json({
      error: `address ${address} is not in the registry`,
      hint: 'Tokens are resolved by contract address only -- never by symbol.',
    })
  }

  try {
    const [{ meta: source, ethPriceUSD, tokens }, ref] = await Promise.all([
      fetchOnChain([address]),
      getReferencePriceCached(entry.referenceSymbol),
    ])
    const shaped = shapeToken(tokens.get(address), address, ethPriceUSD)
    res.json(
      buildPoint({
        address,
        entry,
        shaped,
        source,
        reference: ref.meta,
        referencePriceUsd: ref.priceUsd,
      })
    )
  } catch (e) {
    res.status(502).json({ error: String(e.message || e), address })
  }
})

app.listen(PORT, () => {
  console.log(`\n  TrueTick service on http://localhost:${PORT}`)
  console.log(`  adapter  ${ADAPTER_ID}  ->  subgraph ${SUBGRAPH_ID}`)
  console.log(`  tickers  ${tickers().join(', ')}`)
  console.log(`\n  try: curl -s localhost:${PORT}/price/NVDA | jq\n`)
})
