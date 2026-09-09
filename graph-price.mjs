#!/usr/bin/env node
/**
 * Live tokenized-stock price/liquidity from The Graph's decentralized network.
 *
 * Risk-check only: proves live Graph data flows for ONE tokenized-stock token.
 * No table, no UI, no product logic.
 *
 * Default token: NVDAon -- NVIDIA (Ondo Tokenized) on Ethereum mainnet, which
 * has genuinely active Uniswap v4 pools. See DEMO_EVIDENCE.md for why this
 * token was chosen over Backed bTokens and Dinari dShares.
 *
 * Run:  node graph-price.mjs [tokenAddress]
 *       node graph-price.mjs --introspect     (dump the live schema)
 */
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)));
} catch { /* env may already be exported */ }

/**
 * Uniswap V4 Ethereum mainnet, per Uniswap's official subgraph docs
 * (developers.uniswap.org -> Ecosystem -> Subgraphs -> Overview).
 *
 * Take this ID only from Uniswap's own docs. An earlier revision of this file
 * used an ID lifted from a search-result snippet; it resolved and authenticated
 * fine but was a DIFFERENT subgraph with a different schema, so nearly every
 * field was rejected. A wrong-but-valid subgraph id fails as a wall of schema
 * errors, which reads like a bad query rather than a bad endpoint.
 */
const V4_SUBGRAPH_ID = "DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G";

// Uniswap v3 Ethereum mainnet, same source, for tokens whose pools are v3.
const V3_SUBGRAPH_ID = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";

// --- args ------------------------------------------------------------------
// `--introspect [SUBGRAPH_ID]` dumps the live schema of any subgraph, so a new
// source (Aerodrome, a Substreams-backed subgraph, anything) can be mapped from
// ground truth instead of from memory or a search result.
const args = process.argv.slice(2);
const introspectIdx = args.indexOf("--introspect");
const INTROSPECT = introspectIdx !== -1;
const introspectId =
  INTROSPECT &&
  args[introspectIdx + 1] &&
  !args[introspectIdx + 1].startsWith("--")
    ? args[introspectIdx + 1]
    : null;

const SUBGRAPH_ID =
  introspectId || process.env.GRAPH_SUBGRAPH_ID || V4_SUBGRAPH_ID;

const GATEWAY = `https://gateway.thegraph.com/api/subgraphs/id/${SUBGRAPH_ID}`;

// NVDAon. Lowercased: subgraph entity ids are lowercase hex.
// NOTE: "NVDAon" exists at more than one contract address, both named
// "NVIDIA (Ondo Tokenized)". Always pin the exact address -- never resolve a
// tokenized stock by symbol.
const DEFAULT_TOKEN = "0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee";

// A positional arg is a token address unless it was consumed as the
// --introspect subgraph id.
const tokenArg = args.find(
  (a) => !a.startsWith("--") && a !== introspectId && /^0x/i.test(a)
);
const token = (tokenArg || process.env.TOKEN_ADDRESS || DEFAULT_TOKEN)
  .trim()
  .toLowerCase();

const apiKey = (process.env.GRAPH_API_KEY || "").trim();

function fail(...lines) {
  console.error("\n  x " + lines.join("\n    ") + "\n");
  process.exit(1);
}

if (!apiKey) {
  fail(
    "GRAPH_API_KEY is not set.",
    "Create one free at https://thegraph.com/studio -> API Keys,",
    "then add GRAPH_API_KEY=... to your .env file."
  );
}
if (!INTROSPECT && !/^0x[0-9a-f]{40}$/.test(token)) {
  fail(`Not a valid token address: ${token}`);
}

/**
 * Query the gateway.
 *
 * The gateway answers auth and schema failures with HTTP 200 and an `errors`
 * array, so `res.ok` proves nothing. The body must be inspected every time.
 */
async function query(gql, variables = {}) {
  let res;
  try {
    res = await fetch(GATEWAY, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: gql, variables }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    fail(`Gateway unreachable: ${e.message}`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`Gateway returned non-JSON (HTTP ${res.status}):`, text.slice(0, 300));
  }

  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    if (/auth error|api key/i.test(msg)) {
      fail(
        `Gateway rejected the API key: ${msg}`,
        "Check GRAPH_API_KEY, and that the key is enabled for this subgraph.",
        "Keys are managed at https://thegraph.com/studio -> API Keys."
      );
    }
    // A pile of "field not found" errors almost always means the SUBGRAPH is
    // wrong, not the query. Say so, and hand over the tool to prove it.
    if (/no field|cannot query field|unknown field|type .* has no field/i.test(msg)) {
      fail(
        `Schema mismatch against subgraph ${SUBGRAPH_ID}:`,
        msg.slice(0, 400),
        "",
        "This usually means GRAPH_SUBGRAPH_ID points at a different subgraph,",
        "not that the query is malformed. Dump the real schema with:",
        "  node graph-price.mjs --introspect"
      );
    }
    fail(`Gateway returned errors: ${msg}`);
  }
  return json.data;
}

