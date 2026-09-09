/**
 * Reference price: what the underlying security actually trades at.
 *
 * The deviation is only as trustworthy as this number, so the provider, the
 * timestamp of the quote, and the market session all travel with it in
 * ReferenceMeta rather than being dropped after the arithmetic.
 *
 * PROVIDERS
 *   1. Yahoo Finance chart endpoint (primary, no API key).
 *      https://query1.finance.yahoo.com/v8/finance/chart/NVDA
 *      Chosen because it needs zero setup AND -- uniquely among the free
 *      options -- returns `currentTradingPeriod`, the exchange's real
 *      pre/regular/post session boundaries. That is what lets us say "the US
 *      market is closed" from data instead of from a hardcoded clock.
 *
 *      LIMITS, stated plainly: this endpoint is UNOFFICIAL and undocumented.
 *      No SLA. It can rate-limit or block by IP or User-Agent, the response
 *      shape can change without notice, and its terms are not clearly suitable
 *      for commercial use. Fine for a hackathon; not a foundation for a
 *      product.
 *
 *      MEASURED, not assumed (2026-09-10): a burst of ~5 requests from one IP
 *      triggers HTTP 429 on BOTH query1 and query2, lasting roughly a minute,
 *      and a session cookie from fc.yahoo.com does NOT lift it. So this module
 *      caches per symbol, collapses concurrent requests for the same symbol
 *      into one in-flight fetch, and backs off on 429. A single ticker needs
 *      exactly one upstream call, which stays well inside the limit.
 *
 *   2. Finnhub (fallback, only if FINNHUB_API_KEY is set in the local env file).
 *      60 requests/minute on the free tier. Used only when Yahoo fails, so the
 *      demo has a second leg to stand on. Finnhub returns no session data, so
 *      that path falls back to a clock-based US-market schedule -- which does
 *      NOT know about market holidays. See marketSessionFromClock.
 *
 * Both providers normalise to the same ReferenceMeta, and `source` records
 * which one actually answered.
 */

/**
 * @typedef {import('./types.ts').ReferenceMeta} ReferenceMeta
 * @typedef {import('./types.ts').MarketSession} MarketSession
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

try {
  process.loadEnvFile()
} catch {
  /* env may already be exported; a missing file is not fatal -- Yahoo needs no key */
}

/**
 * Last-known-good quotes, persisted to disk.
 *
 * MEASURED (2026-09-10): from one IP, the first request returns 200 and every
 * request for the next 90s+ returns 429 on both hosts. In-memory caching alone
 * cannot survive that -- a restarted process starts with nothing and the demo
 * shows null.
 *
 * So a successful quote is written to disk and re-served when the provider is
 * unreachable. This does NOT invent data: the stored price is a real price that
 * really traded, and it is re-served with its ORIGINAL asOf timestamp, a
 * recomputed age, and a freshly evaluated market session. If it has gone stale
 * the existing caveats say so.
 *
 * Off-hours this is not even a degradation: the reference IS the last regular
 * close, so a stored close and a freshly fetched close are the same number.
 */
const CACHE_FILE = fileURLToPath(new URL('../.cache/reference-prices.json', import.meta.url))

function readStore() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeStore(store) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(store, null, 2))
  } catch {
    /* a cache that cannot be written must never break a request */
  }
}

function remember(symbol, priceUsd, meta, tradingPeriod) {
  const store = readStore()
  store[symbol] = {
    priceUsd,
    source: meta.source,
    symbol: meta.symbol,
    asOf: meta.asOf,
    previousCloseUsd: meta.previousCloseUsd,
    tradingPeriod: tradingPeriod ?? null,
    storedAt: new Date().toISOString(),
  }
  writeStore(store)
}

/**
 * Re-serve a stored quote. The session is recomputed from the CURRENT time
 * against the stored exchange schedule -- reusing the stored session would let
 * a quote captured mid-session keep claiming the market is open hours later,
 * which is the exact kind of quiet lie this project exists to avoid.
 */
function recall(symbol) {
  const hit = readStore()[symbol]
  if (!hit || !Number.isFinite(hit.priceUsd) || hit.priceUsd <= 0) return null

  const nowSec = Math.floor(Date.now() / 1000)
  const quoteSec = Math.floor(new Date(hit.asOf).getTime() / 1000)
  const { session, marketOpen } = hit.tradingPeriod
    ? marketSessionFromYahoo({ currentTradingPeriod: hit.tradingPeriod }, nowSec)
    : marketSessionFromClock(new Date(nowSec * 1000))

  return {
    priceUsd: hit.priceUsd,
    error: null,
    meta: {
      // Visibly marked: a consumer can always tell a re-served quote from a
      // fresh one without digging into timestamps.
      source: `${hit.source} (cached)`,
      symbol: hit.symbol,
      asOf: hit.asOf,
      ageSeconds: Math.max(0, nowSec - quoteSec),
      session,
      marketOpen,
      previousCloseUsd: hit.previousCloseUsd ?? null,
    },
  }
}

