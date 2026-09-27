// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title IResolver - pluggable event resolution oracle
/// @notice Contingent is oracle-first: the market layer prices probability, but WHETHER an event
///         happened is decided here. Keep resolution deterministic (price thresholds, attestations)
///         for the MVP; a subjective/optimistic oracle (UMA) can implement the same interface later
///         without touching core hedging logic.
interface IResolver {
  /// @param eventId identifier of the event being hedged.
  /// @return resolved true once the outcome is final.
  /// @return yes     the outcome: true = event happened (YES), false = did not (NO).
  function outcome(bytes32 eventId) external view returns (bool resolved, bool yes);
}
