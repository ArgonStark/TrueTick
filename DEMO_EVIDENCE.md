# Demo Evidence — Real On-Chain Transactions and Live Data

Nothing below is a mock, fixture, or replay. Sections 1–2 are **real, on-chain
Hedera testnet transactions**, independently verifiable on HashScan by following
the links. Section 3 is a **live query against The Graph's decentralized
network**, reproducible with an API key — no trust in this repo required.

Together they cover both halves of TrueTick:

- **Payments** — a wallet that signs, and an x402-gated service whose payments
  settle through the **Blocky402** facilitator (sections 1–2).
- **Data** — live tokenized-stock price and liquidity from **The Graph** as a
  load-bearing source, not static or local data (section 3), including a
  subgraph we forked, fixed and published ourselves to cover pools no existing
  subgraph indexed (section 4).
- **The two joined** — the real product endpoint behind x402, where a paying
  agent buys genuine normalized deviation data and the payment settles on
  Hedera through Blocky402 (section 5).
- **A second chain, still on The Graph** — Robinhood Chain has no published
  subgraph, so its prices come through **Substreams** (section 6), making the
  deviation table genuinely multi-chain.

Kept up to date as further evidence is gathered.

---

## 1. Wallet signing — plain ethers.js on Hedera testnet

Proves a plain `ethers.Wallet` (private key only, no Hedera SDK) can sign and
broadcast through Hedera's EVM JSON-RPC relay.

| | |
|---|---|
| Script | [`send-hbar.mjs`](send-hbar.mjs) |
| Transaction | `0x98931ba6e2b849aa46de54a38e4f20ee1baffd0991cc3835204fe0c5679a2a98` |
| HashScan | https://hashscan.io/testnet/tx/0x98931ba6e2b849aa46de54a38e4f20ee1baffd0991cc3835204fe0c5679a2a98 |
| Result | SUCCESS (status `0x1`), block 40302645 |
| From | `0xC5952D905991Ebef262C2A929F7D94DFDb96E61d` (`0.0.10435533`) |
| To | `0x4Da0b8AE3c7a594aCF9B12f866dCd0cBb389243c` (`0.0.10439151`) |
| Amount | 0.01 HBAR |
| Gas | 607,858 used of 1,315,038 limit |
| Fee | 0.65648664 HBAR |
| Relay | `https://testnet.hashio.io/api`, chainId 296 |

**Why the gas is unusually high.** The recipient account did not exist before
this transaction. Sending to a new EVM address triggers Hedera *lazy account
creation*, which is charged as gas on the sender's transfer: ~660k gas versus
~22.8k to an account that already exists. The mirror node confirms account
`0.0.10439151` was created with `key: null` (a hollow account) at a consensus
timestamp one nanosecond after this transaction — i.e. **this transaction
created it**. A hardcoded Ethereum-style 21000 gas limit fails here.

---

## 2. x402 payments settled via Blocky402 — Hedera testnet

Proves an x402-gated HTTP service on Hedera testnet, with payment verified and
settled by the **Blocky402** facilitator (a hard requirement of the Hedera
"AI & Agentic Payments" track — a generic x402 facilitator does not qualify).

| | |
|---|---|
| Server | [`x402-server.mjs`](x402-server.mjs) — `GET /price`, 402-gated |
| Client | [`x402-client.mjs`](x402-client.mjs) — pays, then re-requests |
| Facilitator | `https://api.testnet.blocky402.com` (no API key) |
| Network | `hedera:testnet`, scheme `exact` |
| Settlement asset | HBAR (asset id `0.0.0`) |
| Price per request | 1,000,000 tinybar = 0.01 HBAR |
| Payer | `0.0.10435533` |
| Payee | `0.0.10439151` |
| Facilitator fee payer | `0.0.7162784` |

### Payment 1

- Transaction: `0.0.7162784@1788969723.270703924`
- HashScan: https://hashscan.io/testnet/transaction/0.0.7162784-1788969723-270703924

### Payment 2