// --- introspection mode ----------------------------------------------------
// So a schema mismatch is never diagnosed by guesswork again.
if (INTROSPECT) {
  // Unwrap NonNull/List wrappers so the printed type is the real one.
  const typeName = (t) => {
    if (!t) return "?";
    if (t.name) return t.name;
    const inner = typeName(t.ofType);
    return t.kind === "LIST" ? `[${inner}]` : inner;
  };

  const data = await query(`
    { __schema { types {
        name kind
        fields { name type { name kind ofType { name kind ofType { name kind ofType { name } } } } }
    } } }
  `);

  const types = (data.__schema.types || [])
    .filter((t) => t.kind === "OBJECT" && !t.name.startsWith("__") && t.fields)
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`\n  Live schema of ${SUBGRAPH_ID}\n`);
  console.log(`  all ${types.length} entity types:`);
  console.log(`    ${types.map((t) => t.name).join(", ")}\n`);

  // Entity names differ per protocol (Uniswap "Pool" vs Solidly-fork "Pair" or
  // "LiquidityPool"), so match on a broad pattern rather than a fixed list.
  // Override with INTROSPECT_FILTER to widen or narrow.
  const filter = new RegExp(
    process.env.INTROSPECT_FILTER ||
      "pool|pair|token|bundle|day|hour|factory|meta|price|liquid",
    "i"
  );

  let shown = 0;
  for (const t of types) {
    if (!filter.test(t.name)) continue;
    shown++;
    console.log(`  type ${t.name}`);
    for (const f of t.fields) console.log(`      ${f.name}: ${typeName(f.type)}`);
    console.log("");
  }
  console.log(`  (${shown} of ${types.length} types shown; INTROSPECT_FILTER to change)\n`);
  process.exit(0);
}

/**
 * Verified against the official Uniswap/v4-subgraph schema.graphql.
 *
 * Field notes:
 *   Token has NO direct USD price. `derivedETH` is the token's price denominated
 *   in native ETH; multiply by Bundle.ethPriceUSD to get USD. See derivation
 *   below.
 *   Pool.volumeUSD and Token.volumeUSD are CUMULATIVE since pool inception, not
 *   24h. Real 24h volume comes from the nested PoolDayData rows.
 *   PoolDayData names TVL `tvlUSD`, while Pool names it `totalValueLockedUSD`.
 *   The two entities genuinely differ; this is not a typo.
 */
const QUERY = `
  query TokenSnapshot($id: ID!) {
    _meta { block { number timestamp } hasIndexingErrors }

    bundle(id: "1") { ethPriceUSD }

    token(id: $id) {
      id symbol name decimals
      derivedETH
      volumeUSD
      totalValueLockedUSD
      poolCount
      txCount
    }

    asToken0: pools(
      where: { token0: $id }
      orderBy: totalValueLockedUSD
      orderDirection: desc
      first: 8
    ) { ...PoolFields }

    asToken1: pools(
      where: { token1: $id }
      orderBy: totalValueLockedUSD
      orderDirection: desc
      first: 8
    ) { ...PoolFields }
  }

  fragment PoolFields on Pool {
    id
    feeTier
    liquidity
    token0Price
    token1Price
    volumeUSD
    totalValueLockedUSD
    txCount
    token0 { id symbol }
    token1 { id symbol }
    poolDayData(first: 2, orderBy: date, orderDirection: desc) {
      date
      volumeUSD
      tvlUSD
    }
  }
`;

const usd = (n) =>
  "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

console.log(`\n  The Graph -- live tokenized-stock snapshot`);
console.log(`  subgraph : ${SUBGRAPH_ID} (Uniswap v4 Ethereum)`);
console.log(`  token    : ${token}`);

const data = await query(QUERY, { id: token });

