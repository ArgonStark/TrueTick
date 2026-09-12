# TrueTick

**One source of truth for tokenized-stock prices across issuers and chains — sold to AI agents over x402.**

ETHOnline 2026 submission.

---

## The problem

The same real-world stock is now tokenized by several issuers, on several
chains, trading in several DEX pools. NVDA alone exists as **NVDAon** (Ondo,
Ethereum), **NVDAx** (Backed, Ethereum *and* Solana), **NVDA** (Robinhood
Chain), and **NVDAc** (Coinbase B20, Base).

They do not agree. Right now, one of those NVDA markets prices at **$1,153**
against a real-world $218 — a pool holding $27k that has not traded in 24
hours. A per-chain dashboard shows you one venue and tells you nothing about
the other four.

So: which price is real? TrueTick answers that in one place, and sells the
answer to agents that need it.

---

## What it does

A live fair-price and deviation view for the same ticker across every venue
that lists it, measured against the real-world reference price.

- **5 venues, 4 chains, 4 DEX protocols** for NVDA (36 tokens across 19 tickers
  in total).
- Reliable venues typically agree within **~0.5–0.8%** of each other. That
  agreement is the product: it is what makes the outlier visible.
- **Quality flags, not hidden rows.** `phantom-liquidity`, `thin-volume`,
  `price-divergence`, `market-closed`, `subgraph-syncing`, `source-error` and
  others. A bad price is shown *and* labelled, never quietly dropped.
- **Null, never zero.** Every price-like field is `number | null`. A missing
  price renders as `—`. A `0` would propagate silently through arithmetic and
  look like a real price — which is exactly how two silent-$0 subgraph bugs in
  this repo would otherwise have shipped unnoticed.
- **Honest headline numbers.** The quoted spread is computed across *reliable*
  venues only. Including the flagged NVDAx pool would report a spectacular
  "428% spread" that is an artefact of a broken pool, not a market fact. The
  flagged venue stays visible and named; it just does not contaminate the
  headline.

---

## Architecture

**One normalized schema, one adapter per source.**

Every source produces the same shape — `TokenizedStockPoint` in
[`core/types.ts`](core/types.ts). An adapter knows about its own venue and
nothing else. Adding a chain or a DEX is a new adapter file plus registry rows;
the schema, the quality rules, the HTTP service and the UI are untouched.

That is not a claim, it is the record: adding **Solana** — non-EVM, base58
addresses, no chain id, a DEX with no swap event to read — required **zero**
schema changes. `core/types.ts` gained two optional fields.

```
core/types.ts        the shared contract
core/registry.mjs    36 tokens, keyed by ADDRESS, never symbol-matched
core/point.mjs       adapter routing + quality judgement
core/adapters/       one file per venue
ui/index.html        single-page UI, live data only
```

### Data sources

