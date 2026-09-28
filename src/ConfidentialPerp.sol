// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FHE, euint64, ebool, externalEuint64, externalEbool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ConfidentialUSDG} from "./ConfidentialUSDG.sol";
import {ConfidentialCollateral} from "./ConfidentialCollateral.sol";
import {AggregatorV3Interface} from "./resolvers/PriceThresholdResolver.sol";

/// @title ConfidentialPerp - leveraged long/short perpetuals with encrypted size and direction
/// @notice A trader opens a 1-10x long or short on ETH/USD (Chainlink). Collateral, size and direction are
///         `euint64`/`ebool` ciphertexts, so no one can see a position's exposure or where it gets liquidated —
///         stop-hunting and copy-trading are impossible while it's open.
///
///         Counterparty is a **house pool** of LP USDG: it pays trader profits and keeps trader losses.
///         Solvency is enforced on ciphertext: each position reserves `maxProfit = collateral × 5` against the
///         pool, and an encrypted clamp caps accepted collateral so total reserved profit never exceeds the pool.
///
///         Privacy by construction:
///         - **Liquidation check** computes PnL on the ciphertext and reveals **one bit** (liquidatable or not).
///           A healthy position leaks nothing else.
///         - **Close** computes the payout on the ciphertext; only the final payout and collateral are decrypted,
///           after the position has ended.
///         Every reveal uses the CoFHE 3-step async flow (allowPublic → off-chain decryptForTx → publish).
contract ConfidentialPerp {
  using SafeERC20 for IERC20;

  uint256 public constant BPS = 10_000;
  uint64 public constant MAX_LEVERAGE = 10;
  uint64 public constant MAX_PROFIT_MULT = 5; // profit capped at 5x collateral
  uint256 public constant MAINTENANCE_BPS = 500; // 5% of collateral
  uint256 public constant KEEPER_BONUS_BPS = 100; // 1% of collateral to the liquidator
  uint256 public constant BORROW_BPS_PER_HOUR = 1; // 0.01% of collateral per hour held
  uint256 public constant MAX_DELTA_BPS = 20_000; // price-move cap used in PnL math (overflow guard)
  uint256 public constant STALENESS = 1 hours;

  enum Status {
    None,
    Open,
    Closing,
    LiqCheck,
    Liquidating,
    Closed
  }

  struct Position {
    address owner;
    uint64 leverage; // public 1..10
    uint256 entryPrice; // public, feed decimals (8)
    uint256 openedAt;
    Status status;
    euint64 collateral; // encrypted
    euint64 size; // encrypted = collateral × leverage
    ebool isLong; // encrypted direction
    euint64 maxProfit; // encrypted = collateral × MAX_PROFIT_MULT (reserved against the pool)
    euint64 payout; // encrypted close payout (set by requestClose)
    ebool liquidatable; // encrypted liquidation flag (set by requestLiquidationCheck)
    uint256 markPriceAtRequest; // price snapshot used for the pending close / check
    address keeper; // who requested the liquidation check
  }

  IERC20 public immutable usdg;
  ConfidentialUSDG public immutable cusdg;
  ConfidentialCollateral public immutable collateral;
  AggregatorV3Interface public immutable feed;
  address public immutable owner;

  mapping(uint256 => Position) internal _positions;
  mapping(address => uint256[]) internal _positionsOf;
  uint256 public nextPositionId = 1;
  uint256 public openCount;

  euint64 internal _committedProfit; // encrypted sum of maxProfit across open positions
  mapping(address => bool) public authorised; // routers allowed to open on a trader's behalf (ProtectedPerp)

  event HouseDeposit(address indexed lp, uint256 amount);
  event HouseWithdraw(address indexed to, uint256 amount);
  event PositionOpened(uint256 indexed id, address indexed owner, uint64 leverage, uint256 entryPrice);
  event CloseRequested(uint256 indexed id, uint256 markPrice, euint64 payoutHandle, euint64 collateralHandle);
  event PositionClosed(uint256 indexed id, address indexed owner, uint256 payout, uint256 collateral);
  event LiquidationCheckRequested(uint256 indexed id, address indexed keeper, uint256 markPrice, ebool flagHandle);
  event PositionHealthy(uint256 indexed id);
  event LiquidationConfirmed(uint256 indexed id, euint64 collateralHandle);
  event PositionLiquidated(uint256 indexed id, address indexed keeper, uint256 collateral, uint256 bonus);

  modifier onlyOwner() {
    require(msg.sender == owner, "Perp: not owner");
    _;
  }

  constructor(address usdg_, address cusdg_, address collateral_, address feed_) {
    usdg = IERC20(usdg_);
    cusdg = ConfidentialUSDG(cusdg_);
    collateral = ConfidentialCollateral(collateral_);
    feed = AggregatorV3Interface(feed_);
    owner = msg.sender;
  }

  function authorise(address account, bool ok) external onlyOwner {
    authorised[account] = ok;
  }

  // ── House pool (the counterparty) ───────────────────────────────────────────

  function deposit(uint256 amount) external {
    require(amount > 0, "Perp: zero");
    usdg.safeTransferFrom(msg.sender, address(this), amount);
    emit HouseDeposit(msg.sender, amount);
  }

  /// @notice House liquidity can only leave when no positions are open (their max profit is reserved).
  function withdraw(address to, uint256 amount) external onlyOwner {
    require(openCount == 0, "Perp: positions open");
    usdg.safeTransfer(to, amount);
    emit HouseWithdraw(to, amount);
  }

  function houseLiquidity() public view returns (uint256) {
    return usdg.balanceOf(address(this));
  }

  // ── Oracle ─────────────────────────────────────────────────────────────────

  function markPrice() public view returns (uint256) {
    (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
    require(answer > 0, "Perp: bad price");
    require(block.timestamp - updatedAt < STALENESS, "Perp: stale price");
    return uint256(answer);
  }

  // ── Open ──────────────────────────────────────────────────────────────────

  /// @notice Open a leveraged position. Collateral and direction arrive encrypted; leverage is public.
  ///         Collateral is clamped to the pool's remaining capacity, then locked from the trader's
  ///         encrypted collateral balance.
  function openPosition(
    externalEuint64 encCollateral,
    bytes calldata collateralProof,
    externalEbool encIsLong,
    bytes calldata directionProof,
    uint64 leverage
  ) external returns (uint256 id) {
    euint64 requested = FHE.asEuint64(encCollateral, collateralProof);
    ebool isLong = FHE.asEbool(encIsLong, directionProof);
    id = _open(msg.sender, requested, isLong, leverage);
  }

  /// @notice Open on behalf of `trader` with already-verified ciphertexts (the caller must have granted this
  ///         contract transient access). Used by `ProtectedPerp` to open a perp + its protection atomically.
  function openPositionFor(address trader, euint64 requested, ebool isLong, uint64 leverage)
    external
    returns (uint256 id)
  {
    require(authorised[msg.sender], "Perp: not authorised");
    id = _open(trader, requested, isLong, leverage);
  }

  function _open(address trader, euint64 requested, ebool isLong, uint64 leverage) internal returns (uint256 id) {
    require(leverage >= 1 && leverage <= MAX_LEVERAGE, "Perp: leverage");
    uint256 price = markPrice();
    _initCommitted();

    // capacity clamp: collateral ≤ (pool − reserved) / MAX_PROFIT_MULT
    uint256 pool = houseLiquidity();
    euint64 capE = FHE.asEuint64(pool > type(uint64).max ? type(uint64).max : uint64(pool));
    euint64 zero = FHE.asEuint64(0);
    euint64 room = FHE.select(FHE.gte(capE, _committedProfit), FHE.sub(capE, _committedProfit), zero);
    euint64 maxCollateral = FHE.div(room, FHE.asEuint64(MAX_PROFIT_MULT));
    euint64 want = FHE.min(requested, maxCollateral);

    // lock from the trader's encrypted collateral (also clamped to their free balance)
    FHE.allowTransient(want, address(collateral));
    euint64 locked = collateral.lock(trader, want);

    euint64 size = FHE.mul(locked, FHE.asEuint64(leverage));
    euint64 maxProfit = FHE.mul(locked, FHE.asEuint64(MAX_PROFIT_MULT));
    _committedProfit = FHE.add(_committedProfit, maxProfit);

    FHE.allowThis(locked);
    FHE.allowThis(size);
    FHE.allowThis(isLong);
    FHE.allowThis(maxProfit);
    FHE.allowThis(_committedProfit);
    // the trader can decrypt their own position client-side
    FHE.allow(locked, trader);
    FHE.allow(size, trader);
    FHE.allow(isLong, trader);

    id = nextPositionId++;
    Position storage p = _positions[id];
    p.owner = trader;
    p.leverage = leverage;
    p.entryPrice = price;
    p.openedAt = block.timestamp;
    p.status = Status.Open;
    p.collateral = locked;
    p.size = size;
    p.isLong = isLong;
    p.maxProfit = maxProfit;
    _positionsOf[trader].push(id);
    openCount++;

    emit PositionOpened(id, trader, leverage, price);
  }

  // ── Close (3-step async) ────────────────────────────────────────────────────

  /// @notice Step 1: compute the payout on the ciphertext at the current mark price and mark it (and the
  ///         collateral) publicly decryptable. Decrypt both off-chain, then call `fulfillClose`.
  function requestClose(uint256 id) external {
    Position storage p = _positions[id];
    require(p.owner == msg.sender, "Perp: not owner");
    require(p.status == Status.Open, "Perp: not open");
    uint256 price = markPrice();

    (euint64 gross, euint64 fee) = _grossAndFee(p, price, true);
    euint64 payout = FHE.select(FHE.gte(gross, fee), FHE.sub(gross, fee), FHE.asEuint64(0));

    FHE.allowThis(payout);
    FHE.allowPublic(payout);
    FHE.allowPublic(p.collateral);
    p.payout = payout;
    p.markPriceAtRequest = price;
    p.status = Status.Closing;

    emit CloseRequested(id, price, payout, p.collateral);
  }

  /// @notice Step 3: verify the decrypted payout + collateral, move the trader's collateral into the house
  ///         pool, and pay the trader. Callable by anyone holding valid Teecryptor signatures.
  function fulfillClose(
    uint256 id,
    uint64 payout,
    bytes calldata payoutSig,
    uint64 collateralAmount,
    bytes calldata collateralSig
  ) external {
    Position storage p = _positions[id];
    require(p.status == Status.Closing, "Perp: not closing");
    FHE.publishDecryptResult(p.payout, payout, payoutSig);
    FHE.publishDecryptResult(p.collateral, collateralAmount, collateralSig);

    p.status = Status.Closed;
    openCount--;
    _releaseCommitted(p.maxProfit);

    if (collateralAmount > 0) cusdg.releaseTo(address(this), collateralAmount);
    if (payout > 0) usdg.safeTransfer(p.owner, payout);

    emit PositionClosed(id, p.owner, payout, collateralAmount);
  }

  // ── Liquidation (reveals one bit, then settles) ────────────────────────────

  /// @notice Step 1 (keeper): compute `remaining < maintenance` on the ciphertext and expose only that bit.
  function requestLiquidationCheck(uint256 id) external {
    Position storage p = _positions[id];
    require(p.status == Status.Open, "Perp: not open");
    uint256 price = markPrice();

    (euint64 gross, euint64 fee) = _grossAndFee(p, price, false);
    euint64 remaining = FHE.select(FHE.gte(gross, fee), FHE.sub(gross, fee), FHE.asEuint64(0));
    euint64 maintenance = FHE.div(FHE.mul(p.collateral, FHE.asEuint64(MAINTENANCE_BPS)), FHE.asEuint64(BPS));
    ebool flag = FHE.lt(remaining, maintenance);

    FHE.allowThis(flag);
    FHE.allowPublic(flag);
    p.liquidatable = flag;
    p.markPriceAtRequest = price;
    p.keeper = msg.sender;
    p.status = Status.LiqCheck;

    emit LiquidationCheckRequested(id, msg.sender, price, flag);
  }

  /// @notice Step 2: verify the decrypted flag. Healthy → back to Open (only one bit leaked).
  ///         Liquidatable → expose the collateral for final settlement.
  function resolveLiquidationCheck(uint256 id, bool isLiquidatable, bytes calldata signature) external {
    Position storage p = _positions[id];
    require(p.status == Status.LiqCheck, "Perp: no check");
    FHE.publishDecryptResult(p.liquidatable, isLiquidatable, signature);

    if (!isLiquidatable) {
      p.status = Status.Open;
      emit PositionHealthy(id);
    } else {
      p.status = Status.Liquidating;
      FHE.allowPublic(p.collateral);
      emit LiquidationConfirmed(id, p.collateral);
    }
  }

  /// @notice Step 3: the collateral joins the house pool; the keeper earns a 1% bonus.
  function finalizeLiquidation(uint256 id, uint64 collateralAmount, bytes calldata signature) external {
    Position storage p = _positions[id];
    require(p.status == Status.Liquidating, "Perp: not liquidating");
    FHE.publishDecryptResult(p.collateral, collateralAmount, signature);

    p.status = Status.Closed;
    openCount--;
    _releaseCommitted(p.maxProfit);

    if (collateralAmount > 0) cusdg.releaseTo(address(this), collateralAmount);
    uint256 bonus = (uint256(collateralAmount) * KEEPER_BONUS_BPS) / BPS;
    if (bonus > 0) usdg.safeTransfer(p.keeper, bonus);

    emit PositionLiquidated(id, p.keeper, collateralAmount, bonus);
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  function getPosition(uint256 id) external view returns (Position memory) {
    return _positions[id];
  }

  function positionsOf(address user) external view returns (uint256[] memory) {
    return _positionsOf[user];
  }

  function committedProfit() external view returns (euint64) {
    return _committedProfit;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /// @dev Encrypted gross value (collateral ± PnL) and borrow fee at `price`.
  ///      `capProfit` applies the MAX_PROFIT_MULT cap (used for close; liquidation only cares about losses).
  function _grossAndFee(Position storage p, uint256 price, bool capProfit)
    internal
    returns (euint64 gross, euint64 fee)
  {
    bool up = price > p.entryPrice;
    uint256 delta = up ? price - p.entryPrice : p.entryPrice - price;
    uint256 deltaBps = (delta * BPS) / p.entryPrice;
    if (deltaBps > MAX_DELTA_BPS) deltaBps = MAX_DELTA_BPS;

    // win when direction matches the move (flat price → shorts "win" 0, harmless)
    ebool win = FHE.eq(p.isLong, FHE.asEbool(up));
    euint64 pnl = FHE.div(FHE.mul(p.size, FHE.asEuint64(deltaBps)), FHE.asEuint64(BPS));

    euint64 gain = capProfit ? FHE.min(pnl, p.maxProfit) : pnl;
    euint64 loss = FHE.min(pnl, p.collateral);
    gross = FHE.select(win, FHE.add(p.collateral, gain), FHE.sub(p.collateral, loss));

    uint256 feeBps = ((block.timestamp - p.openedAt) / 1 hours) * BORROW_BPS_PER_HOUR;
    if (feeBps > BPS) feeBps = BPS;
    fee = FHE.div(FHE.mul(p.collateral, FHE.asEuint64(feeBps)), FHE.asEuint64(BPS));
  }

  function _initCommitted() internal {
    if (!FHE.isInitialized(_committedProfit)) {
      _committedProfit = FHE.asEuint64(0);
      FHE.allowThis(_committedProfit);
    }
  }

  function _releaseCommitted(euint64 amount) internal {
    _committedProfit =
      FHE.select(FHE.gte(_committedProfit, amount), FHE.sub(_committedProfit, amount), FHE.asEuint64(0));
    FHE.allowThis(_committedProfit);
  }
}
