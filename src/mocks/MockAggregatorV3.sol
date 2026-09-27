// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {AggregatorV3Interface} from "../resolvers/PriceThresholdResolver.sol";

/// @title MockAggregatorV3 - settable Chainlink-style price feed for tests
contract MockAggregatorV3 is AggregatorV3Interface {
  uint8 public immutable dec;
  int256 public answer;
  uint256 public updatedAt;
  uint80 public round;

  constructor(uint8 decimals_, int256 initialAnswer) {
    dec = decimals_;
    answer = initialAnswer;
    updatedAt = block.timestamp;
    round = 1;
  }

  function setAnswer(int256 newAnswer) external {
    answer = newAnswer;
    updatedAt = block.timestamp;
    round++;
  }

  function decimals() external view override returns (uint8) {
    return dec;
  }

  function latestRoundData()
    external
    view
    override
    returns (uint80, int256, uint256, uint256, uint80)
  {
    return (round, answer, updatedAt, updatedAt, round);
  }
}