| Chain | Issuer | DEX | Graph product | Status |
|---|---|---|---|---|
| Ethereum | Ondo, Backed | Uniswap v4 | **Subgraph** (Uniswap's) | live |
| Robinhood Chain | Robinhood | Uniswap V3 | **Substreams** | live |
| Solana | Backed (xStocks) | Raydium CLMM | **Substreams** | live |
| Base | Coinbase (B20) | Aerodrome Slipstream | **Subgraph — published by us** | indexing |

Two distinct Graph products feed one schema, and **we are a publisher, not only
a consumer.**

Base has the deepest tokenized-stock liquidity we surveyed, but **no published
subgraph indexed those pools.** Rather than drop to a non-Graph data source, we
forked `Uniswap/v3-subgraph`, repointed it at the Aerodrome Slipstream CL
factory `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef`, fixed two bugs that would
have made every USD value silently `$0`, and published it to the decentralized
network as `truetick-aerodrome-base`.

**Our published subgraph:**

| | |
|---|---|
| Explorer (public) | [`dmEWVWdRS6GajSuddosHSKBJs51z9mjpLmbW4iBgWLg`](https://thegraph.com/explorer/subgraphs/dmEWVWdRS6GajSuddosHSKBJs51z9mjpLmbW4iBgWLg) |
| Deployment | `QmQX5qLeHm86pbTpUTLsYMxYofGRDFoEw5kV3zQhFFBAZX` |
| Studio (author's dashboard) | https://thegraph.com/studio/subgraph/truetick-aerodrome-base/ |
| Source in this repo | [`subgraph/`](subgraph/) |

Use the **Explorer** link to inspect it — the Studio link is our own dashboard
and redirects anyone else to a login page.

It is **still backfilling** (~26% at the time of writing), so it cannot price
those tokens yet. That is shown as a distinct `SYNCING` state with the real
indexed block, chain head and percentage read live from the indexer's public
status endpoint — never as `$0`, and never as an empty market. See
[DEMO_EVIDENCE.md](DEMO_EVIDENCE.md) §4 and §9.

Robinhood Chain has **no published subgraph at all** (The Graph's networks
registry lists `"subgraphs": []` for it), which is why it comes through
Substreams. Both Substreams adapters **compose prebuilt StreamingFast
foundational modules** (`ethereum_common v0.3.3`, `solana_common v0.4.0`) driven
by query-string parameters — there is no Rust in this repository. Both packages
are vendored in [`vendor/`](vendor/) so the pipeline does not depend on registry
availability at runtime.

---

## The payment flow (Hedera)

The price service is **x402-gated**. An agent that wants the data pays for it.

```
1. Agent requests  GET /price/NVDA          →  HTTP 402 Payment Required
                                               + PAYMENT-REQUIRED challenge
2. Agent verifies the challenge's feePayer against Blocky402's published
   signers  — BEFORE spending anything
3. Agent pays 0.01 HBAR (1,000,000 tinybar, asset 0.0.0)
4. Blocky402 facilitator verifies + settles on Hedera testnet
5. Service returns the real normalized deviation data
   + PAYMENT-RESPONSE header carrying the Hedera transaction id
```

| | |
|---|---|
| Network | Hedera testnet |
| Facilitator | `https://api.testnet.blocky402.com` |
| Asset | HBAR (`0.0.0`) |
| Price | 1,000,000 tinybar = 0.01 HBAR per request |
| Settlement | native HAPI `TransferTransaction` |

**Payments are verified on-chain, not merely read from a response header.**
Example, from [DEMO_EVIDENCE.md](DEMO_EVIDENCE.md) §5 — the real product
endpoint, independently confirmed against the Hedera mirror node:

- Transaction `0.0.7162784@1788989097.995954071`
  — [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784-1788989097-995954071)

```
result : SUCCESS
0.0.10435533   -1000000 tinybar   payer (agent)
0.0.10439151   +1000000 tinybar   payee (service)
0.0.7162784     -259648 tinybar   feePayer (Blocky402 pays the network fee)
```

The transaction id is under Blocky402's account because on Hedera the
facilitator co-signs as **fee payer** and submits the transfer. The
facilitator-as-fee-payer model is visible directly in the ledger.

Three design points worth stating:

- **The facilitator is enforced, loudly.** Pointing this at a generic x402
  facilitator would still settle, still show real transactions on HashScan, and
  still silently miss the track requirement. `core/blocky402.mjs` fails the
  build rather than let that ship, and cross-checks the advertised `feePayer`
  against Blocky402's published signers *before* any HBAR moves.
- **A failed request costs nothing.** Settlement happens after the handler
  returns, and the middleware cancels it on a 4xx/5xx — so an upstream failure
  is not billed.
- **The wallet stays server-side.** The operator key is read from the local env
  file by the service. It is never a tool parameter, never in a response, and
  never reaches a model.

A **free** path exists for development: `GET /preview/:ticker` returns the same
shape with prices redacted to `null` and a `preview-redacted` caveat — redacted,
not fabricated.

---

## MCP server — Claude Desktop as the paying agent

[`mcp/`](mcp/) exposes TrueTick to AI environments over MCP. Claude Desktop can
call `get_deviation("NVDA")`, which triggers a **real** x402 payment on Hedera
and returns the data plus the transaction id for verification.

| tool | pays | |
|---|---|---|
| `get_deviation` | **yes** | cross-venue data + Hedera tx id |
| `preview_deviation` | no | same shape, prices redacted |
| `warm_up` | no | primes the data path |
| `list_tickers` | no | what can be asked for |
| `get_data_sources` | no | Graph provenance + live sync progress |
| `truetick_status` | no | services, wallet, payment terms |

The model's entire authority is to name a ticker. This process decides to spend,
which asset, and how much — with a hard per-payment ceiling. The key is never
exposed to the model, and a redaction guard scrubs key-shaped text from anything
that could reach a transcript.

Setup, the exact Claude Desktop config, and the demo sequence:
**[mcp/README.md](mcp/README.md)**.

---

## How to run it

### Requirements

- **Node >= 20.6** (uses `process.loadEnvFile`)
- A free **Graph API key** — https://thegraph.com/studio
- A **Graph Market** JWT for Substreams — `brew install streamingfast/tap/substreams`
  then `substreams auth` (this is a *different* credential from the Graph API key)
- For payments: a funded **Hedera testnet ECDSA account**

### Configuration

Create a local env file at the repo root (it is gitignored — never commit it).
Names only; supply your own values:

| variable | needed for |
|---|---|
| `GRAPH_API_KEY` | Ethereum + Base subgraphs |
| `SUBSTREAMS_API_TOKEN` | Robinhood + Solana Substreams |
| `OPERATOR_PRIVATE_KEY` | paying agent (x402 client / MCP server) |
| `HEDERA_ACCOUNT_ID` | optional — skips a rate-limited mirror lookup |
| `PAY_TO_ACCOUNT_ID` | optional — where payments land |
| `PRICE_TINYBAR` | optional — price per request (default 1,000,000) |
| `FINNHUB_API_KEY` | optional — reference-price fallback |

Reference prices come from Yahoo by default and need no key.

### Run

```bash
npm install

# free service + UI              -> http://localhost:8402
node service.mjs

# x402-gated paid service        -> http://localhost:4402
node paid-service.mjs

# or both, with a readiness check and a pre-warm
./mcp/start-services.sh
```

Open **http://localhost:8402/** for the UI.

### Endpoints

| | |
|---|---|
| `GET /price/:ticker` (8402) | free — full `TickerComparison` |
| `GET /sources` (8402) | machine-readable pipeline composition + live sync progress |
| `GET /tickers` (8402) | what can be asked for |
| `GET /price/:ticker` (4402) | **x402-gated** — requires payment |
| `GET /preview/:ticker` (4402) | free — same shape, prices redacted |

### Try the paid flow

```bash
node paid-service.mjs        # terminal 1
node paid-client.mjs NVDA    # terminal 2 — pays, prints the HashScan tx id
```

### Verify the token registry against the chains

```bash
node core/registry-verify.mjs   # all 36 entries, three chain families
```

### Building the Base subgraph

**Gotcha:** this checkout requires the config-generation step *before*
`graph build`, or the build fails on missing generated files:

```bash
cd subgraph
npm install
npm run build -- --network base --subgraph-type v3
```

That step writes `subgraph/src/common/chain.ts` and `subgraph/v3-subgraph.yaml`,
which are gitignored because they are generated per-network.

### First run is slow

The Substreams venues spawn a CLI, authenticate, and stream a block window —
**105–120 seconds** on a cold start. Results are cached for 120s, after which a
repeat request returns in under 5 seconds. Warm the path before demoing:

```bash
curl -s localhost:4402/preview/NVDA > /dev/null
```

---

## What's real, and what isn't

Everything here is live on-chain data. **Nothing is mocked, stubbed, or
replayed.** The honest limitations:

- **Base is still indexing.** Our published subgraph has not reached the
  tokenized-stock pools yet, so those tokens price as `null` with a
  `subgraph-syncing` caveat and live progress. They are registered now because
  the architecture is ready: when the backfill completes, no code changes — the
  nulls become numbers.
- **Substreams cannot observe TVL.** It reads *events*; pool reserves are
  contract *state*. Those venues read reserves separately and label it
  `tvl-via-state-read`, or report `tvl-unavailable` — never a guessed number.
- **Substreams volume is a short window, not 24h.** The figure is real but
  measured over minutes, so it is reported with its actual window
  (`volumeWindowHours`) and flagged `volume-window-short` rather than presented
  as a day's volume.
- **Off-hours deviations are not arbitrage.** Tokenized stocks trade 24/7; the
  underlying does not. Outside US market hours the deviation is still computed
  and shown, flagged `market-closed`, because it reflects news since the close
  rather than a tradeable gap.
- **Backing and redemption claims are editorial.** Issuer metadata carries its
  own source URL and check date, and explicitly does *not* assert on-chain
  transfer restrictions we have not verified.
- **Everything runs locally.** There is no hosted deployment; judges run it from
  this repo.

Full working notes, verified transactions, and the bugs found along the way:
**[DEMO_EVIDENCE.md](DEMO_EVIDENCE.md)**.

---

## Tracks

- **The Graph** — AI Use Case (an MCP server making Graph-backed data usable
  from AI environments) and Composable / Standardized Graph Products (two Graph
  products across four chains behind one schema and one query pattern, plus a
  subgraph we published ourselves).
- **Hedera** — AI & Agentic Payments (x402 micropayments settled through the
  Blocky402 facilitator, initiated by an AI agent).

## License

UNLICENSED — hackathon submission.
