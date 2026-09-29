// Contingent — live deployment on Arbitrum Sepolia (chain 421614)
// All addresses source-verified on Arbiscan. See ../../../DEPLOYMENTS.md

export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
export const ARBITRUM_SEPOLIA_RPC =
  process.env.NEXT_PUBLIC_ARB_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';

export const ADDRESSES = {
  hedge: '0x670b2dC8EEa68Cb6BA2caC4021FCE02b85C51Dcf',
  cusdg: '0xd8f57E64bc235D4bceF8D2f791BDf46908408F94',
  collateral: '0x4E4cb1b3B326C79FDFD51E14C26C9bDA7a5F5898',
  positions: '0xA39438870296a652A268B7A187C5a540bf89cD36',
  market: '0xD81751083861194276BC401Fc94052De0ea3A97a',
  vault: '0xB73fF66E6768eC894BaF56E48e93dBBaAD745DCf',
  router: '0xF0573896166052659A90Fa3626A0ff36637353CF',
  positionNFT: '0xA526FADAA46544da9b54EC97Ab7e1B80DE00a542',
  resolver: '0xd4fa6b3b391Cc75eED61427F08051E219cB46cc4',
  eventHook: '0xc809EecCc81148B72bFCEB6F812e0deEA982C8C0',
  perp: '0x8547089cE2380ec20Ad68c5fff4E661863452718', // ConfidentialPerp (ETH-PERP)
  protectedPerp: '0xf97AA238bA1e462c05863eFa9cc4E13d240Ffb2c', // ProtectedPerp (perp + event protection, one tx)
  usdg: '0x766f287682ecfbD8f97551727684c7d7aD67a53f', // MockUSDG (6-dec)
  feed: '0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165', // real Chainlink ETH/USD (8-dec) on Arb Sepolia
} as const;

// Live event: "ETH >= $2,500" — resolved by the real Chainlink ETH/USD feed
export const EVENT_ID = '0x39202be02b06dc6b76ca67169428a0974173687d9b46a92d8aa36b906986849e';
export const EVENT_LABEL = 'ETH ≥ $2,500';
export const STRIKE_USD = 2500;
export const EVENT_YES_WHEN = 'above'; // YES when ETH >= strike
export const BINANCE_SYMBOL = 'ETHUSDT';
export const USDG_DECIMALS = 6;
export const FEED_DECIMALS = 8;
export const BPS = 10_000;

// ── Human-readable ABIs (ethers v6) — only the functions the UI calls ──

export const HEDGE_ABI = [
  'function openHedge(bytes32 eventId, bytes32 encSize, bytes sizeProof, bytes32 encIsYes, bytes dirProof) returns (uint256)',
  'function closeHedge(uint256 positionId)',
  'function requestSettlement(uint256 positionId)',
  'function fulfillSettlement(uint256 positionId, uint64 plaintextPayout, bytes signature)',
  'function requestPremiumSweep(bytes32 eventId) returns (bytes32)',
  'function sweepPremiums(bytes32 eventId, uint64 totalPremium, bytes signature)',
  'function finaliseEvent(bytes32 eventId)',
  'function payoutHandle(uint256 positionId) view returns (bytes32)',
  'function paid(uint256 positionId) view returns (bool)',
  'event HedgeOpened(uint256 indexed positionId, address indexed user, bytes32 indexed eventId, uint32 entryProbBps)',
];

export const PERP_ABI = [
  'function openPosition(bytes32 encCollateral, bytes collateralProof, bytes32 encIsLong, bytes directionProof, uint64 leverage) returns (uint256)',
  'function requestClose(uint256 id)',
  'function fulfillClose(uint256 id, uint64 payout, bytes payoutSig, uint64 collateralAmount, bytes collateralSig)',
  'function requestLiquidationCheck(uint256 id)',
  'function resolveLiquidationCheck(uint256 id, bool isLiquidatable, bytes signature)',
  'function finalizeLiquidation(uint256 id, uint64 collateralAmount, bytes signature)',
  'function getPosition(uint256 id) view returns (tuple(address owner, uint64 leverage, uint256 entryPrice, uint256 openedAt, uint8 status, bytes32 collateral, bytes32 size, bytes32 isLong, bytes32 maxProfit, bytes32 payout, bytes32 liquidatable, uint256 markPriceAtRequest, address keeper))',
  'function positionsOf(address user) view returns (uint256[])',
  'function markPrice() view returns (uint256)',
  'function houseLiquidity() view returns (uint256)',
  'function openCount() view returns (uint256)',
  'function nextPositionId() view returns (uint256)',
  'event PositionOpened(uint256 indexed id, address indexed owner, uint64 leverage, uint256 entryPrice)',
];

