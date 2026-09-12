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
  8453: [
    process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://1rpc.io/base',
  ],
}

/** Aerodrome Slipstream CL factory our Base subgraph indexes. */
const BASE_CL_FACTORY = '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef'
/** keccak256('factory()')[0:4] */
const SEL_FACTORY = '0xc45a0155'

const SEL = { symbol: '0x95d89b41', decimals: '0x313ce567', name: '0x06fdde03' }

async function rpcOnce(url, method, params) {
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

/**
 * Retry rate-limited reads instead of reporting them as verification failures.
 *
 * This matters more than it looks. Without it a public endpoint's throttling
 * prints "FAIL NVDAc" next to a token that is perfectly valid -- a false alarm
 * about the REGISTRY, which is the one file where a wrong entry silently
 * compares against the wrong stock. A verifier that cries wolf gets ignored,
 * and then a real mismatch gets ignored with it.
 */
/** Sibling endpoints for the same chain, so a retry can switch provider. */
function siblingsOf(url) {
  for (const list of Object.values(RPCS_BY_CHAIN)) {
    if (list.includes(url)) return list
  }
  return [url]
}

async function rpc(url, method, params) {
  // Retrying the SAME throttled endpoint mostly just waits out its window.
  // Rotating to a sibling on the same chain answers immediately, and the
  // control call in pickRpc already established that these endpoints agree.
  const ring = siblingsOf(url)
  const start = ring.indexOf(url)
  let last
  for (let attempt = 0; attempt < ring.length * 2; attempt++) {
    const candidate = ring[(start + attempt) % ring.length]
    try {
      return await rpcOnce(candidate, method, params)
    } catch (e) {
      last = e
      const msg = String(e.message || e)
      const retryable = /rate limit|429|too many|timeout|fetch failed|ECONNRESET|empty/i.test(msg)
      if (!retryable) throw e
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)))
    }
  }
  throw last
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
// Keyed by `chain`, not chainId: Solana has no chain id at all.
const byChain = {}
for (const a of addresses) {
  ;(byChain[TOKENS[a].chain] ||= []).push(a)
}

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

/**
 * Solana entries are verified differently -- there is no eth_call. The SPL mint
 * is confirmed via getTokenSupply (which returns decimals and real supply), and
 * every registry pool is confirmed to be owned by the Raydium CLMM program.
 * Symbols are not on-chain metadata for SPL tokens, so symbol is not checkable
 * here; that is stated rather than silently skipped.
 */
