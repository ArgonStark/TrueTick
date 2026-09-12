#!/usr/bin/env node
/**
 * Prime the Robinhood adapter's cache before a demo.
 *
 * A cold 24h-volume read costs ~75s because the chain's busiest pool emits
 * ~94k Swap events a day. Run this once before presenting and every subsequent
 * request is instant. It fetches real data -- it does not fabricate a warm
 * cache, it just pays the cost early.
 *
 * Run:  node warm-robinhood.mjs [TICKER ...]     (default: NVDA)
 */
import { byTicker, tickers } from './core/registry.mjs'
import { buildComparison } from './core/point.mjs'

const wanted = process.argv.slice(2).length ? process.argv.slice(2).map((t) => t.toUpperCase()) : ['NVDA']

console.log(`\n  warming: ${wanted.join(', ')}`)
for (const t of wanted) {
  const entries = byTicker(t)
  if (!entries.length) {
    console.log(`  ${t.padEnd(6)} not in registry (have: ${tickers().join(', ')})`)
    continue
  }
  const t0 = Date.now()
  try {
    const d = await buildComparison(t, entries)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`  ${t.padEnd(6)} ${String(d.points.length).padStart(2)} issuers in ${secs}s   ref $${d.referencePriceUsd ?? 'null'}`)
    for (const p of d.points) {
      const px = p.priceUsd === null ? 'null' : '$' + p.priceUsd.toFixed(2)
      console.log(`           ${p.symbol.padEnd(8)} ${p.chain.padEnd(10)} ${px.padStart(10)}  ${p.quality.priceReliable ? 'reliable' : 'FLAGGED'}`)
    }
  } catch (e) {
    console.log(`  ${t.padEnd(6)} FAILED: ${e.message}`)
  }
}
console.log('')