const YAHOO_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com', // same API, separate host; used if the first is rate-limited
]

// Yahoo rejects requests with no recognisable User-Agent.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** A price must be a real, positive, finite number -- otherwise it is null. */
function cleanPrice(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * US equity session from the wall clock, for providers that do not report one.
 *
 * KNOWN GAP: no market-holiday calendar. On Thanksgiving this returns 'regular'
 * at 15:00 UTC and is wrong. The staleness check downstream is what catches
 * that -- on a holiday the quote timestamp is a day old, which raises
 * 'reference-stale' and drops deviationReliable. Yahoo's own session data does
 * not have this gap, which is the main reason it is the primary provider.
 *
 * @returns {{ session: MarketSession, marketOpen: boolean }}
 */
export function marketSessionFromClock(now = new Date()) {
  // US equity hours in UTC, ignoring DST (Eastern is UTC-5 or UTC-4). We use
  // the EDT-based window; during EST everything shifts an hour and the edges
  // are wrong by an hour. Another reason this is the fallback, not the primary.
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return { session: 'closed', marketOpen: false }

  const mins = now.getUTCHours() * 60 + now.getUTCMinutes()
  const PRE_OPEN = 8 * 60 // 04:00 ET
  const OPEN = 13 * 60 + 30 // 09:30 ET
  const CLOSE = 20 * 60 // 16:00 ET
  const POST_END = 24 * 60 // 20:00 ET

  if (mins >= OPEN && mins < CLOSE) return { session: 'regular', marketOpen: true }
  if (mins >= PRE_OPEN && mins < OPEN) return { session: 'pre', marketOpen: false }
  if (mins >= CLOSE && mins < POST_END) return { session: 'post', marketOpen: false }
  return { session: 'closed', marketOpen: false }
}

/**
 * Session from Yahoo's own `currentTradingPeriod`, i.e. from the exchange's
 * published schedule rather than our assumptions.
 * @returns {{ session: MarketSession, marketOpen: boolean }}
 */
function marketSessionFromYahoo(meta, nowSec) {
  const p = meta?.currentTradingPeriod
  if (!p) return marketSessionFromClock(new Date(nowSec * 1000))

  const within = (w) => w && nowSec >= Number(w.start) && nowSec < Number(w.end)
  if (within(p.regular)) return { session: 'regular', marketOpen: true }
  if (within(p.pre)) return { session: 'pre', marketOpen: false }
  if (within(p.post)) return { session: 'post', marketOpen: false }
  return { session: 'closed', marketOpen: false }
}

/**
 * @returns {Promise<{ priceUsd: number|null, meta: ReferenceMeta|null, error: string|null }>}
 */
async function fromYahoo(symbol) {
  // Fault injection. The failure paths (cached fallback, and a clean null when
  // there is nothing cached) are the ones most likely to appear in front of an
  // audience and least likely to be exercised in testing, because they depend
  // on an upstream failing at the right moment. This makes them reproducible:
  //   REFERENCE_FORCE_OFFLINE=1 node service.mjs
  if (process.env.REFERENCE_FORCE_OFFLINE === '1') {
    return { priceUsd: null, meta: null, error: 'yahoo: forced offline (REFERENCE_FORCE_OFFLINE=1)' }
  }

  let lastErr = null

  // Alternate hosts, then wait and try again: the 429 is an IP-level cooldown
  // of roughly a minute, so a couple of spaced retries recover it while a tight
  // retry loop only deepens it.
  const attempts = [
    { host: YAHOO_HOSTS[0], waitMs: 0 },
    { host: YAHOO_HOSTS[1], waitMs: 0 },
    { host: YAHOO_HOSTS[0], waitMs: 2000 },
    { host: YAHOO_HOSTS[1], waitMs: 5000 },
  ]

  for (const { host, waitMs } of attempts) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs))
    const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) {
        lastErr = `HTTP ${res.status} from ${host}`
        continue
      }

      const j = await res.json()
      if (j?.chart?.error) {
        // A bad ticker is a permanent answer, not a transient one -- do not
        // retry the other host for it.
        return { priceUsd: null, meta: null, error: `yahoo: ${j.chart.error.description || j.chart.error.code}` }
      }

      const meta = j?.chart?.result?.[0]?.meta
      if (!meta) {
        lastErr = 'yahoo: no meta in response'
        continue
      }

      // regularMarketPrice is the last REGULAR-session trade. Outside market
      // hours it is the closing price, which is exactly the reference we want:
      // the last price the real market agreed on.
      const priceUsd = cleanPrice(meta.regularMarketPrice)
      if (priceUsd === null) {
        lastErr = 'yahoo: no usable regularMarketPrice'
        continue
      }

      const nowSec = Math.floor(Date.now() / 1000)
      const quoteSec = Number(meta.regularMarketTime) || nowSec
      const { session, marketOpen } = marketSessionFromYahoo(meta, nowSec)

      return {
        priceUsd,
        error: null,
        tradingPeriod: meta.currentTradingPeriod ?? null,
        meta: {
          source: 'yahoo-chart',
          symbol: meta.symbol || symbol,
          asOf: new Date(quoteSec * 1000).toISOString(),
          ageSeconds: Math.max(0, nowSec - quoteSec),
          session,
          marketOpen,
          previousCloseUsd: cleanPrice(meta.chartPreviousClose ?? meta.previousClose),
        },
      }
    } catch (e) {
      lastErr = `${host}: ${e.message}`
    }
  }
  return { priceUsd: null, meta: null, error: lastErr || 'yahoo: unavailable' }
}

