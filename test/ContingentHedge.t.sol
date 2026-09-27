// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CofheTest} from "@cofhe/foundry-plugin/contracts/CofheTest.sol";
import {CofheClient} from "@cofhe/foundry-plugin/contracts/CofheClient.sol";
import {euint64, externalEuint64, externalEbool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {ConfidentialUSDG} from "../src/ConfidentialUSDG.sol";
import {ConfidentialCollateral} from "../src/ConfidentialCollateral.sol";
import {ConfidentialPositionManager} from "../src/ConfidentialPositionManager.sol";
import {EventMarket} from "../src/EventMarket.sol";
import {UnderwriterVault} from "../src/UnderwriterVault.sol";
import {SettlementRouter} from "../src/SettlementRouter.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {ContingentHedge} from "../src/ContingentHedge.sol";
import {ManualResolver} from "../src/resolvers/ManualResolver.sol";

/// @dev End-to-end with the underwriter vault: LPs deposit USDG (counterparty), a hedger opens an
///      ENCRYPTED hedge priced off public odds, the vault clamps accepted notional to capacity
///      (solvency), and settlement pays the winner from the vault via async decrypt.
contract ContingentHedgeTest is CofheTest {
  MockUSDG usdg;
  ConfidentialUSDG cusdg;
  ConfidentialCollateral collateralVault;
  ConfidentialPositionManager pm;
  EventMarket market;
  UnderwriterVault vault;
  SettlementRouter router;
  PositionNFT nft;
  ContingentHedge hedge;
  ManualResolver resolver;

  CofheClient bob;
  address user;
  address attestor = address(0xA77E);

  bytes32 constant EVENT_ID = keccak256("USDC depeg < $0.97 by X");
  uint256 constant CAPACITY = 1_000e6;

  function setUp() public {
    deployMocks();
    bob = createCofheClient();
    bob.connect(0xB0B);
    user = bob.account();

    usdg = new MockUSDG();
    cusdg = new ConfidentialUSDG(address(usdg));
    collateralVault = new ConfidentialCollateral(address(cusdg));
    pm = new ConfidentialPositionManager();
    market = new EventMarket();
    resolver = new ManualResolver(attestor);
    vault = new UnderwriterVault(address(usdg));
    router = new SettlementRouter(address(vault));
    nft = new PositionNFT();
    hedge = new ContingentHedge(
      address(market),
      address(collateralVault),
      address(pm),
      address(cusdg),
      address(vault),
      address(nft),
      address(router)
    );

    // authorisations
    cusdg.authorise(address(hedge), true); // premium sweep releaseTo
    collateralVault.authorise(address(hedge), true);
    pm.authorise(address(hedge), true);
    vault.authorise(address(hedge), true); // reserveLiability / collectPremium / sweep / finalise
    vault.authorise(address(router), true); // payWinner / fund
    router.authorise(address(hedge), true);
    nft.authorise(address(hedge), true); // mint / burn positions

    // market: YES 40 / NO 60 -> p = 40%
    market.createMarket(EVENT_ID, address(resolver), uint64(block.timestamp + 7 days), 40, 60);

    // LP funds the vault reserve and earmarks capacity for the event
    usdg.mint(address(this), CAPACITY);
    usdg.approve(address(vault), type(uint256).max);
    vault.deposit(CAPACITY);
    vault.earmark(EVENT_ID, CAPACITY);

    // hedger wraps + deposits confidential collateral
    usdg.mint(user, 200e6);
    vm.prank(user);
    usdg.approve(address(cusdg), type(uint256).max);
    vm.prank(user);
    cusdg.wrap(200e6);
    (externalEuint64 dh, bytes memory dp) = bob.createExternalEuint64(200e6, address(cusdg));
    vm.prank(user);
    cusdg.confidentialTransferAndCall(address(collateralVault), dh, dp, "");
  }

  function _openYes(uint64 notional) internal returns (uint256 id) {
    (externalEuint64 s, bytes memory sp) = bob.createExternalEuint64(notional, address(hedge));
    (externalEbool d, bytes memory dp) = bob.createExternalEbool(true, address(hedge));
    vm.prank(user);
    id = hedge.openHedge(EVENT_ID, s, sp, d, dp);
  }

  function _resolveYes(bool yes) internal {
    vm.prank(attestor);
    resolver.report(EVENT_ID, yes);
    market.resolve(EVENT_ID);
  }

  function _settle(uint256 id) internal {
    hedge.requestSettlement(id);
    euint64 h = hedge.payoutHandle(id);
    (, uint256 val, bytes memory sig) = bob.decryptForTx_withoutACP(euint64.unwrap(h));
    hedge.fulfillSettlement(id, uint64(val), sig);
  }

  function test_openHedge_locksPremium_andReserves() public {
    uint256 id = _openYes(100e6); // p=40% -> premium 40, free collateral 160
    vm.prank(user);
    expectPlaintext(collateralVault.myCollateral(), 160e6);

    ConfidentialPositionManager.EventPosition memory p = pm.get(id);
    expectPlaintext(p.size, 100e6); // accepted == requested (within capacity)
    expectPlaintext(p.premium, 40e6);
    expectPlaintext(vault.committedYes(EVENT_ID), 100e6); // vault liability reserved
  }

  function _depositMore(uint64 amount) internal {
    usdg.mint(user, amount);
    vm.prank(user);
    cusdg.wrap(amount);
    (externalEuint64 h, bytes memory p) = bob.createExternalEuint64(amount, address(cusdg));
    vm.prank(user);
    cusdg.confidentialTransferAndCall(address(collateralVault), h, p, "");
  }

  function test_solvencyClamp_capsAcceptedAtCapacity() public {
    // enough collateral (1,200) so capacity is the binding limit:
    // request 1,500 → premium 600 locked → capacity clamps cover to 1,000 → premium 400, refund 200
    _depositMore(1_000e6);
    uint256 id = _openYes(1_500e6);

    ConfidentialPositionManager.EventPosition memory p = pm.get(id);
    expectPlaintext(p.size, 1_000e6); // clamped to capacity — never oversell cover
    expectPlaintext(p.premium, 400e6); // charged only for the accepted cover
    expectPlaintext(vault.committedYes(EVENT_ID), 1_000e6);
    vm.prank(user);
    expectPlaintext(collateralVault.myCollateral(), 800e6); // 1,200 − 400 (excess 200 refunded)
  }

  function test_shortCollateral_scalesCoverDown() public {
    // 200 free collateral, request 1,000 YES @ 40% (premium 400) → can only afford 500 of cover
    uint256 id = _openYes(1_000e6);
    ConfidentialPositionManager.EventPosition memory p = pm.get(id);
    expectPlaintext(p.size, 500e6);
    expectPlaintext(p.premium, 200e6);
    expectPlaintext(vault.committedYes(EVENT_ID), 500e6);
    vm.prank(user);
    expectPlaintext(collateralVault.myCollateral(), 0);
  }

  function test_noCollateral_noFreeCover() public {
    _openYes(1_000e6); // uses all 200 collateral
    uint256 id = _openYes(100e6); // nothing left to pay with
    ConfidentialPositionManager.EventPosition memory p = pm.get(id);
    expectPlaintext(p.size, 0); // no free protection
    expectPlaintext(p.premium, 0);
    expectPlaintext(vault.committedYes(EVENT_ID), 500e6); // unchanged by the unpaid request
  }

  function test_win_paysFromVault() public {
    uint256 id = _openYes(100e6);
    uint256 reserveBefore = vault.totalReserve();
    _resolveYes(true);

    uint256 balBefore = usdg.balanceOf(user);
    _settle(id);

    assertEq(usdg.balanceOf(user) - balBefore, 100e6, "winner paid notional");
    assertEq(reserveBefore - vault.totalReserve(), 100e6, "paid from vault reserve");
    assertTrue(hedge.paid(id));
  }

  function test_lose_paysZero() public {
    uint256 id = _openYes(100e6);
    _resolveYes(false); // event did not happen -> YES hedge loses

    uint256 balBefore = usdg.balanceOf(user);
    _settle(id);
    assertEq(usdg.balanceOf(user), balBefore, "nothing paid");
  }

  function test_premiumSweep_creditsLPs() public {
    uint256 id = _openYes(100e6); // premium 40
    _resolveYes(false); // loser -> premium is pure LP yield
    _settle(id);

    uint256 reserveBefore = vault.totalReserve();
    uint256 cusdgBefore = usdg.balanceOf(address(cusdg));

    euint64 poolH = hedge.requestPremiumSweep(EVENT_ID);
    (, uint256 total, bytes memory sig) = bob.decryptForTx_withoutACP(euint64.unwrap(poolH));
    assertEq(total, 40e6, "aggregate premium");
    hedge.sweepPremiums(EVENT_ID, uint64(total), sig);

    assertEq(vault.totalReserve() - reserveBefore, 40e6, "premium booked as LP yield");
    assertEq(cusdgBefore - usdg.balanceOf(address(cusdg)), 40e6, "USDG moved from collateral pool to vault");
  }

  function test_closeHedge_refundsAndReleases() public {
    uint256 id = _openYes(100e6); // premium 40 locked, committedYes 100, free collateral 160
    vm.prank(user);
    expectPlaintext(collateralVault.myCollateral(), 160e6);

    vm.prank(user);
    hedge.closeHedge(id);

    vm.prank(user);
    expectPlaintext(collateralVault.myCollateral(), 200e6); // premium refunded
    expectPlaintext(vault.committedYes(EVENT_ID), 0); // liability released
  }

  function test_closeHedge_onlyHolder() public {
    uint256 id = _openYes(100e6);
    vm.prank(attestor);
    vm.expectRevert(bytes("Hedge: not holder"));
    hedge.closeHedge(id);
  }

  function test_nft_transfersThePayout() public {
    address alice = address(0xA11CE);
    uint256 id = _openYes(100e6);
    assertEq(nft.ownerOf(id), user);

    // sell/transfer the hedge to alice (a private payoff changes hands, exposure never revealed)
    vm.prank(user);
    nft.transferFrom(user, alice, id);
    assertEq(nft.ownerOf(id), alice);

    _resolveYes(true);
    uint256 aliceBefore = usdg.balanceOf(alice);
    uint256 userBefore = usdg.balanceOf(user);
    _settle(id);

    assertEq(usdg.balanceOf(alice) - aliceBefore, 100e6, "current holder is paid");
    assertEq(usdg.balanceOf(user), userBefore, "original opener is not paid");
  }

  function test_finalise_releasesCapacity() public {
    uint256 id = _openYes(100e6);
    _resolveYes(true);
    _settle(id);
    assertEq(vault.earmarked(), CAPACITY);
    hedge.finaliseEvent(EVENT_ID);
    assertEq(vault.earmarked(), 0, "capacity released after settlement");
    assertGt(vault.freeReserve(), 0);
  }
}
