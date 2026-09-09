# Demo Evidence — Real On-Chain Transactions and Live Data

Nothing below is a mock, fixture, or replay. Sections 1–2 are **real, on-chain
Hedera testnet transactions**, independently verifiable on HashScan by following
the links. Section 3 is a **live query against The Graph's decentralized
network**, reproducible with an API key — no trust in this repo required.

Together they cover both halves of TrueTick:

- **Payments** — a wallet that signs, and an x402-gated service whose payments
  settle through the **Blocky402** facilitator (sections 1–2).
- **Data** — live tokenized-stock price and liquidity from **The Graph** as a
  load-bearing source, not static or local data (section 3).

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

## Reproducing

```bash
node send-hbar.mjs        # 1. wallet signing test

node x402-server.mjs      # 2. terminal 1
node x402-client.mjs      #    terminal 2

node graph-price.mjs      # 3. live Graph data
```

Sections 1–2 require a funded Hedera testnet ECDSA account; section 3 requires a
free Graph API key from https://thegraph.com/studio. Secrets live in a
gitignored local env file and are never committed.
