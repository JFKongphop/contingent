// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CofheTest} from "@cofhe/foundry-plugin/contracts/CofheTest.sol";
import {CofheClient} from "@cofhe/foundry-plugin/contracts/CofheClient.sol";
import {euint64, ebool, externalEuint64, externalEbool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

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
import {ConfidentialPerp} from "../src/ConfidentialPerp.sol";
import {ProtectedPerp} from "../src/ProtectedPerp.sol";
import {ManualResolver} from "../src/resolvers/ManualResolver.sol";

/// @dev One transaction opens an encrypted perp + its opposite-side event hedge; direction stays hidden.
contract ProtectedPerpTest is CofheTest {
  MockUSDG usdg;
  MockAggregatorV3 feed;
  ConfidentialUSDG cusdg;
  ConfidentialCollateral collateral;
  ConfidentialPositionManager pm;
  EventMarket market;
  UnderwriterVault vault;
  SettlementRouter router;
  PositionNFT nft;
  ContingentHedge hedge;
  ConfidentialPerp perp;
  ProtectedPerp protected;
  ManualResolver resolver;

  CofheClient bob;
  address trader;
  address attestor = address(0xA77E);

  bytes32 constant EVENT_ID = keccak256("ETH >= $2,000");

  function setUp() public {
    deployMocks();
    bob = createCofheClient();
    bob.connect(0xB0B);
    trader = bob.account();

    usdg = new MockUSDG();
    feed = new MockAggregatorV3(8, 2000e8);
    cusdg = new ConfidentialUSDG(address(usdg));
    collateral = new ConfidentialCollateral(address(cusdg));
    pm = new ConfidentialPositionManager();
    market = new EventMarket();
    resolver = new ManualResolver(attestor);
    vault = new UnderwriterVault(address(usdg));
    router = new SettlementRouter(address(vault));
    nft = new PositionNFT();
    hedge = new ContingentHedge(
      address(market), address(collateral), address(pm), address(cusdg), address(vault), address(nft), address(router)
    );
    perp = new ConfidentialPerp(address(usdg), address(cusdg), address(collateral), address(feed));
    protected = new ProtectedPerp(address(perp), address(hedge), EVENT_ID);

    cusdg.authorise(address(hedge), true);
    collateral.authorise(address(hedge), true);
    pm.authorise(address(hedge), true);
    vault.authorise(address(hedge), true);
    vault.authorise(address(router), true);
    router.authorise(address(hedge), true);
    nft.authorise(address(hedge), true);
    cusdg.authorise(address(perp), true);
    collateral.authorise(address(perp), true);
    perp.authorise(address(protected), true);
    hedge.authorise(address(protected), true);

    // event market: YES 40 / NO 60 → p(YES) = 40%, NO costs 60%
    market.createMarket(EVENT_ID, address(resolver), uint64(block.timestamp + 7 days), 40, 60);
    usdg.mint(address(this), 2_000e6);
    usdg.approve(address(vault), type(uint256).max);
    vault.deposit(1_000e6);
    vault.earmark(EVENT_ID, 1_000e6);
    usdg.approve(address(perp), type(uint256).max);
    perp.deposit(1_000e6);

    // trader: 300 encrypted collateral
    usdg.mint(trader, 300e6);
    vm.startPrank(trader);
    usdg.approve(address(cusdg), type(uint256).max);
    cusdg.wrap(300e6);
    vm.stopPrank();
    (externalEuint64 h, bytes memory p) = bob.createExternalEuint64(300e6, address(cusdg));
    vm.prank(trader);
    cusdg.confidentialTransferAndCall(address(collateral), h, p, "");
  }

  function _openProtected(uint64 c, bool isLong, uint64 lev, uint64 cover) internal returns (uint256, uint256) {
    (externalEuint64 ec, bytes memory cp) = bob.createExternalEuint64(c, address(protected));
    (externalEbool ed, bytes memory dp) = bob.createExternalEbool(isLong, address(protected));
    (externalEuint64 ev, bytes memory vp) = bob.createExternalEuint64(cover, address(protected));
    vm.prank(trader);
    return protected.openProtected(ec, cp, ed, dp, lev, ev, vp);
  }

  function test_long_isProtectedByNo() public {
    (uint256 perpId, uint256 hedgeId) = _openProtected(100e6, true, 5, 100e6);

    ConfidentialPerp.Position memory p = perp.getPosition(perpId);
    assertEq(p.owner, trader, "trader owns the perp");
    expectPlaintext(p.collateral, 100e6);
    expectPlaintext(p.isLong, true);

    ConfidentialPositionManager.EventPosition memory h = pm.get(hedgeId);
    assertEq(nft.ownerOf(hedgeId), trader, "trader owns the protection");
    expectPlaintext(h.size, 100e6);
    expectPlaintext(h.isYes, false); // long → NO
    expectPlaintext(h.premium, 60e6); // NO @ 60%

    assertEq(protected.protectionOf(perpId), hedgeId, "link recorded on-chain");
    vm.prank(trader);
    expectPlaintext(collateral.myCollateral(), 140e6); // 300 − 100 perp − 60 premium
  }

  function test_short_isProtectedByYes() public {
    (, uint256 hedgeId) = _openProtected(100e6, false, 3, 100e6);
    ConfidentialPositionManager.EventPosition memory h = pm.get(hedgeId);
    expectPlaintext(h.isYes, true); // short → YES
    expectPlaintext(h.premium, 40e6); // YES @ 40%
  }

  function test_crash_protectionPaysOut() public {
    (uint256 perpId, uint256 hedgeId) = _openProtected(100e6, true, 5, 100e6);

    // ETH falls 10%: 5x long loses 50 of its 100 collateral
    feed.setAnswer(1800e8);
    vm.prank(trader);
    perp.requestClose(perpId);
    ConfidentialPerp.Position memory p = perp.getPosition(perpId);
    (, uint256 pay, bytes memory paySig) = bob.decryptForTx_withoutACP(euint64.unwrap(p.payout));
    (, uint256 col, bytes memory colSig) = bob.decryptForTx_withoutACP(euint64.unwrap(p.collateral));
    perp.fulfillClose(perpId, uint64(pay), paySig, uint64(col), colSig);
    assertEq(pay, 50e6, "perp alone: -50");

    // event resolves NO (ETH below strike) → protection pays its full cover
    vm.prank(attestor);
    resolver.report(EVENT_ID, false);
    market.resolve(EVENT_ID);
    uint256 before = usdg.balanceOf(trader);
    hedge.requestSettlement(hedgeId);
    (, uint256 hp, bytes memory hs) = bob.decryptForTx_withoutACP(euint64.unwrap(hedge.payoutHandle(hedgeId)));
    hedge.fulfillSettlement(hedgeId, uint64(hp), hs);
    assertEq(usdg.balanceOf(trader) - before, 100e6, "protection pays 100");
    // net: 50 (perp) + 100 (cover) − 100 collateral − 60 premium = −10, vs −50 unprotected
  }

  function test_trader_closesBothLegsDirectly() public {
    (uint256 perpId, uint256 hedgeId) = _openProtected(100e6, true, 5, 100e6);
    vm.startPrank(trader);
    hedge.closeHedge(hedgeId); // premium refunded
    perp.requestClose(perpId);
    vm.stopPrank();
    vm.prank(trader);
    expectPlaintext(collateral.myCollateral(), 200e6); // 300 − 100 still in the closing perp
  }

  function test_forEntryPoints_onlyAuthorised() public {
    vm.expectRevert(bytes("Perp: not authorised"));
    perp.openPositionFor(trader, euint64.wrap(0), ebool.wrap(0), 5);
    vm.expectRevert(bytes("Hedge: not authorised"));
    hedge.openHedgeFor(trader, EVENT_ID, euint64.wrap(0), ebool.wrap(0));
  }
}