/**
 * @returns {Promise<{ priceUsd: number|null, meta: ReferenceMeta|null, error: string|null }>}
 */
async function fromFinnhub(symbol) {
  if (process.env.REFERENCE_FORCE_OFFLINE === '1') {
    return { priceUsd: null, meta: null, error: 'finnhub: forced offline (REFERENCE_FORCE_OFFLINE=1)' }
  }

  const key = (process.env.FINNHUB_API_KEY || '').trim()
  if (!key) return { priceUsd: null, meta: null, error: 'finnhub: FINNHUB_API_KEY not set' }

  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return { priceUsd: null, meta: null, error: `finnhub: HTTP ${res.status}` }

    const j = await res.json()

    // Finnhub answers an unknown symbol with c:0 -- a zero that would sail
    // straight into the deviation maths and produce a -100% "arbitrage".
    // cleanPrice turns it into null, which is the entire point of the rule.
    const priceUsd = cleanPrice(j.c)
    if (priceUsd === null) {
      return { priceUsd: null, meta: null, error: `finnhub: no price for ${symbol} (c=${j.c})` }
    }

    const nowSec = Math.floor(Date.now() / 1000)
    const quoteSec = Number(j.t) || nowSec
    const { session, marketOpen } = marketSessionFromClock(new Date(nowSec * 1000))

    return {
      priceUsd,
      error: null,
      meta: {
        source: 'finnhub',
        symbol,
        asOf: new Date(quoteSec * 1000).toISOString(),
        ageSeconds: Math.max(0, nowSec - quoteSec),
        session,
        marketOpen,
        previousCloseUsd: cleanPrice(j.pc),
      },
    }
  } catch (e) {
    return { priceUsd: null, meta: null, error: `finnhub: ${e.message}` }
  }
}

/**
 * Fetch a reference price. Yahoo first; Finnhub only if Yahoo fails AND a key
 * is configured. Returns nulls -- never zeros -- when no provider can answer.
 *
 * @param {string|null} symbol Ticker, or null when the token has no listed
 *   underlying (e.g. SpaceX). Null short-circuits: there is nothing to fetch.
 */
export async function getReferencePrice(symbol) {
  if (!symbol) {
    return { priceUsd: null, meta: null, error: 'no listed underlying for this token' }
  }

  const yahoo = await fromYahoo(symbol)
  if (yahoo.priceUsd !== null) {
    remember(symbol, yahoo.priceUsd, yahoo.meta, yahoo.tradingPeriod)
    return yahoo
  }

  const finnhub = await fromFinnhub(symbol)
  if (finnhub.priceUsd !== null) {
    remember(symbol, finnhub.priceUsd, finnhub.meta, null)
    return finnhub
  }

  // Both providers are down. A real price observed earlier, correctly labelled
  // and correctly aged, beats a null -- and beats a zero absolutely.
  const cached = recall(symbol)
  if (cached) return cached

  return {
    priceUsd: null,
    meta: null,
    error: `all reference providers failed and no cached quote -- ${yahoo.error}; ${finnhub.error}`,
  }
}

/**
 * Cache + single-flight, which is what actually keeps us under Yahoo's limit.
 *
 * A comparison row for NVDA holds several tokens (NVDAon, NVDAx) that all want
 * the same reference price. Without the in-flight map they would fire parallel
 * identical requests and trip a 429 that a cache alone cannot prevent, because
 * nothing is cached yet while the first request is still open.
 */
const cache = new Map()
const inFlight = new Map()
const TTL_MS = 60_000

export async function getReferencePriceCached(symbol) {
  const key = symbol ?? '__none__'

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value

  const pending = inFlight.get(key)
  if (pending) return pending

  const p = (async () => {
    try {
      const value = await getReferencePrice(symbol)
      // Cache successes only. A failure should be retried on the next call,
      // never remembered as though it were an answer.
      if (value.priceUsd !== null) cache.set(key, { at: Date.now(), value })
      return value
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, p)
  return p
}
