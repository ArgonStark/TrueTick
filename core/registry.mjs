/**
 * Token registry -- the one file where a wrong entry is silently wrong.
 *
 * ==========================================================================
 * REVIEW THIS FILE BY HAND. Nothing else in TrueTick is as dangerous.
 * ==========================================================================
 *
 * Nothing on-chain says NVDAon represents NVDA. That mapping is human
 * judgement, and a bad entry produces a confident, plausible deviation against
 * the WRONG stock -- no error, no null, just a lie. So:
 *
 *   - KEYED BY CONTRACT ADDRESS. Never resolved by symbol. On Ethereum alone
 *     three separate tokens carry the bare symbol "NVDA" (Dinari's real one,
 *     something called "NVIDIA V4", and a token just named "NVIDIA"), plus
 *     "Denny's and NVIDIA", "NVIDIASPACEX MEMESTOCK" and "TEST PAIR VITH
 *     NVIDIA". Symbol lookup lands on a memecoin. Two Ondo symbols (MSTRon,
 *     HOODon) each exist at two different addresses.
 *   - `referenceSymbol` is the ticker sent to the price provider, and is
 *     deliberately separate from `symbol`. Where no listed underlying exists
 *     it is null, not a guess.
 *
 * Every address below was verified twice on 2026-09-10, and both sources had
 * to agree before the entry was written:
 *   1. Uniswap v4 Ethereum subgraph (DiYPVdyg...) -- symbol, name, decimals
 *   2. A direct eth_call to the contract via ethereum-rpc.publicnode.com --
 *      symbol(), decimals(), name(), and non-empty eth_getCode
 * Re-verify with:  node core/registry-verify.mjs
 */

/**
 * @typedef {import('./types.ts').BackingNote} BackingNote
 */

// ---------------------------------------------------------------- issuers --

/**
 * Issuer-level backing notes. EDITORIAL, not on-chain reads -- each carries its
 * own sourceUrl and checkedAt so it can never be mistaken for verified data.
 *
 * Deliberately silent on whether transfers are technically allowlisted at the
 * contract level. That is a claim about bytecode we have not verified, and
 * asserting it either way would be guessing.
 *
 * @type {Record<string, BackingNote>}
 */
export const ISSUERS = {
  ondo: {
    wrapper: 'Ondo Global Markets',
    jurisdiction: null, // not stated plainly in the public docs we read
    backing: 'Issuer states 1:1 backing by the underlying security held with a custodian.',
    redemption: 'Issuer describes redemption for eligible, verified non-US participants.',
    transferRestrictions:
      'Issuer describes eligibility restrictions including exclusion of US persons. ' +
      'Whether transfers are enforced on-chain via an allowlist has NOT been verified ' +
      'by us -- do not present this as a contract-level fact.',
    sourceUrl: 'https://ondo.finance/global-markets',
    checkedAt: '2026-09-10',
  },
  backed: {
    wrapper: 'Backed Finance (xStocks)',
    jurisdiction: 'Switzerland (issuer entity; per public materials)',
    backing: 'Issuer states 1:1 backing by the underlying security held with a custodian.',
    redemption: 'Issuer describes redemption for onboarded, KYC-verified professional investors.',
    transferRestrictions:
      'Tokens are described as freely transferable once issued; primary issuance and ' +
      'redemption are gated by KYC. On-chain enforcement NOT verified by us.',
    sourceUrl: 'https://backed.fi',
    checkedAt: '2026-09-10',
  },
}

// ----------------------------------------------------------------- tokens --

/**
 * @typedef {object} RegistryEntry
 * @property {string} ticker          Underlying ticker. The join key across issuers.
 * @property {string|null} referenceSymbol  Symbol to query the price provider with.
 *   NULL means no listed underlying exists (e.g. SpaceX is private), so no
 *   reference price is obtainable and deviation must stay null.
 * @property {string} issuer          Key into ISSUERS.
 * @property {string} symbol          On-chain symbol, as verified.
 * @property {string} name            On-chain name, as verified.
 * @property {number} decimals        Verified on-chain. Ondo and Backed are both 18.
 * @property {string} chain
 * @property {number} chainId
 * @property {string} adapter         Which adapter can price it.
 * @property {string} [note]          Anything a reviewer should know.
 */

/**
 * Keyed by lowercase contract address.
 *
 * Scope: Ethereum mainnet tokens that actually hold TVL in Uniswap v4. Of 443
 * Ondo-named tokens indexed, only 11 have TVL above $1,000 -- the rest are
 * deployed but untraded, and including them would pad the product with dead
 * rows. Presence here is NOT a claim that a token is liquid; the adapter still
 * measures volume and flags phantom liquidity per query.
 *
 * @type {Record<string, RegistryEntry>}
 */
