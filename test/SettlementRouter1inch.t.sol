// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAquaSource, MockOneInchRouter} from "../src/mocks/Mock1inch.sol";
import {UnderwriterVault} from "../src/UnderwriterVault.sol";
import {SettlementRouter} from "../src/SettlementRouter.sol";

/// @dev The 1inch settlement liquidity paths: the router refills the underwriter vault reserve either
///      from Aqua shared liquidity or by swapping a reserve asset via the 1inch aggregation router.
contract SettlementRouter1inchTest is Test {
  MockUSDG usdg;
  UnderwriterVault vault;
  SettlementRouter router;
  MockAquaSource aqua;
  MockOneInchRouter oneInch;
  MockERC20 reserveAsset;

  function setUp() public {
    usdg = new MockUSDG();
    vault = new UnderwriterVault(address(usdg));
    router = new SettlementRouter(address(vault));
    vault.authorise(address(router), true);

    aqua = new MockAquaSource(address(usdg));
    oneInch = new MockOneInchRouter();
    reserveAsset = new MockERC20("Reserve", "RSV");

    usdg.mint(address(aqua), 1_000e6); // aqua shared liquidity
    usdg.mint(address(oneInch), 1_000e6); // 1inch router USDG liquidity
    reserveAsset.mint(address(router), 500e18); // router holds a reserve asset to swap

    router.configureRouting(address(oneInch), address(aqua), address(reserveAsset));
  }

  function test_topUpFromAqua() public {
    uint256 before = vault.totalReserve();
    uint256 funded = router.topUpFromAqua(300e6);
    assertEq(funded, 300e6);
    assertEq(vault.totalReserve() - before, 300e6, "vault reserve refilled from Aqua");
    assertEq(usdg.balanceOf(address(aqua)), 700e6);
  }

  function test_topUpViaSwap() public {
    uint256 before = vault.totalReserve();
    uint256 funded = router.topUpViaSwap(200e6, 200e6, ""); // mock returns srcAmount as USDG (1:1)
    assertEq(funded, 200e6);
    assertEq(vault.totalReserve() - before, 200e6, "vault reserve refilled via 1inch swap");
  }

  function test_topUp_unauthorised_reverts() public {
    vm.prank(address(0xBAD));
    vm.expectRevert(bytes("Router: not authorised"));
    router.topUpFromAqua(100e6);
  }
}
