#!/usr/bin/env node
/**
 * TrueTick paid data service: the REAL deviation data behind x402/Blocky402.
 *
 * This is the product. An agent that wants tokenized-stock fair-price data pays
 * a real HBAR micropayment on Hedera testnet, settled by the Blocky402
 * facilitator, and receives genuine normalized TokenizedStockPoints -- live
 * Uniswap v4 prices from The Graph, compared against a real reference price,
 * with the quality flags attached.
 *
 *   PAID   GET /price/:ticker    real TickerComparison, after settlement
 *   FREE   GET /preview/:ticker  same shape, prices REDACTED -- so you can
 *                                develop against the contract without paying
 *   FREE   GET /tickers          what can be asked for
 *   FREE   GET /health           liveness + payment terms
 *
 * Run:  node paid-service.mjs        (then: node paid-client.mjs NVDA)
 *
 * Deliberately a SEPARATE process from service.mjs. That one stays open and
 * free on port 8402 for development; this one is the monetised surface. Same
 * core modules underneath, so the data cannot drift between them.
 */
import express from 'express'
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server'
import { paymentMiddleware } from '@x402/express'
import { ExactHederaScheme } from '@x402/hedera/exact/server'

import { byTicker, tickers } from './core/registry.mjs'
import { buildComparison } from './core/point.mjs'
import { ADAPTER_ID, SUBGRAPH_ID } from './core/adapters/ethereum-univ4.mjs'
import { assertBlocky402, FACILITATOR_URL, NETWORK, HBAR_ASSET } from './core/blocky402.mjs'

try {
  process.loadEnvFile()
} catch {
  /* env may already be exported */
}

// Fail at startup, not at first payment.
assertBlocky402(FACILITATOR_URL)

// Where payments land. Receiving HBAR needs no signature, so a keyless
// (hollow) account is a valid payee.
const PAY_TO = process.env.PAY_TO_ACCOUNT_ID || '0.0.10439151'

// Price in tinybar (HBAR has 8 decimals). 1_000_000 tinybar = 0.01 HBAR.
const PRICE_TINYBAR = process.env.PRICE_TINYBAR || '1000000'

const PORT = Number(process.env.X402_PRICE_PORT || 4402)

if (!/^\d+\.\d+\.\d+$/.test(PAY_TO)) {
  console.error(`\n  x PAY_TO_ACCOUNT_ID must be a Hedera account id (0.0.x), got: ${PAY_TO}\n`)
  process.exit(1)
}

// --- x402 wiring -----------------------------------------------------------
// The resource server never signs anything: it builds the 402 challenge and
// asks the facilitator to verify and settle, so it holds no key of its own.
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL })
const x402 = new x402ResourceServer(facilitator).register(NETWORK, new ExactHederaScheme())

/**
 * `:ticker` is a real path parameter, not a literal. The x402 route matcher
 * rewrites `:param` to `[^/]+`, so one route entry covers every ticker rather
 * than needing one registration per symbol.
 */
const routes = {
  'GET /price/:ticker': {
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        payTo: PAY_TO,
        // Explicit AssetAmount, never a "$0.001" money string -- a money string
        // resolves against DEFAULT_ASSETS, which on hedera:testnet means USDC
        // 0.0.429274 and requires an HTS association before anything settles.
        price: { asset: HBAR_ASSET, amount: String(PRICE_TINYBAR) },
      },
    ],
    description:
      'Live tokenized-stock fair-price and deviation data: on-chain price from ' +
      'Uniswap v4 via The Graph, versus the real underlying reference price, ' +
      'with liquidity-quality flags.',
    mimeType: 'application/json',
  },
}

const app = express()
app.set('json spaces', 2)
app.use(paymentMiddleware(routes, x402))

// ---------------------------------------------------------------- paid ------

/**
 * Only reached once Blocky402 has verified the payment.
 *
 * Settlement happens AFTER this handler returns, and the middleware cancels it
 * when the handler responds 4xx/5xx. So an upstream failure (Graph gateway
 * down, unknown ticker) costs the caller nothing -- they are charged for data
 * that was actually delivered, not for the attempt.
 */