- Transaction: `0.0.7162784@1788970400.441076045`
- HashScan: https://hashscan.io/testnet/transaction/0.0.7162784-1788970400-441076045

Both verified SUCCESS on HashScan.

**Why the transaction ID is under `0.0.7162784` and not the payer.** On Hedera,
x402 settles as a native HAPI `TransferTransaction`, not an EVM transaction. The
client builds and *partially* signs the transfer, then the facilitator co-signs
as **fee payer** and submits it. The transaction ID therefore carries Blocky402's
account, while the settlement response reports `payer: 0.0.10435533` — the funds
come from our wallet. This is the expected shape, and it is itself evidence that
Blocky402 performed the settlement.

### Observed flow

```
[1] GET /price  (no payment)      -> HTTP 402 Payment Required
    PAYMENT-REQUIRED challenge:
      scheme   : exact
      network  : hedera:testnet
      asset    : 0.0.0        amount: 1000000 tinybar (0.01 HBAR)
      payTo    : 0.0.10439151
      feePayer : 0.0.7162784
[2] pay + retry                   -> HTTP 200 OK
[3] body                          -> {"ticker":"AAPL","price":42}
[4] settlement (Blocky402)        -> success: true
                                     payer: 0.0.10435533
                                     transaction: 0.0.7162784@...
```

### Facilitator capability, as advertised live

`GET https://api.testnet.blocky402.com/supported` returns:

```json
{"x402Version":2,"scheme":"exact","network":"hedera:testnet",
 "extra":{"feePayer":"0.0.7162784"}}
```

### Guards against silently failing the track requirement

The track mandates Blocky402 specifically. The failure mode is silent: the
official Hedera x402 PoC points **testnet** at `x402.org/facilitator` and uses
Blocky402 only on mainnet, so a build "aligned" with that reference would pass
every test while failing the requirement. Two guards prevent this:

1. `assertBlocky402()` in both server and client rejects any facilitator whose
   **hostname** is not `*.blocky402.com`. Hostname, not substring — a URL such
   as `https://evil.test/?x=blocky402.com` contains the string but is not
   Blocky402. Both rejection cases are tested.
2. The client cross-checks the `feePayer` advertised in the server's 402
   challenge against the signers Blocky402 publishes at `/supported`, and
   **aborts before spending**. This catches a mis-configured server that the
   client does not control.

---

## 3. Graph live-data proof — tokenized-stock price and liquidity

Proves live tokenized-stock market data flows from **The Graph's decentralized
network**, satisfying the requirement that The Graph be a load-bearing, live
data source rather than mocked, local, or static data.

| | |
|---|---|
| Script | [`graph-price.mjs`](graph-price.mjs) |
| Subgraph | Uniswap v4 Ethereum — `DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G` |
| Explorer | https://thegraph.com/explorer/subgraphs/DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G |
| Token | NVDAon — NVIDIA (Ondo Tokenized), `0x2D1F7226Bd1F780AF6B9A49DCC0aE00E8Df4bDEE` |
| Chain | Ethereum mainnet |
| Endpoint | `https://gateway.thegraph.com/api/subgraphs/id/<SUBGRAPH_ID>` (Bearer auth) |

### Verified snapshot

| | |
|---|---|
| Indexed block | **25941078** |
| Lag behind chain head | **~18s** |
| Price (derived from `derivedETH` × `ethPriceUSD`) | **$224.72** |
| Price (derived from pool `token0Price`/`token1Price`) | **$224.69** |
| Cross-check | Agrees with DexScreener for the same token |

**Why the block lag is the liveness proof.** An 18-second lag behind chain head
cannot be produced by a fixture or a cached response. It is only achievable by
querying an actively-indexing subgraph, and it changes on every run. The two
independently derived prices agreeing to within $0.03 — one via ETH
denomination, the other via the pool's own token ratio — confirms the figure is
a real market price and not an artifact of one code path.

**Phantom-liquidity filter worked.** The script correctly flagged zero-volume
pools (NVDAon/AP and others) so they are excluded as a price source — pools can
hold large TVL while never trading, and their prices are meaningless.

