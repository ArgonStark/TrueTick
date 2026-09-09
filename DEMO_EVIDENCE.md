# Demo Evidence — Real Hedera Testnet Transactions

Every transaction below is a **real, on-chain Hedera testnet transaction**, not a
mock, fixture, or replay. Each one is independently verifiable on HashScan by
following the links — no trust in this repo required.

These prove the payment loop end to end: a wallet that signs, and an x402-gated
service whose payments settle through the **Blocky402** facilitator.

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

## Reproducing

```bash
node send-hbar.mjs        # wallet signing test

node x402-server.mjs      # terminal 1
node x402-client.mjs      # terminal 2
```

Requires a funded Hedera testnet ECDSA account. Secrets live in a gitignored
local env file and are never committed.
