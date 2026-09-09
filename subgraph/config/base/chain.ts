import { Address, BigDecimal, BigInt } from '@graphprotocol/graph-ts'

// Aerodrome Slipstream CLFactory on Base -- NOT the Uniswap v3 factory.
// Verified: Blockscout reports contract name "CLFactory" (verified source),
// its voter() returns Aerodrome's ve(3,3) Voter 0x16613524..., and the live
// NVDAc/USDC pool 0x853F5f1B... reports this address from factory().
export const FACTORY_ADDRESS = '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef'

// WETH on Base. Verified on-chain: symbol WETH, 18 decimals.
export const REFERENCE_TOKEN = '0x4200000000000000000000000000000000000006'

// The pool getEthPriceInUSD() reads to price ETH. It is loaded from THIS
// subgraph's own store (Pool.load), so it MUST be a pool created by the factory
// above -- the upstream value was a Uniswap v3 pool, which an Aerodrome-only
// subgraph never indexes, so ethPriceUSD would resolve to 0 and every USD field
// in the subgraph would silently be $0.
// This is Aerodrome CL WETH/USDC, tickSpacing 50: $8.3M TVL, $54.9M 24h volume,
// the deepest WETH/USDC pool on this factory.
export const STABLE_TOKEN_POOL = '0x3fe04a59ebd38cf06080a6f60a98d124eb59392a'

export const TVL_MULTIPLIER_THRESHOLD = '2'
export const MATURE_MARKET = '1000000'
export const MINIMUM_NATIVE_LOCKED = BigDecimal.fromString('4')

export const ROLL_DELETE_HOUR = 768
export const ROLL_DELETE_MINUTE = 1680

export const ROLL_DELETE_HOUR_LIMITER = BigInt.fromI32(500)
export const ROLL_DELETE_MINUTE_LIMITER = BigInt.fromI32(1000)

// token where amounts should contribute to tracked volume and liquidity
// usually tokens that many tokens are paired with s
// Tokens whose pools count toward tracked volume and liquidity.
//
// The upstream list had USDC as 0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e,
// which is USDC on AVALANCHE -- eth_getCode proves there is no contract at that
// address on Base. Every Coinbase tokenized stock (NVDAc/AAPLc/METAc/GOOGLc)
// pairs against real Base USDC, so with the wrong address none of those pools
// would be whitelisted and their tracked TVL and volume would report $0.
//
// Verified on-chain (Base): 0x833589fC... -> symbol "USDC", 6 decimals.
export const WHITELIST_TOKENS: string[] = [
  REFERENCE_TOKEN, // WETH
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC (native, Base)
]

export const STABLE_COINS: string[] = [
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC (native, Base)
]

export const SKIP_POOLS: string[] = []

export const POOL_MAPINGS: Array<Address[]> = []

export class TokenDefinition {
  address: Address
  symbol: string
  name: string
  decimals: BigInt
}

export const STATIC_TOKEN_DEFINITIONS: TokenDefinition[] = []
