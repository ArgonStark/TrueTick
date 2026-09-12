#!/usr/bin/env node
/**
 * TrueTick MCP server — Graph-backed tokenized-stock data for AI environments.
 *
 * A thin shell over the TrueTick services that already exist. It adds no market
 * logic of its own: every number it returns came from core/point.mjs through the
 * same HTTP surface the UI uses, so the MCP view and the browser view cannot
 * disagree.
 *
 * WHAT IT EXPOSES
 *   get_deviation        PAID. Pays real HBAR via x402/Blocky402, returns the
 *                        cross-venue deviation data AND the Hedera tx id.
 *   preview_deviation    FREE. Same shape, prices redacted (never faked).
 *   list_tickers         FREE. What can be asked for.
 *   get_data_sources     FREE. Which Graph product serves which chain.
 *   truetick_status      FREE. Is everything up, is the wallet ready.
 *
 * THE WALLET NEVER REACHES THE MODEL. The operator key is read from the local
 * env file by mcp/pay.mjs and used there. It is not a tool parameter, not in a
 * schema, not in a result, not in an error. Claude's entire authority is to
 * name a ticker; this process decides to spend, what asset, and how much.
 *
 * STDIO DISCIPLINE: stdout is the JSON-RPC channel. Anything written there that
 * is not a protocol message corrupts the session and the client disconnects with
 * an opaque parse error. Every diagnostic in this file goes to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { payAndFetch, walletInfo, hashscanLinks, redact } from './pay.mjs'

// Load the project env file by ABSOLUTE path. Claude Desktop launches the
// server with a working directory we do not control, so a cwd-relative load
// silently finds nothing and the wallet looks unconfigured.
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
try {
  process.loadEnvFile(join(PROJECT_ROOT, '.env'))
} catch {
  /* absent or already exported; truetick_status reports what is actually set */
}

/** The x402-gated service (paid-service.mjs). */
const PAID_URL = (process.env.TRUETICK_PAID_URL || 'http://localhost:4402').replace(/\/+$/, '')
/** The open service (service.mjs) — used only for /sources. */
const FREE_URL = (process.env.TRUETICK_FREE_URL || 'http://localhost:8402').replace(/\/+$/, '')

/**
 * Budgets, sized against the CLIENT's timeout rather than our own patience.
 *
 * Claude Desktop cancels a tool call after 60s by default, and we cannot
 * configure it from this side. A server that happily waits 180s therefore does
 * not produce a slow answer — it produces `MCP error -32001: Request timed out`
 * with no explanation, which is the worst possible thing to hit on camera.
 *
 * So every tool finishes well inside that window and says something useful if
 * the upstream is still cold. A cold Substreams venue really can take ~75s; the
 * answer to that is to warm it deliberately, not to block on it.
 */
const TOOL_TIMEOUT_MS = Number(process.env.TRUETICK_TOOL_TIMEOUT_MS || 45000)
/** Ceiling for warming the data path before a paid call is attempted. */
const WARM_BUDGET_MS = Number(process.env.TRUETICK_WARM_BUDGET_MS || 30000)
/** Ceiling for the payment leg itself, once the data path is known warm. */
const PAY_BUDGET_MS = Number(process.env.TRUETICK_PAY_BUDGET_MS || 25000)
/** Warmed in the background at startup so the first demo call is never cold. */
const AUTOWARM_TICKER = (process.env.TRUETICK_AUTOWARM || 'NVDA').toUpperCase()

const log = (...a) => console.error('[truetick-mcp]', ...a)

// ---------------------------------------------------------------- helpers ---

