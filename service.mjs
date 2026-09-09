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
import { byTicker, byAddress, tickers, TOKENS } from './core/registry.mjs'
import { buildComparison, buildPoint, THRESHOLDS } from './core/point.mjs'
import { fetchOnChain, shapeToken, ADAPTER_ID, SUBGRAPH_ID } from './core/adapters/ethereum-univ4.mjs'
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
