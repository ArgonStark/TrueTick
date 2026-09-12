#!/usr/bin/env node
/**
 * Dry run: drives the TrueTick MCP server exactly the way Claude Desktop does.
 *
 * A real MCP client over a real stdio transport, spawning the real server as a
 * child process. Nothing here is mocked, so if this passes, the Claude Desktop
 * entry in mcp/README.md will behave the same way.
 *
 *   node mcp/selftest.mjs            free tools only (no HBAR spent)
 *   node mcp/selftest.mjs --pay      also calls get_deviation -> REAL payment
 *   node mcp/selftest.mjs --pay TSLA
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'

const SERVER = fileURLToPath(new URL('./truetick-mcp.mjs', import.meta.url))
const PAY = process.argv.includes('--pay')
const TICKER = (process.argv.find((a) => /^[A-Za-z]{1,6}$/.test(a) && a !== '--pay') || 'NVDA').toUpperCase()

const rule = (t) => console.log(`\n${'-'.repeat(74)}\n${t}\n${'-'.repeat(74)}`)

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  // Inherit the parent env so the server finds the same project env file.
  env: { ...process.env },
  stderr: 'pipe',
})

const client = new Client({ name: 'truetick-selftest', version: '1.0.0' }, { capabilities: {} })

// The harness must not be the bottleneck we are testing for. Claude Desktop's
// own default is 60s; we allow more here so a slow call shows up as a slow
// call with real output, rather than as a client-side cancellation.
const CALL_OPTS = { timeout: 240000, resetTimeoutOnProgress: true, maxTotalTimeout: 300000 }

await client.connect(transport)
transport.stderr?.on('data', (d) => process.stderr.write(`  [server] ${d}`))

rule('1. tools/list — what Claude Desktop will see')
const { tools } = await client.listTools()
for (const t of tools) {
  const paid = /PAID TOOL/.test(t.description)
  const params = Object.keys(t.inputSchema?.properties || {})
  console.log(`\n  ${paid ? '$' : ' '} ${t.name}(${params.join(', ')})`)
  console.log(`      ${t.description.replace(/\s+/g, ' ').slice(0, 210)}...`)
}

// Proof that no tool schema can carry a credential.
const schemaBlob = JSON.stringify(tools)
console.log(
  `\n  schema safety: ${/PRIVATE_KEY|0x[0-9a-f]{64}/i.test(schemaBlob) ? 'FAIL — key-shaped text in a schema' : 'ok — no key-shaped text in any tool schema'}`
)

async function call(name, args = {}) {
  const started = Date.now()
  let res
  try {
    res = await client.callTool(
      { name, arguments: args },
      undefined,
      {
        ...CALL_OPTS,
        // A progress handler is what keeps a long call alive where the client
        // honours it, so exercise the same path Claude Desktop would.
        onprogress: (p) => console.log(`      … ${p.message ?? ''} (${p.progress}/${p.total ?? '?'})`),
      }
    )
  } catch (e) {
    console.log(`\n  [${name}] CLIENT ERROR after ${((Date.now() - started) / 1000).toFixed(1)}s: ${e.message}`)
    return { isError: true, content: [], clientError: e }
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\n  [${name}] ${res.isError ? 'ERROR' : 'ok'} in ${secs}s\n`)
  for (const c of res.content || []) {
    if (c.type === 'text') console.log(c.text.split('\n').map((l) => '    ' + l).join('\n'))
  }
  return res
}

rule('2. warm_up — prime the path so nothing is cold when it matters')
await call('warm_up', { ticker: TICKER })

rule('3. truetick_status — is everything ready')
await call('truetick_status')

rule('4. list_tickers')
await call('list_tickers')

rule('5. get_data_sources — provenance, incl. the self-published subgraph')
await call('get_data_sources')

rule(`6. preview_deviation("${TICKER}") — FREE, prices redacted`)
await call('preview_deviation', { ticker: TICKER })

if (PAY) {
  rule(`7. get_deviation("${TICKER}") — PAID, spends real HBAR on Hedera testnet`)
  const res = await call('get_deviation', { ticker: TICKER })
  const sc = res.structuredContent
  if (sc?.payment?.transactionId) {
    console.log(`\n  >>> PAYMENT TX: ${sc.payment.transactionId}`)
    for (const u of sc.payment.hashscanUrls || []) console.log(`      ${u}`)
  } else if (!res.isError) {
    console.log('\n  (no transaction id returned — was the route gated?)')
  }
} else {
  rule('7. get_deviation — SKIPPED (pass --pay to spend real HBAR)')
}

await client.close()
console.log('\ndone.\n')
process.exit(0)
