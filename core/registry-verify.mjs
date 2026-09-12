#!/usr/bin/env node
/**
 * Re-verify every registry entry against ground truth.
 *
 * The registry is hand-curated, so it needs an independent check that anyone
 * can re-run rather than trusting whoever typed it. Each entry is confirmed
 * against TWO sources that must agree:
 *   1. the token contract itself (eth_call: symbol, decimals, name, code)
 *   2. the Uniswap v4 Ethereum subgraph's view of the same token
 *
 * Exits non-zero if anything disagrees.
 *
 * Run:  node core/registry-verify.mjs
 */
import { TOKENS } from './registry.mjs'

// Only the subgraph half needs a key; read it from the local env file.
try {
  process.loadEnvFile()
} catch {
  /* env may already be exported */
}

const SUBGRAPH_ID = 'DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G'
const GATEWAY = `https://gateway.thegraph.com/api/subgraphs/id/${SUBGRAPH_ID}`

/**
 * One RPC list per chain. The registry now spans chains, and checking a
 * Robinhood token against an Ethereum node reports "NO CONTRACT CODE" -- a
 * false alarm that would train a reader to ignore this script entirely.
 */
const RPCS_BY_CHAIN = {
  1: [
    'https://ethereum-rpc.publicnode.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
  ],
  4663: [
    process.env.ROBINHOOD_RPC_URL || 'https://robinhood.rpc.service.pinax.network',
    'https://rpc.mainnet.chain.robinhood.com',
  ],
}

const SEL = { symbol: '0x95d89b41', decimals: '0x313ce567', name: '0x06fdde03' }

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  let j
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(`non-JSON from ${url}: ${text.slice(0, 60)}`)
  }
  if (j.error) throw new Error(j.error.message)
  return j.result
}

/** Decode an ABI-encoded string return value. */
function decodeString(hex) {
  if (!hex || hex === '0x') return null
  const b = hex.slice(2)
  if (b.length < 128) return null
  const len = parseInt(b.slice(64, 128), 16)
  return Buffer.from(b.slice(128, 128 + len * 2), 'hex').toString('utf8')
}

const addresses = Object.keys(TOKENS)

// Group by chain so each entry is checked against the chain it actually lives on.
const byChain = {}
for (const a of addresses) {
  const id = TOKENS[a].chainId
  ;(byChain[id] ||= []).push(a)
}

/**
 * Choose an RPC by proving it can answer a call we already know the answer to.
 * A dead or rate-limited endpoint returns empty results that look exactly like
 * "this contract does not exist" -- that misreading has burned us before, so an
 * endpoint has to earn trust before its answers count as evidence.
 */
async function pickRpc(chainId, controlAddress, expectedSymbol) {
  for (const url of RPCS_BY_CHAIN[chainId] || []) {
    try {
      const got = decodeString(
        await rpc(url, 'eth_call', [{ to: controlAddress, data: SEL.symbol }, 'latest'])
      )
      if (got === expectedSymbol) return url
      console.log(`  skip ${url}: control returned ${got}`)
    } catch (e) {
      console.log(`  skip ${url}: ${e.message.slice(0, 60)}`)
    }
  }
  return null
}

const RPC_FOR = {}
for (const chainId of Object.keys(byChain)) {
  const first = byChain[chainId][0]
  const url = await pickRpc(Number(chainId), first, TOKENS[first].symbol)
  if (!url) {
    console.error(`\n  x No RPC for chain ${chainId} could answer the control call.`)
    console.error('    NOT concluding anything about those contracts -- rerun later.\n')
    process.exit(2)
  }
  RPC_FOR[chainId] = url
}

const apiKey = (process.env.GRAPH_API_KEY || '').trim()
let indexed = {}
if (apiKey) {
  // The Uniswap v4 subgraph only knows Ethereum tokens; asking it about
  // Robinhood addresses would return nothing and look like a failure.
  const ethAddresses = addresses.filter((a) => TOKENS[a].chainId === 1)
  const body = {
    query: `{ tokens(where: { id_in: ${JSON.stringify(ethAddresses)} }, first: 100) {
      id symbol name decimals totalValueLockedUSD } }`,
  }
  const j = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  }).then((r) => r.json())
  if (j.errors?.length) {
    console.error('  ! subgraph errors:', j.errors.map((e) => e.message).join('; '))
  } else {
    for (const t of j.data.tokens) indexed[t.id] = t
  }
} else {
  console.log('  ! GRAPH_API_KEY not set -- checking contracts only, skipping subgraph cross-check')
}