// --- freshness: the proof that this is live, not cached or mocked ----------
const block = data._meta?.block;
if (block) {
  const lagSec = Math.max(0, Math.floor(Date.now() / 1000) - Number(block.timestamp));
  console.log(`\n  indexed block : ${block.number}`);
  console.log(`  block time    : ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
  console.log(`  lag           : ${lagSec}s behind chain head`);
  if (data._meta.hasIndexingErrors) {
    console.log(`  WARNING       : subgraph reports indexing errors`);
  }
}

const t = data.token;
if (!t) {
  fail(
    `Token ${token} is not indexed by this subgraph.`,
    "Its pools may be Uniswap v3 rather than v4. Retry with:",
    `  GRAPH_SUBGRAPH_ID=${V3_SUBGRAPH_ID} node graph-price.mjs ${token}`
  );
}

// --- DERIVED: token USD price ----------------------------------------------
// The v4 schema exposes no USD price on Token. `derivedETH` is the price in
// native-ETH terms; Bundle.ethPriceUSD is ETH in USD. Product of the two.
const ethUsd = Number(data.bundle?.ethPriceUSD ?? 0);
const priceUsd = Number(t.derivedETH) * ethUsd;

console.log(`\n  ${t.name} (${t.symbol})`);
console.log(`  price (derived): ${usd(priceUsd)}`);
console.log(`                   = derivedETH ${Number(t.derivedETH).toFixed(8)} x ETH ${usd(ethUsd)}`);
console.log(`  liquidity (TVL): ${usd(t.totalValueLockedUSD)}`);
console.log(`  volume (cumul) : ${usd(t.volumeUSD)}   [all-time, not 24h]`);
console.log(`  pools / txs    : ${t.poolCount} pools, ${t.txCount} txs`);

const pools = [...(data.asToken0 || []), ...(data.asToken1 || [])]
  .sort((a, b) => Number(b.totalValueLockedUSD) - Number(a.totalValueLockedUSD))
  .slice(0, 6);

/**
 * DERIVED: this token's price expressed in the pool's other token.
 *
 * Schema semantics, from the v4 schema comments:
 *   token0Price = "token0 per token1"
 *   token1Price = "token1 per token0"
 * So when our token is token0, the amount of the OTHER token per unit of ours
 * is token1Price; when ours is token1, it is token0Price. Getting this backwards
 * silently inverts the price (e.g. 0.0044 instead of 225).
 */
function priceInQuote(pool) {
  const isToken0 = pool.token0.id.toLowerCase() === token;
  return {
    price: Number(isToken0 ? pool.token1Price : pool.token0Price),
    quote: isToken0 ? pool.token1.symbol : pool.token0.symbol,
  };
}

console.log(`\n  top pools by TVL:`);
if (!pools.length) {
  console.log(`    (none -- token is indexed but has no pools in this subgraph)`);
}

let recentVolTotal = 0;
for (const p of pools) {
  const days = p.poolDayData || [];
  // Latest row is the current UTC day and therefore partial; the one before it
  // is the last complete day. Report the latest, but judge "is it traded" on
  // both, so a quiet morning does not look like a dead pool.
  const vol24 = Number(days[0]?.volumeUSD ?? 0);
  const volPrev = Number(days[1]?.volumeUSD ?? 0);
  recentVolTotal += vol24 + volPrev;

  const { price, quote } = priceInQuote(p);
  const pair = `${p.token0.symbol}/${p.token1.symbol}`;

  console.log(
    `    ${pair.padEnd(16)} fee ${String(p.feeTier).padEnd(7)}` +
      ` TVL ${usd(p.totalValueLockedUSD).padEnd(14)}` +
      ` vol24h ${usd(vol24).padEnd(14)}`
  );
  console.log(
    `      price ${price.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${quote}` +
      ` per ${t.symbol}   prev-day vol ${usd(volPrev)}   txs ${p.txCount}`
  );
  console.log(`      pool ${p.id}`);
}

// A token with TVL but no recent volume is not a usable price source -- flag it
// here rather than letting it silently become a "fair price" input later.
if (pools.length && recentVolTotal === 0) {
  const tvl = pools.reduce((s, p) => s + Number(p.totalValueLockedUSD), 0);
  console.log(`\n  WARNING: phantom liquidity.`);
  console.log(`  ${usd(tvl)} TVL across ${pools.length} pools, but zero volume over the`);
  console.log(`  last two UTC days. Prices from an untraded pool are not meaningful.`);
}

console.log("");
