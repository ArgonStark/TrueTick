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
  robinhood: {
    wrapper: 'Robinhood (Robinhood Chain)',
    jurisdiction: 'United States (Robinhood entities; per public materials)',
    backing:
      'Issuer describes tokens representing equity exposure held via a Robinhood entity. ' +
      'We have NOT verified the custody or backing arrangement.',
    redemption:
      'Not verified by us. Do not present redeemability as established fact.',
    transferRestrictions:
      'Not verified by us. Tokens are freely transferable on-chain in the mechanical ' +
      'sense (they trade in public Uniswap V3 pools), but any issuer-level eligibility ' +
      'or wrapper restriction has NOT been checked.',
    sourceUrl: 'https://docs.robinhood.com/chain',
    checkedAt: '2026-09-10',
  },
  'backed-solana': {
    wrapper: 'Backed Finance (xStocks, Solana)',
    jurisdiction: 'Switzerland (issuer entity; per public materials)',
    backing: 'Issuer states 1:1 backing by the underlying security held with a custodian.',
    redemption: 'Issuer describes redemption for onboarded, KYC-verified professional investors.',
    transferRestrictions:
      'Same issuer as the Ethereum xStocks entries; the SPL mints trade freely in public ' +
      'Raydium pools. On-chain enforcement NOT verified by us.',
    sourceUrl: 'https://backed.fi',
    checkedAt: '2026-09-12',
  },
  coinbase: {
    wrapper: 'Coinbase (B20 tokenized equities)',
    jurisdiction: 'United States (Coinbase entities; per public materials)',
    backing:
      'Issuer describes tokens tracking the underlying equity. We have NOT verified ' +
      'the custody or backing arrangement.',
    redemption: 'Not verified by us. Do not present redeemability as established fact.',
    transferRestrictions:
      'Not verified by us. The tokens trade in public Aerodrome Slipstream pools on ' +
      'Base, so they are mechanically transferable; any issuer-level eligibility gate ' +
      'has NOT been checked.',
    sourceUrl: 'https://www.coinbase.com',
    checkedAt: '2026-09-12',
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


  // --- Coinbase B20 tokenized equities, BASE (Aerodrome Slipstream) --------
  // Priced via OUR OWN published subgraph -- see core/adapters/base-aerodrome.mjs.
  // That subgraph is STILL SYNCING, so these rows render as 'subgraph-syncing'
  // with null prices until the index reaches these pools. They are registered
  // now, not later, because the architecture being ready is the claim: no code
  // changes are needed when the backfill completes, the nulls simply become
  // numbers.
  //
  // Verified 2026-09-12 against TWO independent sources:
  //   1. Base RPC eth_call -> symbol(), name(), decimals(), totalSupply()
  //      (mainnet.base.org and base-rpc.publicnode.com, agreeing)
  //   2. CLFactory.getPool(token0, token1, tickSpacing) on the TARGET factory
  //      0xf8f2eB49..., confirming each token has a real pool there
  // The NVDAc/USDC pool resolved to 0x853f5f1b92b16714fe6cda67caad0856b83c7ab9,
  // matching the pool independently verified during the subgraph fork.
  //
  // decimals are 8, like the Solana xStocks and unlike Ondo's 18 -- per TOKEN,
  // never per chain.
  //
  // NOTE on eth_getCode: these addresses return the single byte 0xef rather
  // than ordinary bytecode, yet answer every standard ERC-20 call identically
  // from two independent providers. A "does it have bytecode" check is simply
  // the wrong test for this contract class and would reject seven valid tokens.
  '0xb20000000000000000000078ee7ce2fe4908108c': {
    ticker: 'NVDA',
    referenceSymbol: 'NVDA',
    issuer: 'coinbase',
    symbol: 'NVDAc',
    name: 'NVIDIA Corporation',
    decimals: 8,
    chain: 'base',
    chainId: 8453,
    adapter: 'base-aerodrome',
    pools: [
      { pool: '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9', quote: 'USDC', tickSpacing: 10 },
      { pool: '0x204b5342c46a7e1be3988e60acb2b7aaca2e40ab', quote: 'USDC', tickSpacing: 200 },
      { pool: '0x20e5fad2661ee9eb0c04824524030af31943b62d', quote: 'WETH', tickSpacing: 50 },
    ],
    note: 'Deepest tokenized-stock market surveyed on any chain (~$9.4M/day).',
  },
  '0xb200000000000000000000c2e324d24d7eecd1fb': {
    ticker: 'AAPL',
    referenceSymbol: 'AAPL',
    issuer: 'coinbase',
    symbol: 'AAPLc',
    name: 'Apple Inc.',
    decimals: 8,
    chain: 'base',
    chainId: 8453,
    adapter: 'base-aerodrome',
    pools: [
      { pool: '0xa3b1e3f9747065e2073722ff4c9027d3ea4994f0', quote: 'USDC', tickSpacing: 10 },
      { pool: '0x8feacb3aac9499ba4f53aa16e9cd38c36c57765e', quote: 'USDC', tickSpacing: 200 },
    ],
  },
  '0xb2000000000000000000008bc8786b856e61707c': {
    ticker: 'META',
    referenceSymbol: 'META',
    issuer: 'coinbase',
    symbol: 'METAc',
    name: 'Meta Platforms Inc.',
    decimals: 8,
    chain: 'base',
    chainId: 8453,
    adapter: 'base-aerodrome',
    pools: [{ pool: '0xeaf57753bc382e0324a1d43f72e7027705a2273e', quote: 'USDC', tickSpacing: 10 }],
  },
  '0xb2000000000000000000002d0ba3164cc74f58b7': {
    ticker: 'GOOGL',
    referenceSymbol: 'GOOGL',
    issuer: 'coinbase',
    symbol: 'GOOGLc',
    name: 'Alphabet Inc.',
    decimals: 8,
    chain: 'base',
    chainId: 8453,
    adapter: 'base-aerodrome',
    pools: [
      { pool: '0xb1987cad1682841b4b641d50e520777ec5ab5542', quote: 'USDC', tickSpacing: 10 },
      { pool: '0xc72153764f7a6c9a4cfa5e0834afc2a66100c1aa', quote: 'WETH', tickSpacing: 10 },
      { pool: '0x25f63549b2bb9fff114cdc39e8cfb16b450e2f9b', quote: 'WETH', tickSpacing: 50 },
    ],
  },
  '0xb2000000000000000000001e800a7f5189430cd0': {
    ticker: 'TSLA',
    referenceSymbol: 'TSLA',
    issuer: 'coinbase',
    symbol: 'TSLAc',
    name: 'Tesla Inc.',
    decimals: 8,
    chain: 'base',
    chainId: 8453,
    adapter: 'base-aerodrome',
    pools: [{ pool: '0x469337fdcc5e8f38e2e4b670b04f57865d13a7bb', quote: 'USDC', tickSpacing: 10 }],
  },
  '0xb200000000000000000000ab99cfa739e253872b': {
    ticker: 'MSFT',
    referenceSymbol: 'MSFT',
    issuer: 'coinbase',
    symbol: 'MSFTc',
    name: 'Microsoft Corporation',
    decimals: 8,
    chain: 'base',
    chainId: 8453,
    adapter: 'base-aerodrome',
    pools: [{ pool: '0x7103eb3c9590d1281f7dc03b2a9ee27c39df5d54', quote: 'USDC', tickSpacing: 10 }],
  },
  '0xb200000000000000000000d9192b6b456483c2e8': {
    ticker: 'AMZN',
    referenceSymbol: 'AMZN',
    issuer: 'coinbase',
    symbol: 'AMZNc',
    name: 'Amazon.com Inc.',
    decimals: 8,
    chain: 'base',
    chainId: 8453,
    adapter: 'base-aerodrome',
    pools: [
      { pool: '0x22cf9b71933cac55b69f7cd9c6beb45a6dde5c76', quote: 'USDC', tickSpacing: 1 },
      { pool: '0xd03bc8c7f2faedce2aac81bf0444aea08ea06e9b', quote: 'USDC', tickSpacing: 10 },
    ],
  },

  // --- Backed xStocks, SOLANA (Raydium CLMM) ------------------------------
  // Keyed by SPL mint (base58), not an EVM address. Verified 2026-09-12 against
  // two sources: Solana RPC getTokenSupply, and the Raydium CLMM PoolState
  // account decoded for each pool (whose embedded mints had to match).
  // decimals are 8 here vs 18 for the same issuer's Ethereum tokens -- which is
  // exactly why decimals live per TOKEN and never per chain.
  // Priced via SUBSTREAMS -- see core/adapters/solana-substreams.mjs.
  'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh': {
    ticker: 'NVDA',
    referenceSymbol: 'NVDA',
    issuer: 'backed-solana',
    symbol: 'NVDAx',
    name: 'NVIDIA xStock (Solana)',
    decimals: 8,
    chain: 'solana',
    chainId: null,
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    adapter: 'solana-substreams',
    note:
      'REVIEWER: same issuer as the Ethereum NVDAx, which is flagged dead ($27k TVL, $0 volume). This Solana market is deep and live. Same issuer, same ticker, opposite venue quality -- the clearest argument for per-venue flags.',
    /** Raydium CLMM pool + its two vaults, decoded from PoolState. */
    pools: [
      { pool: '49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6', vaultBase: 'DyKsypuzQvhi37K8UvjCMBC43h4HtW4r6jhWoqHyrSSe', vaultQuote: '4JEtq7NraU9U5URcCKSv6sWRRgDSuSnUjYDqpSJSWohY', fee: null },
    ],
  },
  'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W': {
    ticker: 'SPY',
    referenceSymbol: 'SPY',
    issuer: 'backed-solana',
    symbol: 'SPYx',
    name: 'SPDR S&P 500 ETF xStock (Solana)',
    decimals: 8,
    chain: 'solana',
    chainId: null,
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    adapter: 'solana-substreams',
    /** Raydium CLMM pool + its two vaults, decoded from PoolState. */
    pools: [
      { pool: '6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE', vaultBase: 'CiQuPAfYp5v82vijk6u7wqFnaZqtGdJfUUSjDKAtT9ML', vaultQuote: '3EmW8zJDHrfgwpQJAt1oD6nxgQZLUwrCRSKk8Gr3iKRF', fee: null },
    ],
  },
  'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ': {
    ticker: 'QQQ',
    referenceSymbol: 'QQQ',
    issuer: 'backed-solana',
    symbol: 'QQQx',
    name: 'Invesco QQQ xStock (Solana)',
    decimals: 8,
    chain: 'solana',
    chainId: null,
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    adapter: 'solana-substreams',
    /** Raydium CLMM pool + its two vaults, decoded from PoolState. */
    pools: [
      { pool: 'GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG', vaultBase: '4RWQkhLbmgQ4xeQyY2iqAqiEFkRNWB5gdChZkXaFUVxY', vaultQuote: 'D3JT9Uam9DAuBysFvpYDTxQqLuTxRrVwuj5je1XCLLU7', fee: null },
    ],
  },
  'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8': {
    ticker: 'SPCX',
    referenceSymbol: null,
    issuer: 'backed-solana',
    symbol: 'SPCXx',
    name: 'SpaceX xStock (Solana)',
    decimals: 8,
    chain: 'solana',
    chainId: null,
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    adapter: 'solana-substreams',
    note:
      'PRIVATE COMPANY -- no listed underlying, so referenceSymbol stays null.',
    /** Raydium CLMM pool + its two vaults, decoded from PoolState. */
    pools: [
      { pool: 'AHNN6JmvaGG6XUoSg7sEr38gRYDB2jTbUvqXVuqaRHpq', vaultBase: '2wmq9LoqAjyKr5YkenAkGozA7xZvbfrCqJXFUuyQHYoa', vaultQuote: 'AUpEZuNEZfqUXqsoiTymSEwiRXwT67Vvr1bnBqyQSzNv', fee: null },
    ],
  },
  'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re': {
    ticker: 'GLD',
    referenceSymbol: 'GLD',
    issuer: 'backed-solana',
    symbol: 'GLDx',
    name: 'SPDR Gold Trust xStock (Solana)',
    decimals: 8,
    chain: 'solana',
    chainId: null,
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    adapter: 'solana-substreams',
    /** Raydium CLMM pool + its two vaults, decoded from PoolState. */
    pools: [
      { pool: '78ReVNMLGRWmjtf2HmBoHUe2pRcsctXTTbxJnbhchyze', vaultBase: 'Qf2BrMGurzSMiqeXNKQdG6XzbWeWG9FCP7tndHNikNj', vaultQuote: '8BECXqsvkZcWD1MpzYV4p7NXD8xu5ZzquQ52NNGFqUsm', fee: null },
    ],
  },

  // --- Robinhood, Robinhood Chain (chainId 4663) ---------------------------
  // Verified 2026-09-10 by enumerating every USDG-quoted Uniswap V3 pool on
  // chain (4,924 pools) and keeping tokens whose ON-CHAIN NAME matches the
  // issuer pattern '<Company> • Robinhood Token'. Name-matched, never
  // symbol-matched. Zero duplicate symbols in that set; all 18 decimals.
  // Priced via SUBSTREAMS on The Graph (this chain has no published subgraph)
  // -- see core/adapters/robinhood-substreams.mjs. The RPC adapter remains
  // in the tree as a fallback; set ROBINHOOD_ADAPTER=rpc to use it.
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec': {
    ticker: 'NVDA',
    referenceSymbol: 'NVDA',
    issuer: 'robinhood',
    symbol: 'NVDA',
    name: 'NVIDIA • Robinhood Token',
    decimals: 18,
    chain: 'robinhood',
    chainId: 4663,
    adapter: 'robinhood-substreams',
    note:
      'Deepest RWA market on the chain: ~$3.6M USDG in pools, ~15x the Ethereum Ondo pool.',
    /**
     * Pools for this token, discovered once and stored as verified static
     * facts. Pool membership is chain STATE; the Substreams adapter reads
     * EVENTS, so it cannot discover pools itself. Re-discover with
     * scripts/discover-robinhood-pools.mjs if the issuer adds markets.
     */
    pools: [
      { pool: '0xc277560df3689a401ba7dedd7626168b234ceb5e', fee: 10000, ourTokenIsToken0: false },
      { pool: '0xb75d2d02b0ec3de50d32e40a4f1a8dae8acc4333', fee: 100, ourTokenIsToken0: false },
      { pool: '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3', fee: 500, ourTokenIsToken0: false },
      { pool: '0xb944cec30bd4175855215d767adc81f39e5f7e2b', fee: 3000, ourTokenIsToken0: false },
    ],
  },
  '0x1b0e319c6a659f002271b69db8a7df2f911c153e': {
    ticker: 'GME',
    referenceSymbol: 'GME',
    issuer: 'robinhood',
    symbol: 'GME',
    name: 'GameStop • Robinhood Token',
    decimals: 18,
    chain: 'robinhood',
    chainId: 4663,
    adapter: 'robinhood-substreams',
    /**
     * Pools for this token, discovered once and stored as verified static
     * facts. Pool membership is chain STATE; the Substreams adapter reads
     * EVENTS, so it cannot discover pools itself. Re-discover with
     * scripts/discover-robinhood-pools.mjs if the issuer adds markets.
     */
    pools: [
      { pool: '0x0a0675689c2ad2a3ade86539bcbd27b6c0764e9d', fee: 3000, ourTokenIsToken0: true },
      { pool: '0xe2b46c905e12ab8e2f864e4821a4325884c1b126', fee: 500, ourTokenIsToken0: true },
      { pool: '0xb7723619e09e9317b3e538e7531ecbb910aec107', fee: 100, ourTokenIsToken0: true },
      { pool: '0xe9713f453adb9245b19559790c96f470a18f2fdf', fee: 10000, ourTokenIsToken0: true },
    ],
  },
  '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea': {
    ticker: 'SPCX',
    referenceSymbol: null,
    issuer: 'robinhood',
    symbol: 'SPCX',
    name: 'Space Exploration Technologies Corp. Class A Common Stock • Robinhood Token',
    decimals: 18,
    chain: 'robinhood',
    chainId: 4663,
    adapter: 'robinhood-substreams',
    note:
      'PRIVATE COMPANY -- no listed underlying, so referenceSymbol stays null, same as SPCXon. With ~$1.5M here it gives a venue-vs-venue comparison with no public market involved.',
    /**
     * Pools for this token, discovered once and stored as verified static
     * facts. Pool membership is chain STATE; the Substreams adapter reads
     * EVENTS, so it cannot discover pools itself. Re-discover with
     * scripts/discover-robinhood-pools.mjs if the issuer adds markets.
     */
    pools: [
      { pool: '0x87c58b43537005189cfc7b512d818dc9125e94fc', fee: 100, ourTokenIsToken0: true },
      { pool: '0xc61284332117c3fb23a2a56cceffd07f7af60029', fee: 500, ourTokenIsToken0: true },
      { pool: '0xeb07d9587efd1778dfb9c385ec43ef6d5f9fe401', fee: 3000, ourTokenIsToken0: true },
      { pool: '0xfbb32c09488e3fc33fe6fd84fe6ae442b4d13a31', fee: 10000, ourTokenIsToken0: true },
    ],
  },
  '0x322f0929c4625ed5bad873c95208d54e1c003b2d': {
    ticker: 'TSLA',
    referenceSymbol: 'TSLA',
    issuer: 'robinhood',
    symbol: 'TSLA',
    name: 'Tesla • Robinhood Token',
    decimals: 18,
    chain: 'robinhood',
    chainId: 4663,
    adapter: 'robinhood-substreams',
    /**
     * Pools for this token, discovered once and stored as verified static
     * facts. Pool membership is chain STATE; the Substreams adapter reads
     * EVENTS, so it cannot discover pools itself. Re-discover with
     * scripts/discover-robinhood-pools.mjs if the issuer adds markets.
     */
    pools: [
      { pool: '0xb349fb08c2712f3a70bad40a4d006b68d67e888b', fee: 10000, ourTokenIsToken0: true },
      { pool: '0x7868622ff2c3b1b6c8acb15fe0bdaebf043dda48', fee: 100, ourTokenIsToken0: true },
      { pool: '0xc4f0172d6ac8dd294dd1137d047d5e1893760236', fee: 500, ourTokenIsToken0: true },
      { pool: '0xf4acdaeeb7022862a763c9b1b885e11191c889e3', fee: 3000, ourTokenIsToken0: true },
    ],
  },
  '0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344': {
    ticker: 'USO',
    referenceSymbol: 'USO',
    issuer: 'robinhood',
    symbol: 'USO',
    name: 'United States Oil Fund • Robinhood Token',
    decimals: 18,
    chain: 'robinhood',
    chainId: 4663,
    adapter: 'robinhood-substreams',
    /**
     * Pools for this token, discovered once and stored as verified static
     * facts. Pool membership is chain STATE; the Substreams adapter reads
     * EVENTS, so it cannot discover pools itself. Re-discover with
     * scripts/discover-robinhood-pools.mjs if the issuer adds markets.
     */
    pools: [
      { pool: '0x02175608f1b5e6b5ed221ccfdc7be197d111d915', fee: 3000, ourTokenIsToken0: false },
      { pool: '0x6ed11c7dfd8e2ca5620eed29a7b9b53ae90dd0d2', fee: 10000, ourTokenIsToken0: false },
    ],
  },
  '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68': {
    ticker: 'QQQ',
    referenceSymbol: 'QQQ',
    issuer: 'robinhood',
    symbol: 'QQQ',
    name: 'Invesco QQQ • Robinhood Token',
    decimals: 18,
    chain: 'robinhood',
    chainId: 4663,
    adapter: 'robinhood-substreams',
    /**
     * Pools for this token, discovered once and stored as verified static
     * facts. Pool membership is chain STATE; the Substreams adapter reads
     * EVENTS, so it cannot discover pools itself. Re-discover with
     * scripts/discover-robinhood-pools.mjs if the issuer adds markets.
     */
    pools: [
      { pool: '0x4539019b527211998642fec342c85dcb44c7e5e4', fee: 100, ourTokenIsToken0: false },
      { pool: '0xd60a5d14db690b7afad71f76b108071d7175597d', fee: 500, ourTokenIsToken0: false },
      { pool: '0xebd78dcfc8a6b3a696f1e191ad1ff321f9579f79', fee: 3000, ourTokenIsToken0: false },
    ],
  },
  '0xec262a75e413fafd0df80480274532c79d42da09': {
    ticker: 'MSTR',
    referenceSymbol: 'MSTR',
    issuer: 'robinhood',
    symbol: 'MSTR',
    name: 'Strategy Inc. • Robinhood Token',
    decimals: 18,
    chain: 'robinhood',
    chainId: 4663,
    adapter: 'robinhood-substreams',
    /**
     * Pools for this token, discovered once and stored as verified static
     * facts. Pool membership is chain STATE; the Substreams adapter reads
     * EVENTS, so it cannot discover pools itself. Re-discover with
     * scripts/discover-robinhood-pools.mjs if the issuer adds markets.
     */
    pools: [
      { pool: '0x2c08bcef714bc8124972b7181494fc598e8ed111', fee: 3000, ourTokenIsToken0: false },
      { pool: '0x17578c0e0d15da44f31677263114f71ae76653ea', fee: 10000, ourTokenIsToken0: false },
    ],
  },
  '0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f': {
    ticker: 'SLV',
    referenceSymbol: 'SLV',
    issuer: 'robinhood',
    symbol: 'SLV',
    name: 'iShares Silver Trust • Robinhood Token',
    decimals: 18,
    chain: 'robinhood',
    chainId: 4663,
    adapter: 'robinhood-substreams',
    /**
     * Pools for this token, discovered once and stored as verified static
     * facts. Pool membership is chain STATE; the Substreams adapter reads
     * EVENTS, so it cannot discover pools itself. Re-discover with
     * scripts/discover-robinhood-pools.mjs if the issuer adds markets.
     */
    pools: [
      { pool: '0x37ed4621d1eb3abc9e551a888e6aaf0a41f7be8e', fee: 500, ourTokenIsToken0: true },
      { pool: '0x0fa7bc480885dcf58ad2ef63ec7289cf2481d51c', fee: 10000, ourTokenIsToken0: true },
      { pool: '0x8cb787e6c315d464775289bad00fdd67d53ecb3d', fee: 3000, ourTokenIsToken0: true },
    ],
  },
  '0x117cc2133c37b721f49de2a7a74833232b3b4c0c': {
    ticker: 'SPY',
    referenceSymbol: 'SPY',
    issuer: 'robinhood',
    symbol: 'SPY',
    name: 'SPDR S&P 500 ETF Trust • Robinhood Token',
    decimals: 18,
    chain: 'robinhood',
    chainId: 4663,
    adapter: 'robinhood-substreams',
    /**
     * Pools for this token, discovered once and stored as verified static
     * facts. Pool membership is chain STATE; the Substreams adapter reads
     * EVENTS, so it cannot discover pools itself. Re-discover with
     * scripts/discover-robinhood-pools.mjs if the issuer adds markets.
     */
    pools: [
      { pool: '0xa7bb1ac63bbab0c44316e6c8c455213441689167', fee: 500, ourTokenIsToken0: true },
      { pool: '0xa43b424bc609495aed4bcd88d654934b510b0ad9', fee: 3000, ourTokenIsToken0: true },
    ],
  },
  '0x62fd0668e10d8b72339be2dcf7643001688ff13b': {
    ticker: 'MRVL',
    referenceSymbol: 'MRVL',
    issuer: 'robinhood',
    symbol: 'MRVL',
    name: 'Marvell Technology • Robinhood Token',
    decimals: 18,
    chain: 'robinhood',
    chainId: 4663,
    adapter: 'robinhood-substreams',
    /**
     * Pools for this token, discovered once and stored as verified static
     * facts. Pool membership is chain STATE; the Substreams adapter reads
     * EVENTS, so it cannot discover pools itself. Re-discover with
     * scripts/discover-robinhood-pools.mjs if the issuer adds markets.
     */
    pools: [
      { pool: '0xb5e892f0fc6daadda5b927266fe7907e623e4843', fee: 3000, ourTokenIsToken0: false },
      { pool: '0x06cc0b96be1fa1d754ce2e1228f5d8c616f795b0', fee: 10000, ourTokenIsToken0: false },
    ],
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
  const key = address.trim()
  // EXACT FIRST. Solana SPL mints are base58 and CASE-SENSITIVE, so
  // lowercasing them never matches -- 'Xsc9qvGR...' is not 'xsc9qvgr...'.
  // EVM hex is case-insensitive, so the lowercase fallback still serves it.
  return TOKENS[key] ?? TOKENS[key.toLowerCase()] ?? null
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
