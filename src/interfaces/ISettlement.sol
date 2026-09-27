// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title ISettlement - payout sink for resolved hedges
/// @notice The Hedge contract calls `settle` with an amount it obtained by verified decryption of a
///         winning payout. Implementations decide how the USDG is sourced and routed (direct reserve,
///         or 1inch Aqua/SwapVM liquidity).
interface ISettlement {
  function settle(bytes32 eventId, address to, uint256 amount) external;
}