const usd = (n) =>
  n === null || n === undefined
    ? '—'
    : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const pctStr = (n) =>
  n === null || n === undefined ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(3)}%`

/** Plain JSON GET with a bounded wait and an actionable failure message. */
async function getJson(url, timeoutMs = 30000) {
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    const err = new Error(
      `Cannot reach ${url} (${e.message}). Start the TrueTick services first — ` +
        `see mcp/README.md.`
    )
    err.code = 'SERVICE_UNREACHABLE'
    throw err
  }
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${url} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const err = new Error(body?.error ? String(body.error) : `HTTP ${res.status} from ${url}`)
    err.code = 'SERVICE_ERROR'
    err.body = body
    throw err
  }
  return body
}

/**
 * The outcome-panel summary, computed from the same rules the UI uses.
 *
 * Reliable venues only in the spread. Including a flagged price would report a
 * 428% spread that is an artefact of a phantom-liquidity pool, and a syncing
 * venue has no price at all — counting either would fabricate a comparison.
 */
function summarise(data) {
  const pts = data.points || []
  const syncing = pts.filter((p) => p.source?.syncing || (p.quality?.caveats || []).includes('subgraph-syncing'))
  const reliable = pts.filter((p) => p.quality?.priceReliable && p.priceUsd !== null)
  const flagged = pts.filter((p) => !p.quality?.priceReliable && !syncing.includes(p))

  const chains = [...new Set(pts.map((p) => p.chain))]
  const dexes = [...new Set(pts.map((p) => p.source?.protocol).filter(Boolean))]
  const products = [...new Set(pts.map((p) => (p.source?.product || '').replace(/\s*\(self-published\)/, '')).filter(Boolean))]

  let spreadPct = null
  let cheapest = null
  let richest = null
  if (reliable.length >= 2) {
    const sorted = [...reliable].sort((a, b) => a.priceUsd - b.priceUsd)
    cheapest = sorted[0]
    richest = sorted[sorted.length - 1]
    spreadPct = ((richest.priceUsd - cheapest.priceUsd) / cheapest.priceUsd) * 100
  }

  return {
    venues: pts.length,
    pricing: pts.length - syncing.length,
    indexing: syncing.length,
    chains,
    dexProtocols: dexes,
    graphProducts: products,
    reliableCount: reliable.length,
    spreadPct: spreadPct === null ? null : Number(spreadPct.toFixed(3)),
    cheapest: cheapest ? { symbol: cheapest.symbol, chain: cheapest.chain, priceUsd: cheapest.priceUsd } : null,
    richest: richest ? { symbol: richest.symbol, chain: richest.chain, priceUsd: richest.priceUsd } : null,
    flagged: flagged.map((p) => ({ symbol: p.symbol, chain: p.chain, caveats: p.quality?.caveats || [] })),
    syncing: syncing.map((p) => ({
      symbol: p.symbol,
      chain: p.chain,
      progressPct: p.source?.syncProgressPct ?? null,
    })),
  }
}

/** Human-readable rendering, so the model has good prose to quote on camera. */
function renderText(data, summary, settlementLines = []) {
  const lines = []
  lines.push(`${data.ticker} — reference ${usd(data.referencePriceUsd)}` +
    (data.reference ? ` via ${data.reference.source} (market ${data.reference.marketOpen ? 'open' : 'closed'})` : ''))
  if (!data.reference && data.referenceError) lines.push(`reference unavailable: ${data.referenceError}`)
  lines.push('')
  lines.push(`Coverage: ${summary.venues} venues (${summary.pricing} pricing, ${summary.indexing} indexing) ` +
    `across ${summary.chains.length} chains [${summary.chains.join(', ')}] ` +
    `and ${summary.dexProtocols.length} DEXes [${summary.dexProtocols.join(', ')}], ` +
    `via The Graph (${summary.graphProducts.join(' + ')}).`)

  if (summary.spreadPct !== null) {
    lines.push(`Reliable: ${summary.reliableCount} of ${summary.venues} · ${summary.spreadPct}% spread ` +
      `· cheapest ${summary.cheapest.symbol} ${usd(summary.cheapest.priceUsd)} (${summary.cheapest.chain}) ` +
      `· richest ${summary.richest.symbol} ${usd(summary.richest.priceUsd)} (${summary.richest.chain})`)
  } else {
    lines.push(`Reliable: ${summary.reliableCount} of ${summary.venues} — not comparable (fewer than two reliable venues)`)
  }
  if (summary.flagged.length) {
    lines.push(`Flagged: ${summary.flagged.map((f) => `${f.symbol} (${f.chain}: ${f.caveats.join(', ')})`).join('; ')}`)
  }
  if (summary.syncing.length) {
    lines.push(`Indexing: ${summary.syncing.map((s) => `${s.symbol} (${s.chain}` +
      (s.progressPct === null ? '' : ` ${s.progressPct.toFixed(1)}%`) + ')').join('; ')} — no price yet, excluded from the spread`)
  }

  lines.push('')
  lines.push('Per venue:')
  for (const p of data.points || []) {
    lines.push(`  ${String(p.symbol).padEnd(8)} ${String(p.chain).padEnd(10)} ` +
      `${String(p.source?.protocol || '').padEnd(22)} ${usd(p.priceUsd).padStart(11)}  ` +
      `dev ${pctStr(p.deviationPct).padStart(9)}  TVL ${usd(p.poolTvlUsd).padStart(12)}  ` +
      `[${(p.quality?.caveats || []).join(', ') || 'clean'}]`)
  }

  if (settlementLines.length) {
    lines.push('')
    lines.push(...settlementLines)
  }
  return lines.join('\n')
}

/**
 * Warm the paid service's caches for a ticker, using its own FREE route.
 *
 * This matters because paid-service.mjs and service.mjs are separate processes
 * with separate in-memory caches: warming one does nothing for the other. The
 * free /preview route lives in the SAME process as the gated /price route and
 * runs the same buildComparison, so priming it is what makes the paid call fast.
 *
 * Returns true if the path is warm, false if it is still cold. Never throws —
 * a failed warm-up is a reason to report, not to abort.
 */
/** Tickers known warm, and when. The service's own caches expire around 120s. */
const warmed = new Map()
const WARM_TTL_MS = 90_000
const isWarm = (t) => Date.now() - (warmed.get(t) ?? 0) < WARM_TTL_MS

/** One in-flight fetch per ticker. */
const inflight = new Map()

/**
 * SINGLE-FLIGHT. Concurrent requests for the same ticker share one fetch.
 *
 * Learned the hard way: the startup auto-warm, an explicit warm_up, and a
 * preview all fired their own /preview/NVDA at once. Each triggers a Substreams
 * stream, the provider allows two concurrent sessions, and the adapter
 * serialises the rest — so three "parallel" requests became a queue and every
 * one of them looked like a 75s cold start. Deduping turns them back into one
 * fetch that everybody waits on.
 *
 * The shared fetch gets a long internal budget so it survives any individual
 * caller giving up; callers impose their own deadline with withDeadline().
 */
function sharedFetch(ticker) {
  const existing = inflight.get(ticker)
  if (existing) return existing

  const p = getJson(`${PAID_URL}/preview/${encodeURIComponent(ticker)}`, 150000)
    .then((data) => {
      warmed.set(ticker, Date.now())
      return data
    })
    .finally(() => inflight.delete(ticker))

  inflight.set(ticker, p)
  return p
}

/**
 * Give up waiting without cancelling the underlying work.
 *
 * The distinction matters: the shared fetch keeps running and lands in the
 * cache, so the retry the user is told to make is genuinely fast rather than
 * starting from scratch.
 */
function withDeadline(promise, ms, label = 'request') {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} exceeded ${Math.round(ms / 1000)}s`)
      e.code = 'DEADLINE'
      reject(e)
    }, ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Warm the paid service's caches for a ticker, using its own FREE route.
 *
 * This matters because paid-service.mjs and service.mjs are separate processes
 * with separate in-memory caches: warming one does nothing for the other. The
 * free /preview route lives in the SAME process as the gated /price route and
 * runs the same buildComparison, so priming it is what makes the paid call fast.
 *
 * Returns true if the path is warm, false if it is still cold. Never throws —
 * a failed warm-up is a reason to report, not to abort.
 */