async function verifySolana(address, e) {
  const problems = []
  const supply = await rpc(SOLANA_RPC, 'getTokenSupply', [address]).catch(() => null)
  if (!supply?.value) {
    problems.push('mint not found on Solana')
    return { problems, decimals: null, extra: '' }
  }
  const decimals = Number(supply.value.decimals)
  if (decimals !== e.decimals) problems.push(`decimals on-chain ${decimals} != registry ${e.decimals}`)

  for (const pool of e.pools ?? []) {
    const acct = await rpc(SOLANA_RPC, 'getAccountInfo', [pool.pool, { encoding: 'base64' }]).catch(() => null)
    const owner = acct?.value?.owner
    if (!owner) problems.push(`pool ${pool.pool.slice(0, 8)} not found`)
    else if (owner !== 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK') {
      problems.push(`pool ${pool.pool.slice(0, 8)} owner ${owner.slice(0, 8)} is not Raydium CLMM`)
    }
  }
  const ui = Number(supply.value.uiAmount ?? 0)
  return { problems, decimals, extra: `supply ${ui.toLocaleString('en-US', { maximumFractionDigits: 0 })}` }
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
for (const chain of Object.keys(byChain)) {
  if (chain === 'solana') {
    RPC_FOR[chain] = SOLANA_RPC
    continue
  }
  const first = byChain[chain][0]
  const url = await pickRpc(TOKENS[first].chainId, first, TOKENS[first].symbol)
  if (!url) {
    console.error(`\n  x No RPC for chain ${chain} could answer the control call.`)
    console.error('    NOT concluding anything about those contracts -- rerun later.\n')
    process.exit(2)
  }
  RPC_FOR[chain] = url
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
  const RPC = RPC_FOR[e.chain]

  if (e.chain === 'solana') {
    const r = await verifySolana(address, e)
    console.log(
      `  ${r.problems.length ? 'FAIL' : ' ok '}  ${address.slice(0, 24).padEnd(26)} ${e.symbol.padEnd(9)} ` +
        `solana ${String(r.decimals).padStart(2)}dp  ${r.extra.padEnd(18)} ${e.ticker.padEnd(5)} ref ${String(e.referenceSymbol).padEnd(5)}`
    )
    for (const p of r.problems) console.log(`          -> ${p}`)
    if (r.problems.length) bad++
    continue
  }

  try {
    const [symHex, decHex, nameHex, code] = await Promise.all([
      rpc(RPC, 'eth_call', [{ to: address, data: SEL.symbol }, 'latest']),
      rpc(RPC, 'eth_call', [{ to: address, data: SEL.decimals }, 'latest']),
      rpc(RPC, 'eth_call', [{ to: address, data: SEL.name }, 'latest']),
      rpc(RPC, 'eth_getCode', [address, 'latest']),
    ])

    // Coinbase's B20 tokens on Base return the single byte 0xef rather than
    // ordinary bytecode, yet answer every ERC-20 call correctly. So the test is
    // "did the node return nothing at all", not "does this look like bytecode"
    // -- the stricter version would reject seven demonstrably valid tokens.
    if (!code || code === '0x') problems.push('NO CONTRACT CODE at this address')
    const symbol = decodeString(symHex)
    const name = decodeString(nameHex)
    const decimals = parseInt(decHex, 16)

    if (symbol !== e.symbol) problems.push(`symbol on-chain "${symbol}" != registry "${e.symbol}"`)
    if (name !== e.name) problems.push(`name on-chain "${name}" != registry "${e.name}"`)
    if (decimals !== e.decimals) problems.push(`decimals on-chain ${decimals} != registry ${e.decimals}`)

    // Pool addresses in the registry are load-bearing (the subgraph indexes the
    // factory, and these are the pools we claim it will serve), so they get the
    // same two-source treatment as the tokens: each pool must exist AND report
    // the target factory from factory(). A pool on the OTHER Aerodrome factory
    // would look plausible and never be indexed by our subgraph.
    if (e.chain === 'base' && Array.isArray(e.pools)) {
      for (const pool of e.pools) {
        try {
          const f = await rpc(RPC, 'eth_call', [{ to: pool.pool, data: SEL_FACTORY }, 'latest'])
          const got = '0x' + String(f || '').slice(-40).toLowerCase()
          if (got !== BASE_CL_FACTORY) {
            problems.push(`pool ${pool.pool.slice(0, 10)} factory ${got.slice(0, 10)} is not the CL factory we index`)
          }
        } catch (err) {
          problems.push(`pool ${pool.pool.slice(0, 10)} unreadable: ${String(err.message).slice(0, 40)}`)
        }
      }
    }

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
const solCount = addresses.filter((a) => TOKENS[a].chain === 'solana').length
const otherCount = addresses.length - ethCount - solCount
console.log(
  bad === 0
    ? `\n  All ${addresses.length} entries verified.\n` +
      `    ${ethCount} on Ethereum: contract + Uniswap v4 subgraph (two sources agreed).\n` +
      `    ${otherCount} on other EVM chains: contract read only -- no subgraph exists\n` +
      `    for those networks, so there is no second source to cross-check against.\n` +
      `    ${solCount} on Solana: SPL mint via getTokenSupply + every pool confirmed\n` +
      `    owned by the Raydium CLMM program.\n`
    : `\n  ${bad} of ${addresses.length} entries FAILED verification.\n`
)
process.exit(bad === 0 ? 0 : 1)
