// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {PriceThresholdResolver} from "../src/resolvers/PriceThresholdResolver.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";

contract PriceThresholdResolverTest is Test {
  PriceThresholdResolver resolver;
  MockAggregatorV3 feed;
  bytes32 constant EVENT_ID = keccak256("USDC < 0.97");

  function setUp() public {
    resolver = new PriceThresholdResolver();
    feed = new MockAggregatorV3(8, 1_00_000_000); // $1.00 at 8 decimals
    // YES if price <= $0.97, deadline in 7 days
    resolver.register(EVENT_ID, address(feed), 97_000_000, true, uint64(block.timestamp + 7 days));
  }

  function test_pendingWhilePeggedBeforeDeadline() public view {
    (bool resolved, bool yes) = resolver.outcome(EVENT_ID);
    assertFalse(resolved);
    assertFalse(yes);
  }

  function test_yesOnDepeg() public {
    feed.setAnswer(95_000_000); // $0.95 — depeg
    (bool resolved, bool yes) = resolver.outcome(EVENT_ID);
    assertTrue(resolved);
    assertTrue(yes);
  }

  function test_noAfterDeadlineWithoutCross() public {
    vm.warp(block.timestamp + 8 days);
    feed.setAnswer(1_00_000_000); // still pegged, refresh updatedAt
    (bool resolved, bool yes) = resolver.outcome(EVENT_ID);
    assertTrue(resolved);
    assertFalse(yes);
  }

  function test_revertsOnStaleFeed() public {
    vm.warp(block.timestamp + 2 hours); // feed last updated at deploy
    vm.expectRevert(bytes("Resolver: stale feed"));
    resolver.outcome(EVENT_ID);
  }
}