async function warmTicker(ticker, budgetMs = WARM_BUDGET_MS) {
  try {
    await withDeadline(sharedFetch(ticker), budgetMs, `warming ${ticker}`)
    return true
  } catch {
    return false
  }
}

/** Every tool result goes through here, so nothing key-shaped can escape. */
function ok(text, structured) {
  return {
    content: [{ type: 'text', text: redact(text) }],
    structuredContent: structured,
  }
}

function toolError(text, structured) {
  return {
    content: [{ type: 'text', text: redact(text) }],
    structuredContent: structured,
    isError: true,
  }
}

// ------------------------------------------------------------------ tools ---

const GRAPH_NOTE =
  'Data is sourced from The Graph: Subgraphs (Uniswap v4 on Ethereum, and a ' +
  'self-published Aerodrome Slipstream subgraph on Base) and Substreams ' +
  '(Uniswap V3 on Robinhood Chain, Raydium CLMM on Solana).'

const TOOLS = [
  {
    name: 'get_deviation',
    description:
      'PAID TOOL — spends real HBAR. Returns live fair-price and deviation data for one ' +
      'tokenized stock across every venue that lists it (multiple issuers, multiple chains, ' +
      'multiple DEXes), compared against the real-world reference price. ' +
      GRAPH_NOTE + ' ' +
      'Calling this triggers a real x402 micropayment on Hedera testnet settled through the ' +
      'Blocky402 facilitator; the Hedera transaction id is returned so it can be verified on ' +
      'HashScan. The wallet is held server-side and is never exposed. ' +
      'Prices are null rather than zero when unknown, and unreliable venues are flagged, not hidden. ' +
      'A cold data source can take up to ~75 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: {
          type: 'string',
          description: 'Underlying ticker, e.g. "NVDA". Use list_tickers to see what is available.',
        },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'preview_deviation',
    description:
      'FREE TOOL — no payment. Same cross-venue structure, liveness metadata and quality flags as ' +
      'get_deviation, but the prices themselves are REDACTED (null, with a "preview-redacted" ' +
      'caveat) rather than faked. ' + GRAPH_NOTE + ' ' +
      'Use this to show the data shape, the venues and the source provenance without spending HBAR.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Underlying ticker, e.g. "NVDA".' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'list_tickers',
    description:
      'FREE TOOL. Lists every ticker TrueTick can answer for, with the issuers and on-chain ' +
      'symbols behind each, and whether a real-world reference price exists (some, like SpaceX, ' +
      'have no listed underlying so deviation is permanently null).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_data_sources',
    description:
      'FREE TOOL. Returns the machine-readable composition of the data pipeline: which Graph ' +
      'product (Subgraphs or Substreams) serves which chain and DEX protocol, which subgraph was ' +
      'published by this project, and live indexing progress for any source still backfilling. ' +
      'Use this to explain provenance — every venue states where its numbers come from.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'warm_up',
    description:
      'FREE TOOL — no payment. Primes the data path for a ticker so a later get_deviation call ' +
      'returns quickly. The first fetch after a restart can take ~75 seconds because a Substreams ' +
      'venue has to cold-start; every fetch after that is cached and fast. Call this once before ' +
      'a demo or a paid call.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Ticker to warm, e.g. "NVDA". Defaults to NVDA.' },
      },
    },
  },
  {
    name: 'truetick_status',
    description:
      'FREE TOOL. Health check before relying on the others: whether the paid and free TrueTick ' +
      'services are reachable, the payment terms (network, facilitator, price per call), and ' +
      'whether a paying wallet is configured. Reports the wallet ADDRESS only — never the key.',
    inputSchema: { type: 'object', properties: {} },
  },
]

