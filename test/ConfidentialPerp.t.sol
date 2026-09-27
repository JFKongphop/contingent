// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CofheTest} from "@cofhe/foundry-plugin/contracts/CofheTest.sol";
import {CofheClient} from "@cofhe/foundry-plugin/contracts/CofheClient.sol";
import {euint64, ebool, externalEuint64, externalEbool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";
import {ConfidentialUSDG} from "../src/ConfidentialUSDG.sol";
import {ConfidentialCollateral} from "../src/ConfidentialCollateral.sol";
import {ConfidentialPerp} from "../src/ConfidentialPerp.sol";

/// @dev Encrypted perps: size + direction hidden, house pool as counterparty, one-bit liquidation checks.
contract ConfidentialPerpTest is CofheTest {
  MockUSDG usdg;
  MockAggregatorV3 feed;
  ConfidentialUSDG cusdg;
  ConfidentialCollateral vault;
  ConfidentialPerp perp;

  CofheClient bob;
  address trader;
  address keeper = address(0xBEE9);

  uint256 constant HOUSE = 1_000e6;

  function setUp() public {
    deployMocks();
    bob = createCofheClient();
    bob.connect(0xB0B);
    trader = bob.account();

    usdg = new MockUSDG();
    feed = new MockAggregatorV3(8, 2000e8); // ETH = $2,000
    cusdg = new ConfidentialUSDG(address(usdg));
    vault = new ConfidentialCollateral(address(cusdg));
    perp = new ConfidentialPerp(address(usdg), address(cusdg), address(vault), address(feed));
    cusdg.authorise(address(perp), true); // releaseTo on close
    vault.authorise(address(perp), true); // lock collateral on open

    // house pool (counterparty)
    usdg.mint(address(this), HOUSE);
    usdg.approve(address(perp), type(uint256).max);
    perp.deposit(HOUSE);

    // trader: wrap 300 USDG and deposit it as encrypted collateral
    usdg.mint(trader, 300e6);
    vm.startPrank(trader);
    usdg.approve(address(cusdg), type(uint256).max);
    cusdg.wrap(300e6);
    vm.stopPrank();
    (externalEuint64 h, bytes memory p) = bob.createExternalEuint64(300e6, address(cusdg));
    vm.prank(trader);
    cusdg.confidentialTransferAndCall(address(vault), h, p, "");
  }

  function _open(uint64 collateralAmt, bool isLong, uint64 leverage) internal returns (uint256 id) {
    (externalEuint64 c, bytes memory cp) = bob.createExternalEuint64(collateralAmt, address(perp));
    (externalEbool d, bytes memory dp) = bob.createExternalEbool(isLong, address(perp));
    vm.prank(trader);
    id = perp.openPosition(c, cp, d, dp, leverage);
  }

  function _close(uint256 id) internal returns (uint256 payout) {
    vm.prank(trader);
    perp.requestClose(id);
    ConfidentialPerp.Position memory p = perp.getPosition(id);
    (, uint256 pay, bytes memory paySig) = bob.decryptForTx_withoutACP(euint64.unwrap(p.payout));
    (, uint256 col, bytes memory colSig) = bob.decryptForTx_withoutACP(euint64.unwrap(p.collateral));
    perp.fulfillClose(id, uint64(pay), paySig, uint64(col), colSig);
    return pay;
  }

  function test_open_storesEncryptedPosition() public {
    uint256 id = _open(100e6, true, 5);
    ConfidentialPerp.Position memory p = perp.getPosition(id);
    assertEq(p.owner, trader);
    assertEq(p.leverage, 5);
    assertEq(p.entryPrice, 2000e8);
    expectPlaintext(p.collateral, 100e6);
    expectPlaintext(p.size, 500e6); // 100 × 5x
    expectPlaintext(p.isLong, true);
    vm.prank(trader);
    expectPlaintext(vault.myCollateral(), 200e6); // 300 − 100 locked
  }

  function test_long_priceUp_profit() public {
    uint256 id = _open(100e6, true, 5);
    feed.setAnswer(2200e8); // +10% → PnL = 500 × 10% = 50
    uint256 before = usdg.balanceOf(trader);
    uint256 payout = _close(id);
    assertEq(payout, 150e6);
    assertEq(usdg.balanceOf(trader) - before, 150e6, "trader gets collateral + profit");
    assertEq(perp.houseLiquidity(), HOUSE + 100e6 - 150e6, "house paid the profit");
    assertEq(perp.openCount(), 0);
  }

  function test_short_priceUp_loss() public {
    uint256 id = _open(100e6, false, 5);
    feed.setAnswer(2200e8); // short loses 50
    uint256 payout = _close(id);
    assertEq(payout, 50e6);
    assertEq(perp.houseLiquidity(), HOUSE + 100e6 - 50e6, "house keeps the loss");
  }

  function test_profitIsCapped() public {
    uint256 id = _open(100e6, true, 10); // size 1,000, max profit 500
    feed.setAnswer(4000e8); // +100% → raw PnL 1,000, capped to 500
    assertEq(_close(id), 600e6);
  }

  function test_capacityClamp_limitsCollateral() public {
    // house 1,000 / MAX_PROFIT_MULT 5 → at most 200 collateral can be accepted
    uint256 id = _open(300e6, true, 2);
    expectPlaintext(perp.getPosition(id).collateral, 200e6);
    vm.prank(trader);
    expectPlaintext(vault.myCollateral(), 100e6); // only the accepted 200 was locked
  }

  function test_liquidation_underwaterLong() public {
    uint256 id = _open(100e6, true, 10); // size 1,000
    feed.setAnswer(1808e8); // −9.6% → loss 96, remaining 4 < maintenance 5

    vm.prank(keeper);
    perp.requestLiquidationCheck(id);
    ConfidentialPerp.Position memory p = perp.getPosition(id);
    (, uint256 flag, bytes memory flagSig) = bob.decryptForTx_withoutACP(ebool.unwrap(p.liquidatable));
    assertEq(flag, 1, "liquidatable");
    perp.resolveLiquidationCheck(id, true, flagSig);

    (, uint256 col, bytes memory colSig) = bob.decryptForTx_withoutACP(euint64.unwrap(p.collateral));
    perp.finalizeLiquidation(id, uint64(col), colSig);

    assertEq(usdg.balanceOf(keeper), 1e6, "keeper earns 1% of collateral");
    assertEq(perp.houseLiquidity(), HOUSE + 100e6 - 1e6, "house keeps the rest");
    assertEq(uint8(perp.getPosition(id).status), uint8(ConfidentialPerp.Status.Closed));
  }

  function test_healthyCheck_revealsOnlyOneBit() public {
    uint256 id = _open(100e6, true, 5); // price unchanged → healthy
    vm.prank(keeper);
    perp.requestLiquidationCheck(id);
    ConfidentialPerp.Position memory p = perp.getPosition(id);
    (, uint256 flag, bytes memory flagSig) = bob.decryptForTx_withoutACP(ebool.unwrap(p.liquidatable));
    assertEq(flag, 0, "healthy");
    perp.resolveLiquidationCheck(id, false, flagSig);

    assertEq(uint8(perp.getPosition(id).status), uint8(ConfidentialPerp.Status.Open), "back to open");
    // collateral / size / direction were never made public
    vm.expectRevert();
    bob.decryptForTx_withoutACP(euint64.unwrap(p.collateral));
  }

  function test_onlyOwnerCanClose() public {
    uint256 id = _open(100e6, true, 5);
    vm.prank(keeper);
    vm.expectRevert(bytes("Perp: not owner"));
    perp.requestClose(id);
  }
}
