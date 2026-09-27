// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IResolver} from "../interfaces/IResolver.sol";

/// @dev Minimal Chainlink feed interface (subset used here).
interface AggregatorV3Interface {
  function decimals() external view returns (uint8);
  function latestRoundData()
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title PriceThresholdResolver - objective, oracle-resolved event outcomes
/// @notice Resolves "did an on-chain price cross a threshold by a deadline?" — the canonical Contingent
///         MVP event (a depeg, a price breach). Deterministic and dispute-free: once the price crosses,
///         the outcome latches to YES; if the deadline passes without a cross, it resolves NO.
///
///         Port note (Zama to Fhenix): generalises the prior `OracleIntegration.sol` Chainlink wrapper
///         into a pluggable `IResolver`, so the same market/hedge layer works with any resolver
///         (price feed here; a UMA optimistic oracle or attestor elsewhere).
contract PriceThresholdResolver is IResolver {
  struct Threshold {
    AggregatorV3Interface feed;
    int256 threshold; // in the feed's own decimals
    bool below; // true: YES when price <= threshold (depeg); false: YES when price >= threshold
    uint64 deadline; // resolves NO after this if never crossed
    bool exists;
  }

  uint256 public constant STALENESS = 1 hours;

  mapping(bytes32 => Threshold) public thresholds;
  address public immutable owner;

  event ThresholdRegistered(bytes32 indexed eventId, address feed, int256 threshold, bool below, uint64 deadline);

  constructor() {
    owner = msg.sender;
  }

  function register(bytes32 eventId, address feed, int256 threshold, bool below, uint64 deadline) external {
    require(msg.sender == owner, "Resolver: not owner");
    require(!thresholds[eventId].exists, "Resolver: exists");
    thresholds[eventId] =
      Threshold({feed: AggregatorV3Interface(feed), threshold: threshold, below: below, deadline: deadline, exists: true});
    emit ThresholdRegistered(eventId, feed, threshold, below, deadline);
  }

  /// @inheritdoc IResolver
  function outcome(bytes32 eventId) external view override returns (bool resolved, bool yes) {
    Threshold memory t = thresholds[eventId];
    require(t.exists, "Resolver: unknown event");

    (, int256 price,, uint256 updatedAt,) = t.feed.latestRoundData();
    require(price > 0, "Resolver: bad price");
    require(block.timestamp - updatedAt < STALENESS, "Resolver: stale feed");

    bool crossed = t.below ? (price <= t.threshold) : (price >= t.threshold);
    if (crossed) {
      return (true, true); // event happened → YES, latched
    }
    if (block.timestamp > t.deadline) {
      return (true, false); // deadline passed without a cross → NO
    }
    return (false, false); // still pending
  }
}
