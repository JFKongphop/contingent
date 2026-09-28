// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager, SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {EventMarket} from "./EventMarket.sol";

/// @title EventHook - the Uniswap v4 guard on Contingent's public odds pool
/// @notice When the odds market is a v4 pool (YES/NO outcome tokens whose price is the implied
///         probability), this hook enforces the two rules the confidential layer relies on:
///           1. **Settlement guard** — once the event resolves, the odds are frozen: no more swaps or
///              liquidity changes, so nobody trades stale odds while payouts are computed/decrypted.
///           2. **Batch / close window** — trading is only allowed while the market is open for
///              hedging (before `closeTime`), which is the anti-front-running batch boundary.
///         It also surfaces the live probability after each trade for off-chain price discovery.
///
///         The hook is intentionally on the PUBLIC layer only — it never touches encrypted values.
///         Hedgers price their confidential positions OFF the probability this pool discovers.
/// @dev Deploy to a CREATE2 address whose low bits match `getHookPermissions()` (use HookMiner).
contract EventHook is BaseHook {
  using PoolIdLibrary for PoolKey;
  using StateLibrary for IPoolManager;

  EventMarket public immutable market;
  address public immutable owner;

  /// @dev pool => the event whose odds it trades (bytes32(0) = not a Contingent odds pool)
  mapping(PoolId => bytes32) public eventOf;

  event PoolBound(PoolId indexed pool, bytes32 indexed eventId);
  event OddsObserved(PoolId indexed pool, bytes32 indexed eventId, uint256 probYesBps);

  error MarketClosedForTrading();

  constructor(IPoolManager _poolManager, address market_) BaseHook(_poolManager) {
    market = EventMarket(market_);
    owner = msg.sender;
  }

  function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
    return Hooks.Permissions({
      beforeInitialize: false,
      afterInitialize: false,
      beforeAddLiquidity: true, // freeze liquidity once resolved / closed
      afterAddLiquidity: false,
      beforeRemoveLiquidity: false, // LPs may always exit
      afterRemoveLiquidity: false,
      beforeSwap: true, // settlement guard + batch window
      afterSwap: true, // publish updated odds
      beforeDonate: false,
      afterDonate: false,
      beforeSwapReturnDelta: false,
      afterSwapReturnDelta: false,
      afterAddLiquidityReturnDelta: false,
      afterRemoveLiquidityReturnDelta: false
    });
  }

  /// @notice Bind a pool to a Contingent event so the guard applies. Owner-only.
  function bindPool(PoolKey calldata key, bytes32 eventId) external {
    require(msg.sender == owner, "EventHook: not owner");
    PoolId id = key.toId();
    eventOf[id] = eventId;
    emit PoolBound(id, eventId);
  }

  // ── v4 callbacks ───────────────────────────────────────────────────────────

  function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
    internal
    view
    override
    returns (bytes4, BeforeSwapDelta, uint24)
  {
    _requireOpen(key);
    return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
  }

  function _beforeAddLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
    internal
    view
    override
    returns (bytes4)
  {
    _requireOpen(key);
    return BaseHook.beforeAddLiquidity.selector;
  }

  function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
    internal
    override
    returns (bytes4, int128)
  {
    PoolId id = key.toId();
    bytes32 eventId = eventOf[id];
    if (eventId != bytes32(0)) {
      emit OddsObserved(id, eventId, market.probYesBps(eventId));
    }
    return (BaseHook.afterSwap.selector, 0);
  }

  // ── Internal guard ──────────────────────────────────────────────────────────

  /// @dev Reverts if the pool is bound to an event that is resolved or past its close time.
  function _requireOpen(PoolKey calldata key) internal view {
    bytes32 eventId = eventOf[key.toId()];
    if (eventId != bytes32(0) && !market.isOpenForHedging(eventId)) {
      revert MarketClosedForTrading();
    }
  }
}
