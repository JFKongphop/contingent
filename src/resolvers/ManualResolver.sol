// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IResolver} from "../interfaces/IResolver.sol";

/// @title ManualResolver - trusted-attestor event resolution (MVP / testing)
/// @notice A designated attestor reports the outcome. Deterministic and dispute-free; suitable for
///         demos and for events fed by an off-chain keeper. Swap for PriceThresholdResolver (on-chain
///         price feed) or an optimistic oracle (UMA) without touching the market/hedge layers.
contract ManualResolver is IResolver {
  address public immutable attestor;
  mapping(bytes32 => bool) public resolved;
  mapping(bytes32 => bool) public yesOutcome;

  event Resolved(bytes32 indexed eventId, bool yes);

  constructor(address attestor_) {
    attestor = attestor_;
  }

  function report(bytes32 eventId, bool yes) external {
    require(msg.sender == attestor, "Resolver: not attestor");
    require(!resolved[eventId], "Resolver: already resolved");
    resolved[eventId] = true;
    yesOutcome[eventId] = yes;
    emit Resolved(eventId, yes);
  }

  function outcome(bytes32 eventId) external view override returns (bool, bool) {
    return (resolved[eventId], yesOutcome[eventId]);
  }
}
