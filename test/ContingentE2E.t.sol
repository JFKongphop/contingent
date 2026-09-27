// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CofheTest} from "@cofhe/foundry-plugin/contracts/CofheTest.sol";
import {CofheClient} from "@cofhe/foundry-plugin/contracts/CofheClient.sol";
import {euint64, externalEuint64, externalEbool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";
import {ConfidentialUSDG} from "../src/ConfidentialUSDG.sol";
import {ConfidentialCollateral} from "../src/ConfidentialCollateral.sol";
import {ConfidentialPositionManager} from "../src/ConfidentialPositionManager.sol";
import {EventMarket} from "../src/EventMarket.sol";
import {UnderwriterVault} from "../src/UnderwriterVault.sol";
import {SettlementRouter} from "../src/SettlementRouter.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {ContingentHedge} from "../src/ContingentHedge.sol";
import {PriceThresholdResolver} from "../src/resolvers/PriceThresholdResolver.sol";

/// @title ContingentE2E - the complete lifecycle in one flow
/// @notice Real Chainlink-style resolver, an LP underwriting, TWO hedgers on opposite sides, a depeg
///         that auto-resolves, settlement of a winner and a loser, aggregate premium sweep, event
///         finalisation, and LP withdrawal — with exact end-to-end accounting conservation.
///
///         Scenario (odds p = 4%):
///           • LP deposits 1,000 USDG and earmarks it as capacity.
///           • Alice buys 400 of YES protection (bets the depeg happens).  premium = 400*4%   = 16
///           • Bob   buys 200 of NO           (bets it doesn't).           premium = 200*96%  = 192
///           • USDC depegs -> resolver latches YES.
///           • Alice WINS: paid 400 from the vault. Bob LOSES: paid 0.
///           • Premiums (16 + 192 = 208) swept to LPs. Reserve = 1000 - 400 + 208 = 808.
contract ContingentE2ETest is CofheTest {
  MockUSDG usdg;
  MockAggregatorV3 feed;
  ConfidentialUSDG cusdg;
  ConfidentialCollateral collateralVault;
  ConfidentialPositionManager pm;
  EventMarket market;
  UnderwriterVault vault;
  SettlementRouter router;
  PositionNFT nft;
  ContingentHedge hedge;
  PriceThresholdResolver resolver;

  CofheClient aliceC;
  CofheClient bobC;
  address alice;
  address bob;

  bytes32 constant EVENT_ID = keccak256("USDC < $0.97 by X");
  uint256 constant CAP = 1_000e6;

  function setUp() public {
    deployMocks();
    aliceC = createCofheClient();
    aliceC.connect(0xA11CE);
    alice = aliceC.account();
    bobC = createCofheClient();
    bobC.connect(0xB0B);
    bob = bobC.account();

    // stack
    usdg = new MockUSDG();
    feed = new MockAggregatorV3(8, 1_00_000_000); // USDC = $1.00
    cusdg = new ConfidentialUSDG(address(usdg));
    collateralVault = new ConfidentialCollateral(address(cusdg));
    pm = new ConfidentialPositionManager();
    market = new EventMarket();
    vault = new UnderwriterVault(address(usdg));
    router = new SettlementRouter(address(vault));
    nft = new PositionNFT();
    resolver = new PriceThresholdResolver();
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
    cusdg.authorise(address(hedge), true);
    collateralVault.authorise(address(hedge), true);
    pm.authorise(address(hedge), true);
    vault.authorise(address(hedge), true);
    vault.authorise(address(router), true);
    router.authorise(address(hedge), true);
    nft.authorise(address(hedge), true);

    // event: YES if USDC <= $0.97, 30-day deadline; market odds p = 4% (seed 4 / 96)
    uint64 closeTime = uint64(block.timestamp + 30 days);
    resolver.register(EVENT_ID, address(feed), 97_000_000, true, closeTime);
    market.createMarket(EVENT_ID, address(resolver), closeTime, 4, 96);

    // LP funds the vault and earmarks capacity
    usdg.mint(address(this), CAP);
    usdg.approve(address(vault), type(uint256).max);
    vault.deposit(CAP);
    vault.earmark(EVENT_ID, CAP);

    _fund(aliceC, alice, 200e6);
    _fund(bobC, bob, 200e6);
  }

  function _fund(CofheClient c, address who, uint64 amount) internal {
    usdg.mint(who, amount);
    vm.prank(who);
    usdg.approve(address(cusdg), type(uint256).max);
    vm.prank(who);
    cusdg.wrap(amount);
    (externalEuint64 h, bytes memory p) = c.createExternalEuint64(amount, address(cusdg));
    vm.prank(who);
    cusdg.confidentialTransferAndCall(address(collateralVault), h, p, "");
  }

  function _open(CofheClient c, address who, uint64 notional, bool yes) internal returns (uint256 id) {
    (externalEuint64 s, bytes memory sp) = c.createExternalEuint64(notional, address(hedge));
    (externalEbool d, bytes memory dp) = c.createExternalEbool(yes, address(hedge));
    vm.prank(who);
    id = hedge.openHedge(EVENT_ID, s, sp, d, dp);
  }

  function _settle(uint256 id) internal {
    hedge.requestSettlement(id);
    euint64 h = hedge.payoutHandle(id);
    (, uint256 val, bytes memory sig) = aliceC.decryptForTx_withoutACP(euint64.unwrap(h));
    hedge.fulfillSettlement(id, uint64(val), sig);
  }

  function test_fullLifecycle_depegPaysTheHedger() public {
    // ── open two opposite hedges (sizes + sides encrypted) ──
    uint256 aliceId = _open(aliceC, alice, 400e6, true); // YES: bets the depeg happens
    uint256 bobId = _open(bobC, bob, 200e6, false); // NO: bets it doesn't

    expectPlaintext(vault.committedYes(EVENT_ID), 400e6);
    expectPlaintext(vault.committedNo(EVENT_ID), 200e6);
    expectPlaintext(pm.get(aliceId).premium, 16e6); // 400 * 4%
    expectPlaintext(pm.get(bobId).premium, 192e6); // 200 * 96%

    // ── the depeg happens; the resolver latches YES automatically ──
    feed.setAnswer(95_000_000); // USDC = $0.95
    market.resolve(EVENT_ID);
    (bool resolved, bool yes) = market.isResolved(EVENT_ID);
    assertTrue(resolved && yes, "event resolved YES");

    uint256 reserveStart = vault.totalReserve(); // 1000

    // ── settle both: Alice (YES) wins, Bob (NO) loses ──
    uint256 aliceBefore = usdg.balanceOf(alice);
    uint256 bobBefore = usdg.balanceOf(bob);
    _settle(aliceId);
    _settle(bobId);

    assertEq(usdg.balanceOf(alice) - aliceBefore, 400e6, "Alice's hedge paid the full notional");
    assertEq(usdg.balanceOf(bob) - bobBefore, 0, "Bob's losing side pays nothing");
    assertEq(reserveStart - vault.totalReserve(), 400e6, "payout came from the LP reserve");

    // ── aggregate premium sweep -> LP yield (only the total is revealed) ──
    euint64 poolH = hedge.requestPremiumSweep(EVENT_ID);
    (, uint256 totalPrem, bytes memory sig) = aliceC.decryptForTx_withoutACP(euint64.unwrap(poolH));
    assertEq(totalPrem, 208e6, "aggregate premium = 16 + 192");
    hedge.sweepPremiums(EVENT_ID, uint64(totalPrem), sig);

    // ── accounting conservation: reserve = start - payouts + premiums ──
    assertEq(vault.totalReserve(), reserveStart - 400e6 + 208e6, "reserve conserved exactly"); // 808

    // ── finalise the event, LP withdraws the free reserve ──
    hedge.finaliseEvent(EVENT_ID);
    assertEq(vault.earmarked(), 0, "capacity released");

    uint256 lpBefore = usdg.balanceOf(address(this));
    vault.withdraw(vault.sharesOf(address(this)));
    assertEq(usdg.balanceOf(address(this)) - lpBefore, 808e6, "LP redeems the full net reserve");
  }

  /// @dev The mirror: no depeg by the deadline -> the resolver latches NO, both YES hedgers lose
  ///      their premium, and the LP keeps it as pure yield (share price rises).
  function test_fullLifecycle_noDepeg_LPsProfit() public {
    uint256 aliceId = _open(aliceC, alice, 400e6, true); // YES 400 -> premium 16
    uint256 bobId = _open(bobC, bob, 200e6, true); // YES 200 -> premium 8

    uint256 priceStart = vault.sharePriceWad();

    // no depeg; the deadline passes with USDC still pegged -> resolver returns NO
    vm.warp(block.timestamp + 31 days);
    feed.setAnswer(1_00_000_000); // still $1.00, refresh updatedAt so the feed isn't stale
    market.resolve(EVENT_ID);
    (bool resolved, bool yes) = market.isResolved(EVENT_ID);
    assertTrue(resolved && !yes, "event resolved NO");

    uint256 reserveStart = vault.totalReserve(); // 1000

    // both YES hedges lose -> zero payout
    uint256 aliceBefore = usdg.balanceOf(alice);
    _settle(aliceId);
    _settle(bobId);
    assertEq(usdg.balanceOf(alice) - aliceBefore, 0, "no payout on a losing hedge");
    assertEq(vault.totalReserve(), reserveStart, "no payouts drawn from the reserve");

    // premiums (16 + 8 = 24) are pure LP yield
    euint64 poolH = hedge.requestPremiumSweep(EVENT_ID);
    (, uint256 totalPrem, bytes memory sig) = aliceC.decryptForTx_withoutACP(euint64.unwrap(poolH));
    assertEq(totalPrem, 24e6, "aggregate premium");
    hedge.sweepPremiums(EVENT_ID, uint64(totalPrem), sig);

    assertEq(vault.totalReserve(), reserveStart + 24e6, "premiums booked as LP yield");
    assertGt(vault.sharePriceWad(), priceStart, "LP share price rose");

    hedge.finaliseEvent(EVENT_ID);
    uint256 lpBefore = usdg.balanceOf(address(this));
    vault.withdraw(vault.sharesOf(address(this)));
    assertEq(usdg.balanceOf(address(this)) - lpBefore, 1_024e6, "LP redeems principal + premium yield");
  }
}