### Derived, not read directly

The v4 schema exposes no USD price on `Token`, and no 24h volume on `Pool`:

- **Price** = `token.derivedETH` × `bundle.ethPriceUSD`.
- **Pool price** = `token1Price` when our token is `token0`, else `token0Price`
  (schema: `token0Price` is "token0 per token1"). Reversing this silently
  inverts the price.
- **24h volume** = nested `poolDayData` rows. `Pool.volumeUSD` is cumulative
  since inception, not 24h, and is unusable for detecting untraded pools.
- TVL is `Pool.totalValueLockedUSD` but `PoolDayData.tvlUSD` — the entities
  genuinely differ.

Run `node graph-price.mjs --introspect` to dump the live schema and confirm any
of the above against the subgraph itself.

---

## 4. Published subgraph — indexing data no existing subgraph covered

Base has the deepest tokenized-stock liquidity of any chain we surveyed
(NVDAc/USDC alone trades ~$9.4M/day), but **no published subgraph indexed those
pools**. Rather than fall back to a non-Graph data source, we forked, fixed, and
published one — making The Graph load-bearing as a *publisher*, not only a
consumer.

| | |
|---|---|
| Studio slug | `truetick-aerodrome-base` |
| Source | [`subgraph/`](subgraph/) |
| Upstream | `Uniswap/v3-subgraph` @ `b4a0e8d34b8238482cadd3929ae88d3426a7067b` |
| Target | Aerodrome Slipstream **CLFactory** `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef` |
| startBlock | `44394724` (2026-04-07T16:19:55Z) |
| Network | Base |

### Why a fork was necessary

Aerodrome runs more than one CL factory. The only healthy published Aerodrome
subgraph (`GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM`) indexes factory
`0x5e7BB104…` — 3,619 pools, $321M TVL, genuinely live at ~4s lag — but the
tokenized-stock pools live on `0xf8f2eB49…`, which it does not index. Queried
against it, all four Coinbase tokens return `poolCount: 0, TVL: $0, volume: $0`,
and the real NVDAc/USDC pool `0x853F5f1B…` resolves to `null`.

### Verification of the target factory

- Blockscout reports the contract name **`CLFactory`** with verified source
- Its `voter()` returns `0x16613524…`, Aerodrome's ve(3,3) Voter
- The live NVDAc/USDC pool returns this address from `factory()`
- startBlock confirmed twice: Blockscout `creation_transaction_hash`
  `0xef9b902f…`, and an independent RPC `getTransactionReceipt` on that tx
  returning `blockNumber 44394724` with `contractAddress` equal to the factory

### Two silent-$0 bugs found and fixed

Both would have produced a subgraph that indexed cleanly, reported healthy
status, and returned `$0` for every value — the worst kind of failure, because
nothing looks broken.

1. **Wrong USDC address.** Upstream `config/base/chain.ts` whitelisted USDC as
   `0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e`. `eth_getCode` proves there is
   **no contract at that address on Base** — it is Avalanche's USDC. Every
   tokenized stock pairs against real Base USDC
   (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, verified `symbol()` = USDC,
   6 decimals), so none of their pools would have been whitelisted and their
   tracked TVL and volume would have reported `$0`.
2. **Unreachable reference pool.** `getEthPriceInUSD()` calls
   `Pool.load(STABLE_TOKEN_POOL)` against *this subgraph's own store*. Upstream
   pointed it at a Uniswap v3 pool, which an Aerodrome-only subgraph never
   indexes, so it returned `ZERO_BD` → `ethPriceUSD = 0` → **every USD field in
   the entire subgraph $0**. Repointed at Aerodrome CL WETH/USDC
   `0x3fe04a59…` ($8.3M TVL, $54.9M 24h volume), the deepest WETH/USDC pool on
   the target factory.

### Slipstream adaptation

Slipstream's factory event drops the fee parameter:

```
Uniswap v3 : PoolCreated(address,address,uint24,int24,address)
Slipstream : PoolCreated(address,address,int24,address)
```

