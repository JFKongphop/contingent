// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager, SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {MockERC20} from "../src/mocks/MockERC20.sol";
import {EventMarket} from "../src/EventMarket.sol";
import {EventHook} from "../src/EventHook.sol";
import {ManualResolver} from "../src/resolvers/ManualResolver.sol";

/// @dev Real v4 integration: a pool with the EventHook. Swaps succeed while the event is open, and
///      the settlement guard reverts them once the event resolves (odds frozen for settlement).
contract EventHookTest is Test {
  uint160 constant SQRT_PRICE_1_1 = 79_228_162_514_264_337_593_543_950_336;

  PoolManager manager;
  PoolModifyLiquidityTest lp;
  PoolSwapTest swapper;
  EventHook hook;
  EventMarket market;
  ManualResolver resolver;
  MockERC20 token0;
  MockERC20 token1;
  PoolKey key;

  address attestor = address(0xA77E);
  bytes32 constant EVENT_ID = keccak256("ETH > $5000 by X");

  function setUp() public {
    manager = new PoolManager(address(this));
    lp = new PoolModifyLiquidityTest(manager);
    swapper = new PoolSwapTest(manager);

    market = new EventMarket();
    resolver = new ManualResolver(attestor);
    market.createMarket(EVENT_ID, address(resolver), uint64(block.timestamp + 7 days), 50, 50);

    uint160 flags =
      uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
    address hookAddr = address(flags);
    deployCodeTo("EventHook.sol:EventHook", abi.encode(manager, address(market)), hookAddr);
    hook = EventHook(hookAddr);

    MockERC20 a = new MockERC20("YES", "YES");
    MockERC20 b = new MockERC20("NO", "NO");
    (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
    token0.mint(address(this), 1e24);
    token1.mint(address(this), 1e24);
    token0.approve(address(lp), type(uint256).max);
    token1.approve(address(lp), type(uint256).max);
    token0.approve(address(swapper), type(uint256).max);
    token1.approve(address(swapper), type(uint256).max);

    key = PoolKey({
      currency0: Currency.wrap(address(token0)),
      currency1: Currency.wrap(address(token1)),
      fee: 3000,
      tickSpacing: 60,
      hooks: IHooks(hookAddr)
    });
    manager.initialize(key, SQRT_PRICE_1_1);
    hook.bindPool(key, EVENT_ID);

    lp.modifyLiquidity(key, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e21, salt: 0}), "");
  }

  function test_permissions_valid() public view {
    Hooks.Permissions memory p = hook.getHookPermissions();
    assertTrue(p.beforeAddLiquidity && p.beforeSwap && p.afterSwap);
    assertEq(hook.eventOf(key.toId()), EVENT_ID);
  }

  function test_swap_allowed_whileOpen() public {
    _swap();
    // no revert; hook observed the odds after the swap
  }

  function test_swap_blocked_afterResolve() public {
    vm.prank(attestor);
    resolver.report(EVENT_ID, true);
    market.resolve(EVENT_ID);

    vm.expectRevert(); // wraps EventHook.MarketClosedForTrading inside the pool manager
    _swap();
  }

  function _swap() internal {
    swapper.swap(
      key,
      SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: SQRT_PRICE_1_1 - 1e18}),
      PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
      ""
    );
  }
}