// --------------------------------------------------------------- handlers ---

/**
 * Progress notifications for a long call.
 *
 * Clients MAY reset their timeout when progress arrives, so this buys headroom
 * where it is honoured — but it is not relied upon. The budgets above are what
 * actually guarantee we answer before the client gives up; this just makes the
 * wait legible while it happens.
 */
function progressNotifier(extra) {
  const progressToken = extra?._meta?.progressToken
  let step = 0
  return (message) => {
    if (progressToken === undefined || !extra?.sendNotification) return
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: ++step, total: 5, message },
      })
      .catch(() => { /* best-effort */ })
  }
}

async function handleGetDeviation(args, extra) {
  const ticker = String(args?.ticker || '').trim().toUpperCase()
  if (!ticker) return toolError('A ticker is required, e.g. { "ticker": "NVDA" }.', { error: 'missing_ticker' })

  const onProgress = progressNotifier(extra)

  const url = `${PAID_URL}/price/${encodeURIComponent(ticker)}`

  try {
    // WARM BEFORE PAYING, deliberately.
    //
    // Two reasons, and the second is the important one. (1) A cold Substreams
    // venue can take ~75s, which blows past the client's 60s cancel and turns a
    // working system into an opaque timeout. (2) If we paid first and then hit
    // that wall, the payment could settle while the client has already given up
    // — money spent, nothing shown, and no way to tell from the transcript
    // whether we were charged. Warming first makes the paid leg short and
    // predictable, and costs nothing but a free request.
    if (!isWarm(ticker)) {
      onProgress('warming the data path (free request, no payment yet)')
      const warm = await warmTicker(ticker, WARM_BUDGET_MS)
      if (!warm) {
        // Keep warming in the background so the retry lands hot.
        warmTicker(ticker, 120000).catch(() => {})
        return ok(
          [
            `The data path for ${ticker} is still cold, so NO PAYMENT WAS MADE.`,
            '',
            `A Substreams venue takes up to ~75s on its first use after a restart.`,
            `Warming is now running in the background.`,
            '',
            `Call get_deviation("${ticker}") again in ~30 seconds — it will be fast,`,
            `and only then will HBAR be spent.`,
          ].join('\n'),
          { ticker, paid: false, charged: false, state: 'warming', retryInSeconds: 30 }
        )
      }
    }

    onProgress('data path warm — proceeding to payment')

    const { data, settlement, paid, priceTinybar } = await payAndFetch(url, {
      timeoutMs: PAY_BUDGET_MS,
      onProgress,
    })
    warmed.set(ticker, Date.now())

    const summary = summarise(data)
    const txId = settlement?.transaction ?? null
    const links = hashscanLinks(txId)

    const settlementLines = []
    if (paid) {
      settlementLines.push('Payment (x402 via Blocky402 on Hedera testnet):')
      settlementLines.push(`  success     : ${settlement?.success}`)
      settlementLines.push(`  payer       : ${settlement?.payer ?? walletInfo().accountId ?? '(unknown)'}`)
      settlementLines.push(`  amount      : ${priceTinybar ?? '(unknown)'} tinybar` +
        (priceTinybar ? ` (${Number(priceTinybar) / 1e8} HBAR)` : ''))
      settlementLines.push(`  transaction : ${txId ?? '(none reported)'}`)
      for (const l of links) settlementLines.push(`  verify      : ${l}`)
    } else {
      settlementLines.push('No payment was required by the server for this request.')
    }

    return ok(renderText(data, summary, settlementLines), {
      ticker: data.ticker,
      paid,
      payment: paid
        ? {
            network: 'hedera:testnet',
            facilitator: 'blocky402',
            success: settlement?.success ?? null,
            transactionId: txId,
            payer: settlement?.payer ?? null,
            amountTinybar: priceTinybar,
            hashscanUrls: links,
          }
        : null,
      summary,
      referencePriceUsd: data.referencePriceUsd,
      reference: data.reference,
      points: data.points,
      sourceErrors: data.sourceErrors ?? [],
      fetchedAt: data.fetchedAt,
    })
  } catch (e) {
    return toolError(describeFailure(e, ticker, true), {
      error: e.code || 'PAID_CALL_FAILED',
      message: redact(e.message),
      charged: e.notCharged === true ? false : null,
      ticker,
    })
  }
}