So `feeTier` is read from the pool contract via `try_fee()` rather than the
event. tickSpacing is **not** a fee — the live NVDAc/USDC pool has
`tickSpacing 10` but `fee() 500`, and `swap.ts` divides `feeTier` by 1e6 to
compute `feesUSD`, so substituting tickSpacing would understate fees 50x.

All five pool-level events (`Initialize`, `Swap`, `Mint`, `Burn`, `Collect`) are
byte-identical between `CLPool` and Uniswap v3, so the Pool template needed no
changes.

Known limitation: Slipstream has a dynamic swap-fee module, so a `feeTier`
captured at pool creation can drift if a pool's fee later changes. This affects
`feesUSD` only; price, TVL and volume are unaffected.

---

---

## 5. The real service behind x402 — paying for genuine deviation data

Sections 2 and 5 are **different claims**. Section 2 proved the payment rail
using a throwaway endpoint that returned `{"ticker":"AAPL","price":42}` — a
dummy payload, deliberately, so the payment loop was the only thing under test.
This section proves the **product**: the same Blocky402 settlement path gating
the real `/price/:ticker` endpoint, where what the agent receives is live
normalized `TokenizedStockPoint` data derived from The Graph and a real
reference price.

| | |
|---|---|
| Server | [`paid-service.mjs`](paid-service.mjs) — `GET /price/:ticker`, 402-gated |
| Client | [`paid-client.mjs`](paid-client.mjs) — pays, then renders the data |
| Facilitator | `https://api.testnet.blocky402.com` (Blocky402, enforced) |
| Network | `hedera:testnet`, scheme `exact` |
| Settlement asset | HBAR (asset id `0.0.0`) |
| Price per request | 1,000,000 tinybar = 0.01 HBAR |
| Payer | `0.0.10435533` |
| Payee | `0.0.10439151` |
| Facilitator fee payer | `0.0.7162784` |
| Data source | Uniswap v4 Ethereum via The Graph — `DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G` |

### Real-service payment

- Transaction: `0.0.7162784@1788989097.995954071`
- HashScan: https://hashscan.io/testnet/transaction/0.0.7162784-1788989097-995954071

Independently verified against the mirror node (not merely read from the
`PAYMENT-RESPONSE` header):

```
result         : SUCCESS
consensus_ts   : 1788989106.561453106
charged_fee    : 259648 tinybar

0.0.10435533       -1000000 tinybar   payer (agent)
0.0.10439151        1000000 tinybar   payee (service)
0.0.7162784          -259648 tinybar   feePayer (Blocky402)
```

The agent was debited exactly the advertised price, the service was credited
exactly that amount, and **Blocky402 paid the network fee** — the facilitator-
as-fee-payer model, visible in the ledger.

### What the payment actually bought

Live output from the run, at indexed block `25942484` (18s behind chain head):

```
reference : $223.67  via yahoo-chart
            asOf 2026-09-09T20:00:00.000Z  (5105s old)
            session post, marketOpen=false

NVDAon  (Ondo Global Markets)
  on-chain price : $223.08
  deviation      : -0.264%   ($-0.59)
  pool TVL       : $239,778.14   24h vol $102,956.01
  priceReliable  : true   deviationReliable: false
  caveats        : market-closed

NVDAx  (Backed Finance (xStocks))
  on-chain price : $1,136.93
  deviation      : +408.307%   ($913.26)
  pool TVL       : $27,186.46   24h vol $9.89
  priceReliable  : false   deviationReliable: false
  caveats        : thin-volume, price-divergence, market-closed
```

Both issuers are read at the **same indexed block**, so the cross-issuer
comparison is not assembled from two different moments.

The `NVDAx` row is not an error — it is the point of the quality layer. Backed's
NVIDIA xStock is a genuine token whose Ethereum pools trade about $10 a day, so
its on-chain price has drifted to $1,136 against a real NVDA price of $223. A
naive aggregator would publish that as a 408% arbitrage. TrueTick publishes the
number *and* marks it `priceReliable: false` with `thin-volume` and
`price-divergence`.

### A failed request costs nothing

