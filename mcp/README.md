# TrueTick MCP server

Makes TrueTick's Graph-backed tokenized-stock data usable from Claude Desktop —
including a real, agent-initiated x402 payment on Hedera.

The model names a ticker. This process decides to spend, what asset, and how
much. **The wallet key never reaches the model**: it is read from the project
env file by `mcp/pay.mjs`, and appears in no tool parameter, schema, result, or
error message.

---

## 1. Start the two services first

The MCP server is a thin shell — it needs the services running.

```bash
cd /Users/argon/Projects/TrueTick

node paid-service.mjs     # port 4402 — the x402-gated surface (paid /price, free /preview)
node service.mjs          # port 8402 — free surface + UI (/sources)
```

Or both at once, with a readiness check:

```bash
./mcp/start-services.sh
```

`truetick_status` tells you whether they are up, and every tool failure names the
command to fix it.

---

## 2. Claude Desktop config

**File location on macOS:**

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Your file already exists and currently has `coworkUserFilesPath` and
`preferences`. **Add the `mcpServers` key alongside them — do not replace the
file.** The result should look like this:

```json
{
  "coworkUserFilesPath": "…leave whatever is already there…",
  "preferences": { "…leave whatever is already there…": true },

  "mcpServers": {
    "truetick": {
      "command": "/Users/argon/.nvm/versions/node/v24.11.1/bin/node",
      "args": ["/Users/argon/Projects/TrueTick/mcp/truetick-mcp.mjs"],
      "env": {
        "TRUETICK_PAID_URL": "http://localhost:4402",
        "TRUETICK_FREE_URL": "http://localhost:8402",
        "HEDERA_ACCOUNT_ID": "0.0.10435533"
      }
    }
  }
}
```

### Why the absolute path to `node`

Your `node` comes from **nvm**. Claude Desktop is launched from Finder, which
does not source your shell profile, so a bare `"command": "node"` fails with
`ENOENT` and the server silently never appears. Use the full path above. If you
switch Node versions, update it.

### No secret in this config

`OPERATOR_PRIVATE_KEY` is deliberately **absent**. The server loads the project
env file by absolute path at startup, so the key stays in the one gitignored
place it already lives. Nothing secret belongs in
`claude_desktop_config.json` — it is a plain unencrypted file.

`HEDERA_ACCOUNT_ID` is a *public* account id. It is here only to skip a mirror
node lookup that rate-limits aggressively; omit it and the server resolves it
itself.

### Applying it

Quit Claude Desktop **completely** (Cmd-Q — closing the window is not enough)
and reopen. The tools appear under the tools menu in a new chat.

---

## 3. Tools

| tool | pays? | what it does |
|---|---|---|
| `get_deviation(ticker)` | **YES — real HBAR** | Cross-venue deviation data + the Hedera tx id |
| `preview_deviation(ticker)` | no | Same shape, prices redacted to `null` (never faked) |
| `warm_up(ticker)` | no | Primes the data path so the paid call is fast |
| `list_tickers()` | no | What can be asked for |
| `get_data_sources()` | no | Which Graph product serves which chain, live sync progress |
| `truetick_status()` | no | Services up? wallet configured? payment terms? |

Each description states that the data comes from The Graph — Subgraphs (Uniswap
v4 on Ethereum, plus our self-published Aerodrome subgraph on Base) and
Substreams (Uniswap V3 on Robinhood Chain, Raydium CLMM on Solana).

---

## 4. Test it without Claude Desktop

`mcp/selftest.mjs` is a real MCP client over a real stdio transport, spawning the
real server. If it passes, Claude Desktop will behave the same.

```bash
node mcp/selftest.mjs              # free tools only — spends nothing
node mcp/selftest.mjs --pay        # also calls get_deviation — SPENDS REAL HBAR
node mcp/selftest.mjs --pay TSLA
```

---

## 5. Demo sequence

Warm first, then pay. Ask Claude:

1. *"Check TrueTick's status."* → `truetick_status`
2. *"Warm up NVDA."* → `warm_up` (~75s cold, ~1s after)
3. *"Where does TrueTick's data come from?"* → `get_data_sources`
4. *"Buy me the NVDA deviation data."* → `get_deviation` → real payment + tx id
5. Paste the HashScan link to verify on camera.

---

## 6. Timing, and why it is built this way

A cold Substreams venue takes up to ~75 seconds on first use. **Claude Desktop
cancels a tool call after 60 seconds** and that is not configurable from the
server side, so a server that simply waits produces
`MCP error -32001: Request timed out` with no explanation.

Three things prevent that:

- **Budgets under the client's limit.** Tools answer within ~45s and report what
  is happening rather than being cancelled.
- **Warm before paying.** `get_deviation` primes the path with a *free* request
  first. If it is still cold it returns "no payment was made, retry in ~30s"
  instead of committing money to a call that may be cancelled mid-flight — the
  one failure mode where you could be charged with nothing to show.
- **Single-flight.** Concurrent requests for the same ticker share one fetch.
  Without this the startup auto-warm, a `warm_up`, and a `preview` each opened
  their own Substreams stream, hit the 2-concurrent-session cap, queued behind
  each other, and all three looked like a cold start.

The server also auto-warms `NVDA` in the background when it starts, so opening
Claude Desktop a minute before recording means the first call is already hot.

---

## 7. If something goes wrong mid-demo

| symptom | cause | fix |
|---|---|---|
| Tools missing in Claude Desktop | `node` not found via bare command | Use the absolute nvm path above; Cmd-Q and reopen |
| "Cannot reach http://localhost:4402" | services not running | `./mcp/start-services.sh` |
| "data path is still cold … NO PAYMENT WAS MADE" | first call after restart | Wait ~30s, call again — nothing was charged |
| "wallet NOT configured" | env file not found / key unset | Free tools still work; check the project env file |
| mirror node rate limit | public node throttling | `HEDERA_ACCOUNT_ID` is already in the config to avoid this |

Any tool failure caused by an upstream error means the x402 middleware cancelled
settlement — **no HBAR was spent**. The tool says so explicitly when it knows.