export const PROTECTED_ABI = [
  'function openProtected(bytes32 encCollateral, bytes collateralProof, bytes32 encIsLong, bytes directionProof, uint64 leverage, bytes32 encCover, bytes coverProof) returns (uint256 perpId, uint256 hedgeId)',
  'function protectionOf(uint256 perpId) view returns (uint256)',
  'function eventId() view returns (bytes32)',
  'event ProtectedOpened(address indexed trader, uint256 indexed perpId, uint256 indexed hedgeId, uint64 leverage)',
];

// Perp constants (mirror ConfidentialPerp.sol)
export const PERP = {
  MAX_LEVERAGE: 10,
  MAX_PROFIT_MULT: 5,
  MAINTENANCE_BPS: 500,
  STATUS: ['None', 'Open', 'Closing', 'LiqCheck', 'Liquidating', 'Closed'] as const,
};

export const MARKET_ABI = [
  'function probYesBps(bytes32 eventId) view returns (uint256)',
  'function isOpenForHedging(bytes32 eventId) view returns (bool)',
  'function isResolved(bytes32 eventId) view returns (bool resolved, bool outcomeYes)',
  'function resolve(bytes32 eventId)',
  'function stake(bytes32 eventId, bool yes, uint256 amount)',
  'function getMarket(bytes32 eventId) view returns (uint256 yesPool, uint256 noPool, uint64 closeTime, address resolver, bool resolved, bool outcomeYes, bool exists)',
  'event Staked(bytes32 indexed eventId, bool yes, uint256 amount, uint32 newProbYesBps)',
  'event MarketResolved(bytes32 indexed eventId, bool outcomeYes)',
];

export const VAULT_ABI = [
  'function totalReserve() view returns (uint256)',
  'function earmarked() view returns (uint256)',
  'function freeReserve() view returns (uint256)',
  'function deposit(uint256 assets) returns (uint256)',
  'function withdraw(uint256 shares) returns (uint256)',
  'function earmark(bytes32 eventId, uint256 capacity)',
  'function finaliseEvent(bytes32 eventId)',
  'function sharesOf(address) view returns (uint256)',
  'function sharePriceWad() view returns (uint256)',
  'function committedYes(bytes32 eventId) view returns (bytes32)',
  'function committedNo(bytes32 eventId) view returns (bytes32)',
  'function premiumPool(bytes32 eventId) view returns (bytes32)',
  'function events(bytes32) view returns (uint256 capacity, uint256 paidOut, bool active, bool premiumsSwept)',
];

export const CUSDG_ABI = [
  'function wrap(uint256 amount)',
  'function confidentialTransferAndCall(address to, bytes32 amount, bytes inputProof, bytes data) returns (bytes32)',
  'function confidentialBalanceOf(address account) view returns (bytes32)',
  'function setOperator(address operator, uint48 until)',
  'function totalWrapped() view returns (uint256)',
];

export const COLLATERAL_ABI = [
  'function withdraw(bytes32 encAmount, bytes inputProof)',
  'function myCollateral() view returns (bytes32)',
];

export const POSITIONS_ABI = [
  'function get(uint256 positionId) view returns (tuple(bytes32 size, bytes32 premium, bytes32 isYes, bytes32 eventId, uint32 entryProbBps, uint256 openedAt, address owner, bool isOpen, bool settled))',
  'function positionsOf(address, uint256) view returns (uint256)',
  'function nextPositionId() view returns (uint256)',
];

export const NFT_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOrZero(uint256 tokenId) view returns (address)',
];

export const RESOLVER_ABI = [
  'function outcome(bytes32 eventId) view returns (bool resolved, bool yes)',
];

export const USDG_ABI = [
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

export const FEED_ABI = [
  'function setAnswer(int256 newAnswer)',
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
  'function decimals() view returns (uint8)',
];

// ── Demo roles (local anvil-style keys; DEMO ONLY, never mainnet funds) ──
export interface DemoRole {
  id: 'hedger' | 'lp' | 'keeper';
  name: string;
  badge: string;
  color: string; // neo accent
  description: string;
}

export const DEMO_ROLES: Record<'hedger' | 'lp' | 'keeper', DemoRole> = {
  hedger: {
    id: 'hedger',
    name: 'Hedger',
    badge: 'HEDGER',
    color: 'cyan',
    description: 'Opens a private, encrypted hedge on an event — size and side hidden.',
  },
  lp: {
    id: 'lp',
    name: 'Underwriter (LP)',
    badge: 'LP',
    color: 'green',
    description: 'Deposits USDG to back payouts and earn the premium spread.',
  },
  keeper: {
    id: 'keeper',
    name: 'Keeper',
    badge: 'KEEPER',
    color: 'yellow',
    description: 'Resolves the event and drives async settlement.',
  },
};