/**
 * Turn a failure into something the operator can act on mid-demo.
 *
 * A bare stack trace on screen is useless; "the service is not running, here is
 * the command" is not.
 */
function describeFailure(e, ticker, wasPaid) {
  const msg = redact(e.message || String(e))
  const lines = [`Could not complete ${wasPaid ? 'the paid' : 'the free'} request for ${ticker}.`, '', `Reason: ${msg}`, '']

  switch (e.code) {
    case 'SERVICE_UNREACHABLE':
      lines.push('Fix: start the TrueTick services, then retry:')
      lines.push('  node paid-service.mjs     # port 4402, the x402-gated surface')
      lines.push('  node service.mjs          # port 8402, free surface + UI')
      break
    case 'DEADLINE':
      lines.push('The data path is cold — a Substreams venue takes up to ~75s on first use.')
      lines.push('The fetch is STILL RUNNING in the background and will be cached when it lands,')
      lines.push('so retrying shortly is fast. No payment was attempted.')
      break
    case 'NO_WALLET':
    case 'BAD_WALLET':
      lines.push('Fix: the MCP server process has no usable OPERATOR_PRIVATE_KEY.')
      lines.push('Set it in the project env file, or in the "env" block of the Claude Desktop entry.')
      lines.push('preview_deviation still works with no wallet at all.')
      break
    case 'MIRROR_RATE_LIMIT':
    case 'MIRROR_UNREACHABLE':
      lines.push('Fix: set HEDERA_ACCOUNT_ID=0.0.x in the MCP server env to skip the mirror lookup.')
      break
    case 'NO_ACCOUNT':
      lines.push('Fix: fund the account on Hedera testnet before paying.')
      break
    case 'PAID_REQUEST_FAILED':
      lines.push('The x402 middleware cancels settlement when the handler fails, so NO HBAR was spent.')
      break
    default:
      if (/timed out|TimeoutError|aborted/i.test(msg)) {
        lines.push(`The request exceeded ${Math.round(TOOL_TIMEOUT_MS / 1000)}s. A cold Substreams venue`)
        lines.push('can take ~75s; the first call after a restart is the slow one.')
        lines.push('Retry, or call preview_deviation first to warm the data path without paying.')
      } else {
        lines.push('Try preview_deviation to confirm the data path independently of payment.')
      }
  }
  return lines.join('\n')
}