x402 settlement runs *after* the handler, and the middleware cancels it when the
handler responds 4xx/5xx. So the caller is charged for data delivered, not for
the attempt. Verified against real balances:

```
agent balance BEFORE : 99930351336 tinybar
node paid-client.mjs ZZZZ      -> 402 -> paid -> handler 404 -> settlement cancelled
agent balance AFTER  : 99930351336 tinybar
difference           : 0 tinybar
```

### Free surface for development

Paying 0.01 HBAR per iteration while building is wasteful, so the real shape
stays reachable unpaid at `GET /preview/:ticker`. It **redacts** rather than
fabricates — every price becomes `null` and a `preview-redacted` caveat is
added, so a preview can never be mistaken for paid data or quietly built on:

```
NVDAon   priceUsd=None dev=None tvl=$239,778 vol24h=$102,956
         caveats=['market-closed', 'preview-redacted']
```

`GET /tickers` and `GET /health` are also free; `/health` publishes the payment
terms (asset, price, payee, facilitator) so an agent can decide before spending.

### Track requirement preserved

The `assertBlocky402` hostname guard runs at startup on the server and before
spending on the client, and [`paid-client.mjs`](paid-client.mjs) additionally
cross-checks the `feePayer` advertised in the 402 challenge against the signers
Blocky402 publishes at `/supported` — aborting *before* any HBAR moves if the
server is settling elsewhere. Observed live in this run:

```
feePayer : 0.0.7162784
OK feePayer 0.0.7162784 confirmed as Blocky402
```

The shared implementation is [`core/blocky402.mjs`](core/blocky402.mjs). The
original standalone artefacts from section 2 keep their own inline copy and were
left untouched, so the proven evidence above still reproduces exactly.

---

## 6. Robinhood Chain via Substreams — a second chain, still on The Graph

Robinhood Chain (chainId 4663) carries deep tokenized-stock liquidity, but **has
no published subgraph**. The Graph's own networks registry lists
`"subgraphs": []` for `eip155:4663` — Firehose and Substreams only. So forking a
subgraph, as in section 4, is not merely slow here: it is unavailable.
Substreams is the only route to this chain's data through The Graph.

| | |
|---|---|
| Adapter | [`core/adapters/robinhood-substreams.mjs`](core/adapters/robinhood-substreams.mjs) |
| Package | `ethereum_common` v0.3.3 — StreamingFast foundational module, **prebuilt** |
| Module | `filtered_events` |
| Endpoints | `mainnet.robinhood.streamingfast.io:443`, `robinhood.substreams.pinax.network:443` (both verified working) |
| Auth | Graph Market JWT (`SUBSTREAMS_API_TOKEN`) — **not** the Subgraph Studio key |
| Chain | Robinhood Chain mainnet, chainId 4663, ~0.101s blocks |

### No Rust, and no sync wait

`filtered_events` takes a **query-string parameter**, so the filtering we need is
configuration rather than a compiled WASM module:

```
evt_sig:0xc42079f9…  &&  (evt_addr:0xd4eb… || evt_addr:0xb944… || …)
```

That is the Uniswap V3 `Swap` topic AND'd against our pool addresses. No Rust
toolchain, no compile step, nothing of ours published to the registry.

It is also a **map module with no stores**, so there is no historical state to
rebuild. It streams a recent block range and returns. That is the substantive
difference from the Base subgraph in section 4, which needed ~10 days of
backfill: nothing here is backfilled at all.

### Live output

```
NVDA  robinhood  $219.46   TVL $8,197,369   vol $571,620 / 0.56h   robinhood-substreams
   USDG/NVDA  fee 500     TVL $8,179,951   vol $571,620      <- the real market
   USDG/NVDA  fee 3000    TVL     $17,335   vol $0
   USDG/NVDA  fee 100     TVL         $83   vol $0
   USDG/NVDA  fee 10000   TVL          $0   vol $0
```

Alongside the two Ethereum issuers this makes NVDA a **three-issuer, two-chain**
row, with each row labelled by the source that produced it (`Substreams` vs
`The Graph`) in both the API and the UI.