app.get('/price/:ticker', async (req, res) => {
  const ticker = String(req.params.ticker || '').toUpperCase()
  const entries = byTicker(ticker)

  if (!entries.length) {
    return res.status(404).json({
      error: `no registered token for ticker ${ticker}`,
      available: tickers(),
    })
  }

  try {
    const data = await buildComparison(ticker, entries)
    res.json(data)
  } catch (e) {
    // 502 -> the middleware cancels settlement, so no payment is taken.
    res.status(502).json({ error: String(e.message || e), ticker })
  }
})

// ---------------------------------------------------------------- free ------

/**
 * Free preview: the real shape and the real metadata, with the numbers you are
 * actually buying removed.
 *
 * This exists so the contract can be developed against without spending HBAR on
 * every iteration. It redacts rather than fabricates: prices become null and a
 * 'preview-redacted' caveat is added, so nobody can mistake a preview for paid
 * data or accidentally build on a placeholder number. Consistent with the
 * project rule that a missing number is null, never a plausible-looking value.
 */
app.get('/preview/:ticker', async (req, res) => {
  const ticker = String(req.params.ticker || '').toUpperCase()
  const entries = byTicker(ticker)

  if (!entries.length) {
    return res.status(404).json({ error: `no registered token for ticker ${ticker}`, available: tickers() })
  }

  try {
    const data = await buildComparison(ticker, entries)
    res.json({
      ...data,
      preview: true,
      note: `Free preview. Prices redacted. GET /price/${ticker} with x402 payment for real values.`,
      referencePriceUsd: null,
      points: data.points.map((p) => ({
        ...p,
        priceUsd: null,
        referencePriceUsd: null,
        deviationPct: null,
        deviationAbsUsd: null,
        pools: p.pools.map((pool) => ({ ...pool, priceInQuote: null })),
        quality: { ...p.quality, caveats: [...p.quality.caveats, 'preview-redacted'] },
      })),
    })
  } catch (e) {
    res.status(502).json({ error: String(e.message || e), ticker })
  }
})

app.get('/tickers', (_req, res) => {
  res.json({
    tickers: tickers().map((t) => {
      const entries = byTicker(t)
      return {
        ticker: t,
        issuers: entries.map((e) => e.issuer),
        symbols: entries.map((e) => e.symbol),
        hasReference: entries.some((e) => e.referenceSymbol !== null),
        paidUrl: `/price/${t}`,
        freeUrl: `/preview/${t}`,
      }
    }),
  })
})

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    adapter: ADAPTER_ID,
    subgraph: SUBGRAPH_ID,
    payment: {
      network: NETWORK,
      facilitator: FACILITATOR_URL,
      asset: `${HBAR_ASSET} (HBAR)`,
      priceTinybar: PRICE_TINYBAR,
      priceHbar: Number(PRICE_TINYBAR) / 1e8,
      payTo: PAY_TO,
      gatedRoute: 'GET /price/:ticker',
    },
    freeRoutes: ['GET /preview/:ticker', 'GET /tickers', 'GET /health'],
    time: new Date().toISOString(),
  })
})

app.listen(PORT, () => {
  console.log(`\n  TrueTick PAID data service on http://localhost:${PORT}`)
  console.log(`  paid route  : GET /price/:ticker   (402-gated)`)
  console.log(`  free routes : GET /preview/:ticker, /tickers, /health`)
  console.log(`  network     : ${NETWORK}`)
  console.log(`  facilitator : ${FACILITATOR_URL} (Blocky402 enforced)`)
  console.log(
    `  price       : ${PRICE_TINYBAR} tinybar (${Number(PRICE_TINYBAR) / 1e8} HBAR, asset ${HBAR_ASSET})`
  )
  console.log(`  payTo       : ${PAY_TO}`)
  console.log(`  data        : ${ADAPTER_ID} -> ${SUBGRAPH_ID}`)
  console.log(`\n  try: node paid-client.mjs NVDA\n`)
})