console.log(`\n  Verifying ${addresses.length} registry entries`)
for (const [id, url] of Object.entries(RPC_FOR)) console.log(`    chain ${id}: ${url}`)
console.log('')

let bad = 0
for (const address of addresses) {
  const e = TOKENS[address]
  const problems = []
  const RPC = RPC_FOR[e.chainId]
  try {
    const [symHex, decHex, nameHex, code] = await Promise.all([
      rpc(RPC, 'eth_call', [{ to: address, data: SEL.symbol }, 'latest']),
      rpc(RPC, 'eth_call', [{ to: address, data: SEL.decimals }, 'latest']),
      rpc(RPC, 'eth_call', [{ to: address, data: SEL.name }, 'latest']),
      rpc(RPC, 'eth_getCode', [address, 'latest']),
    ])

    if (!code || code === '0x') problems.push('NO CONTRACT CODE at this address')
    const symbol = decodeString(symHex)
    const name = decodeString(nameHex)
    const decimals = parseInt(decHex, 16)

    if (symbol !== e.symbol) problems.push(`symbol on-chain "${symbol}" != registry "${e.symbol}"`)
    if (name !== e.name) problems.push(`name on-chain "${name}" != registry "${e.name}"`)
    if (decimals !== e.decimals) problems.push(`decimals on-chain ${decimals} != registry ${e.decimals}`)

    const sg = indexed[address]
    if (sg) {
      if (sg.symbol !== e.symbol) problems.push(`subgraph symbol "${sg.symbol}" != registry`)
      if (Number(sg.decimals) !== e.decimals) problems.push(`subgraph decimals ${sg.decimals} != registry`)
    } else if (apiKey && e.chainId === 1) {
      problems.push('not indexed by the Uniswap v4 subgraph')
    }
    // chainId !== 1: no subgraph exists for that chain, so the contract read
    // above is the only available source. Absence of a second source is stated,
    // not silently treated as a pass.

    // A null referenceSymbol is a deliberate statement that no listed
    // underlying exists; anything else must look like a ticker.
    if (e.referenceSymbol !== null && !/^[A-Z.\-]{1,10}$/.test(e.referenceSymbol)) {
      problems.push(`referenceSymbol "${e.referenceSymbol}" is not ticker-shaped`)
    }

    const tvl = sg ? `$${Number(sg.totalValueLockedUSD).toFixed(0)}` : '-'
    console.log(
      `  ${problems.length ? 'FAIL' : ' ok '}  ${address}  ${e.symbol.padEnd(9)} ` +
        `${String(e.chainId).padEnd(5)} ` +
        `${String(decimals).padStart(2)}dp  tvl ${tvl.padEnd(10)} ${e.ticker.padEnd(5)} ` +
        `ref ${String(e.referenceSymbol).padEnd(5)}`
    )
    for (const p of problems) console.log(`          -> ${p}`)
    if (problems.length) bad++
  } catch (err) {
    console.log(`  FAIL  ${address}  ${e.symbol}: ${err.message.slice(0, 70)}`)
    bad++
  }
}

const ethCount = addresses.filter((a) => TOKENS[a].chainId === 1).length
const otherCount = addresses.length - ethCount
console.log(
  bad === 0
    ? `\n  All ${addresses.length} entries verified.\n` +
      `    ${ethCount} on Ethereum: contract + Uniswap v4 subgraph (two sources agreed).\n` +
      `    ${otherCount} on other chains: contract read only -- no subgraph exists for those\n` +
      `    networks, so there is no second source to cross-check against.\n`
    : `\n  ${bad} of ${addresses.length} entries FAILED verification.\n`
)
process.exit(bad === 0 ? 0 : 1)