async function handlePreview(args, extra) {
  const ticker = String(args?.ticker || '').trim().toUpperCase()
  if (!ticker) return toolError('A ticker is required, e.g. { "ticker": "NVDA" }.', { error: 'missing_ticker' })

  // The free path can be the cold one too, so it reports progress as well.
  progressNotifier(extra)('fetching across all venues (cold sources can take ~75s)')

  try {
    // Shares the in-flight fetch with warm_up and with get_deviation's warming
    // step, so three tools in quick succession cost one round trip, not three.
    const data = await withDeadline(sharedFetch(ticker), TOOL_TIMEOUT_MS, `preview for ${ticker}`)
    const summary = summarise(data)
    const text = renderText(data, summary, [
      'FREE PREVIEW — prices are redacted (null), not fabricated.',
      `Call get_deviation("${ticker}") to pay and receive the real numbers.`,
    ])
    return ok(text, {
      ticker: data.ticker,
      preview: true,
      paid: false,
      summary,
      points: data.points,
      sourceErrors: data.sourceErrors ?? [],
      note: data.note,
      fetchedAt: data.fetchedAt,
    })
  } catch (e) {
    return toolError(describeFailure(e, ticker, false), {
      error: e.code || 'PREVIEW_FAILED',
      message: redact(e.message),
      ticker,
    })
  }
}

async function handleListTickers() {
  try {
    const data = await getJson(`${PAID_URL}/tickers`, 20000)
    const rows = (data.tickers || []).map(
      (t) => `  ${String(t.ticker).padEnd(7)} ${t.symbols.join(', ').padEnd(34)} ` +
        `${t.hasReference ? 'reference available' : 'NO reference (deviation stays null)'}`
    )
    return ok(
      [`${(data.tickers || []).length} tickers available.`, '', ...rows, '', GRAPH_NOTE].join('\n'),
      data
    )
  } catch (e) {
    return toolError(describeFailure(e, 'the ticker list', false), {
      error: e.code || 'LIST_FAILED',
      message: redact(e.message),
    })
  }
}

async function handleDataSources() {
  try {
    const data = await getJson(`${FREE_URL}/sources`, 30000)
    const lines = ['TrueTick data pipeline — every venue states its own provenance.', '']
    for (const product of data.graphProducts || []) {
      lines.push(`${product.product} (${product.provider}) — credential configured: ${product.configured}`)
      for (const a of product.adapters || []) {
        lines.push(`  ${String(a.chain).padEnd(10)} ${String(a.protocol).padEnd(22)} ${a.tokens} tokens` +
          (a.selfPublished ? '   [SUBGRAPH PUBLISHED BY THIS PROJECT]' : ''))
        if (a.status) {
          lines.push(`      status: ${a.status.state} ${a.status.progressPct ?? '?'}% ` +
            `(block ${a.status.indexedBlock ?? '?'} of ${a.status.chainHeadBlock ?? '?'})`)
        }
      }
      lines.push('')
    }
    lines.push(`Leverage: ${data.leverage?.chains} chains, ${(data.leverage?.dexProtocols || []).length} DEX protocols, ` +
      `${data.leverage?.graphProducts} Graph products, one normalized schema.`)
    return ok(lines.join('\n'), data)
  } catch (e) {
    return toolError(describeFailure(e, 'the data sources', false), {
      error: e.code || 'SOURCES_FAILED',
      message: redact(e.message),
    })
  }
}