export const TOKENS = {
  // --- Ondo Global Markets, Ethereum ---------------------------------------
  '0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee': {
    ticker: 'NVDA',
    referenceSymbol: 'NVDA',
    issuer: 'ondo',
    symbol: 'NVDAon',
    name: 'NVIDIA (Ondo Tokenized)',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
    note: 'Deepest Ondo market on Ethereum: ~$173k TVL, 22.8k txs.',
  },
  '0xf6b1117ec07684d3958cad8beb1b302bfd21103f': {
    ticker: 'TSLA',
    referenceSymbol: 'TSLA',
    issuer: 'ondo',
    symbol: 'TSLAon',
    name: 'Tesla (Ondo Tokenized)',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
  },
  '0xf3e4872e6a4cf365888d93b6146a2baa7348f1a4': {
    ticker: 'SLV',
    referenceSymbol: 'SLV',
    issuer: 'ondo',
    symbol: 'SLVon',
    name: 'iShares Silver Trust (Ondo Tokenized)',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
    note: 'ETF, not a single stock. Trades on US equity hours like any ETF.',
  },
  '0xfedc5f4a6c38211c1338aa411018dfaf26612c08': {
    ticker: 'SPY',
    referenceSymbol: 'SPY',
    issuer: 'ondo',
    symbol: 'SPYon',
    name: 'SPDR S&P 500 ETF (Ondo Tokenized)',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
  },
  '0x0e397938c1aa0680954093495b70a9f5e2249aba': {
    ticker: 'QQQ',
    referenceSymbol: 'QQQ',
    issuer: 'ondo',
    symbol: 'QQQon',
    name: 'Invesco QQQ (Ondo Tokenized)',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
  },
  '0x71d24baeb0a033ec5f90ff65c4210545af378d97': {
    ticker: 'GME',
    referenceSymbol: 'GME',
    issuer: 'ondo',
    symbol: 'GMEon',
    name: 'GameStop (Ondo Tokenized)',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
  },
  '0xf404e5f887dbd5508e16a1198fcdd5de1a4296b8': {
    ticker: 'MRVL',
    referenceSymbol: 'MRVL',
    issuer: 'ondo',
    symbol: 'MRVLon',
    name: 'Marvell Technology (Ondo Tokenized)',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
  },
  '0x33483a58079b4225b10e57958ca28ad7b9cdbaf7': {
    ticker: 'BMNR',
    referenceSymbol: 'BMNR',
    issuer: 'ondo',
    symbol: 'BMNRon',
    name: 'BitMine Immersion Technologies (Ondo Tokenized)',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
  },
  '0x1f5fc5c3c8b0f15c7e21af623936ff2b210b6415': {
    ticker: 'USO',
    referenceSymbol: 'USO',
    issuer: 'ondo',
    symbol: 'USOon',
    name: 'United States Oil Fund (Ondo Tokenized)',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
    note: 'Commodity fund. Tracks oil futures, not equity -- deviation reads differently.',
  },
  '0x0a00c19246fc41b2524d56c87ec44ce8b30ba0f8': {
    ticker: 'SQQQ',
    referenceSymbol: 'SQQQ',
    issuer: 'ondo',
    symbol: 'SQQQon',
    name: 'ProShares UltraPro Short QQQ (Ondo Tokenized)',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
    note: 'Leveraged inverse ETF. Only 20 txs -- expect phantom-liquidity flags.',
  },

  // REVIEWER: SpaceX is a PRIVATE company. There is no listed ticker and no
  // reference price to compare against, so referenceSymbol is null and the
  // deviation stays null rather than being invented. This entry exists to prove
  // the null path, and because omitting a $75k market would be hiding it.
  '0xc9eef266834730340a55b6cc24621b31baf55581': {
    ticker: 'SPCX',
    referenceSymbol: null,
    issuer: 'ondo',
    symbol: 'SPCXon',
    name: 'SpaceX (Ondo Tokenized)',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
    note: 'PRIVATE COMPANY -- no listed underlying, so no reference price exists.',
  },

  // --- Backed Finance xStocks, Ethereum ------------------------------------
  // Same chain, same subgraph, DIFFERENT issuer -- which is the whole product:
  // one ticker, several issuers, compared side by side.
  '0xc845b2894dbddd03858fd2d643b4ef725fe0849d': {
    ticker: 'NVDA',
    referenceSymbol: 'NVDA',
    issuer: 'backed',
    symbol: 'NVDAx',
    name: 'NVIDIA xStock',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
    note:
      'REVIEWER: verified real, but its pools trade ~$10/day, so its derived ' +
      'price is far from the real NVDA price. Kept deliberately -- it is a live ' +
      'example of a number that must be flagged, not shown.',
  },
  '0xae2f842ef90c0d5213259ab82639d5bbf649b08e': {
    ticker: 'MSTR',
    referenceSymbol: 'MSTR',
    issuer: 'backed',
    symbol: 'MSTRx',
    name: 'MicroStrategy xStock',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
    note: 'Thin: ~$2.4k TVL.',
  },
  '0xe1385fdd5ffb10081cd52c56584f25efa9084015': {
    ticker: 'HOOD',
    referenceSymbol: 'HOOD',
    issuer: 'backed',
    symbol: 'HOODx',
    name: 'Robinhood xStock',
    decimals: 18,
    chain: 'ethereum',
    chainId: 1,
    adapter: 'ethereum-univ4',
    note: 'Very thin: ~$437 TVL. Expect flags.',
  },
}

// ---------------------------------------------------------------- lookups --

/** Look up by contract address. The only safe lookup. */
export function byAddress(address) {
  if (typeof address !== 'string') return null
  return TOKENS[address.trim().toLowerCase()] ?? null
}

/**
 * Every registered token for an underlying ticker, across issuers.
 * This is what makes a comparison row: one ticker, many venues.
 */
export function byTicker(ticker) {
  const want = String(ticker || '').trim().toUpperCase()
  return Object.entries(TOKENS)
    .filter(([, e]) => e.ticker === want)
    .map(([address, e]) => ({ address, ...e }))
}

/** Tickers that have at least one registered token. */
export function tickers() {
  return [...new Set(Object.values(TOKENS).map((e) => e.ticker))].sort()
}