### What Substreams gives us, and what it does not

**Price and volume are event-sourced.** A Uniswap V3 `Swap` event carries
`sqrtPriceX96`, so the latest swap *is* the current price. Volume is the summed
USDG side of the swaps in the streamed window.

**TVL is not in the event stream.** Pool reserves are contract *storage*, not
events. Reconstructing them from the log would mean replaying every transfer
since pool creation (~50M blocks), which is the backfill this adapter exists to
avoid. So TVL comes from one batched `balanceOf` read via Multicall3, and that
split is **labelled rather than blurred** — the row carries a
`tvl-via-state-read` caveat and the UI shows it as a badge. Set
`SUBSTREAMS_TVL=off` to drop TVL back to null and keep the row purely
event-sourced.

**Volume is labelled with its real window.** The stream processes ~190
blocks/sec, so a true 24h window (855,785 blocks) would take ~70 minutes. The
default streams ~34 minutes of chain and the UI says `34m volume`, with
`volume24hUsd` left null. Calling a 34-minute figure "24h volume" would
overstate it by roughly 40x.

### Vendored package — registry independence

The package is committed at `vendor/ethereum-common-v0.3.3.spkg` and read from
disk. Fetching it from the registry failed mid-session with `access denied to
package on the Substreams registry`, and `spkg.io` returns HTTP 403 to direct
download with or without a token — which took the whole venue off the table. A
third-party registry being reachable is not something a live demo should depend
on.

The vendored file is **byte-identical to the official StreamingFast GitHub
release**:

```
sha256  67cfcb8f52a65611d80d2fd6ee951ecb77d848ddcbda0eb5aac839e880b1e020
        vendor/ethereum-common-v0.3.3.spkg   (446,503 bytes)
        == github.com/streamingfast/substreams-foundational-modules
           releases/download/ethereum-common-v0.3.3/ethereum-common-v0.3.3.spkg
```

Refresh it with the `curl` command documented at the top of the adapter.

### Operational notes found the hard way

- **Concurrent session limit.** The Graph Market tier allows 2 simultaneous
  Substreams sessions. Every page load opened another, and past two the server
  answers `ResourceExhausted: Concurrent stream limit exceeded` and the venue
  silently vanished. Runs are now serialised behind a mutex, results cached, and
  child processes killed rather than left holding a session.
- **`--limit-processed-blocks`** defaults to 10,000; our window is larger, so the
  adapter raises the ceiling to match the window exactly rather than removing it.
- **Payloads are base64**, not hex — addresses, topics and data all decode from
  base64 in the JSONL output.
- **A failed source is now visible.** The UI previously dropped a failed venue
  and rendered a clean-looking table; `sourceErrors` is now shown as a
  "SOURCE UNAVAILABLE" banner. Absent-because-unread must never look like
  absent-because-empty.

## Reproducing

```bash
node send-hbar.mjs        # 1. wallet signing test

node x402-server.mjs      # 2. terminal 1
node x402-client.mjs      #    terminal 2

node graph-price.mjs      # 3. live Graph data

node core/registry-verify.mjs   # re-verify the token registry (contract + subgraph)

node paid-service.mjs           # 5. terminal 1 -- real data behind x402
node paid-client.mjs NVDA       #    terminal 2 -- pays, prints the deviation data

node service.mjs                #    open/free variant, no payment (port 8402)

# 6. Robinhood Chain via Substreams (needs SUBSTREAMS_API_TOKEN)
brew install streamingfast/tap/substreams
substreams auth                 #    Graph Market key -> JWT
node service.mjs                #    Robinhood rows now stream via Substreams
ROBINHOOD_ADAPTER=rpc node service.mjs   # fallback: direct RPC instead
```

Sections 1–2 require a funded Hedera testnet ECDSA account; section 3 requires a
free Graph API key from https://thegraph.com/studio. Section 5 requires **both**
— it pays on Hedera and reads from The Graph in the same request. Secrets live
in a gitignored local env file and are never committed.