async function handleWarmUp(args, extra) {
  const ticker = String(args?.ticker || AUTOWARM_TICKER).trim().toUpperCase()
  const note = progressNotifier(extra)
  note(`warming ${ticker} — first fetch can take ~75s`)

  const started = Date.now()
  const warm = await warmTicker(ticker, TOOL_TIMEOUT_MS)
  const secs = ((Date.now() - started) / 1000).toFixed(1)

  if (warm) {
    return ok(
      `${ticker} is warm (${secs}s). get_deviation("${ticker}") will now be fast, and is the call that spends HBAR.`,
      { ticker, warm: true, seconds: Number(secs) }
    )
  }
  // Keep going in the background rather than leaving it cold.
  warmTicker(ticker, 120000).catch(() => {})
  return ok(
    [
      `${ticker} did not finish warming within ${Math.round(TOOL_TIMEOUT_MS / 1000)}s.`,
      'Warming continues in the background — call warm_up again shortly.',
      'No payment was attempted.',
    ].join('\n'),
    { ticker, warm: false, seconds: Number(secs), state: 'warming' }
  )
}

async function handleStatus() {
  const out = { paidService: null, freeService: null, wallet: walletInfo(), toolTimeoutMs: TOOL_TIMEOUT_MS }
  const lines = ['TrueTick MCP status', '']

  try {
    const h = await getJson(`${PAID_URL}/health`, 10000)
    out.paidService = { url: PAID_URL, reachable: true, payment: h.payment }
    lines.push(`  paid service : UP   ${PAID_URL}`)
    lines.push(`                 ${h.payment?.priceHbar} HBAR per call, asset ${h.payment?.asset}`)
    lines.push(`                 network ${h.payment?.network}, facilitator ${h.payment?.facilitator}`)
  } catch (e) {
    out.paidService = { url: PAID_URL, reachable: false, error: redact(e.message) }
    lines.push(`  paid service : DOWN ${PAID_URL}  — start it with: node paid-service.mjs`)
  }

  try {
    const h = await getJson(`${FREE_URL}/health`, 10000)
    out.freeService = { url: FREE_URL, reachable: true, tickers: h.tickers, tokens: h.tokens }
    lines.push(`  free service : UP   ${FREE_URL}  (${h.tickers} tickers, ${h.tokens} tokens)`)
  } catch (e) {
    out.freeService = { url: FREE_URL, reachable: false, error: redact(e.message) }
    lines.push(`  free service : DOWN ${FREE_URL}  — start it with: node service.mjs`)
  }

  lines.push('')
  if (out.wallet.configured) {
    lines.push(`  wallet       : configured  ${out.wallet.evmAddress}`)
    lines.push(`                 (address only — the private key is never exposed to the model)`)
  } else {
    lines.push(`  wallet       : NOT configured — ${out.wallet.reason}`)
    lines.push(`                 preview_deviation still works without a wallet.`)
  }
  return ok(lines.join('\n'), out)
}

// ------------------------------------------------------------------ wiring --

const server = new Server(
  { name: 'truetick', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params
  log(`tool call: ${name}`)
  try {
    switch (name) {
      case 'get_deviation':     return await handleGetDeviation(args, extra)
      case 'preview_deviation': return await handlePreview(args, extra)
      case 'warm_up':           return await handleWarmUp(args, extra)
      case 'list_tickers':      return await handleListTickers()
      case 'get_data_sources':  return await handleDataSources()
      case 'truetick_status':   return await handleStatus()
      default:
        return toolError(`Unknown tool "${name}".`, { error: 'unknown_tool', name })
    }
  } catch (e) {
    // Last line of defence: an unhandled throw here would surface as a protocol
    // error with no explanation, mid-demo.
    log('unhandled error:', redact(e?.stack || e?.message || String(e)))
    return toolError(
      `Unexpected error in ${name}: ${redact(e?.message || String(e))}`,
      { error: 'unhandled', tool: name }
    )
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)

log(`ready — paid ${PAID_URL} · free ${FREE_URL} · tool budget ${TOOL_TIMEOUT_MS}ms`)
log(`wallet ${walletInfo().configured ? 'configured (' + walletInfo().evmAddress + ')' : 'NOT configured'}`)

// Warm the default ticker in the background as soon as the server starts.
// Claude Desktop launches this process when the app opens, so by the time
// anyone calls a tool the slow first fetch has usually already happened. It is
// deliberately fire-and-forget: warming must never delay `initialize`, and a
// failure here is not a reason for the server to be unavailable.
warmTicker(AUTOWARM_TICKER, 120000)
  .then((warm) => log(`autowarm ${AUTOWARM_TICKER}: ${warm ? 'warm' : 'failed (services down?)'}`))
  .catch(() => {})
