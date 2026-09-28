// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IResolver} from "./interfaces/IResolver.sol";

/// @title EventMarket - public probability (odds) layer for Contingent
/// @notice The one part that is intentionally PUBLIC: a market whose price is the implied probability
///         of an event. Contingent uses a parimutuel-style pool (YES pool vs NO pool) so the odds are
///         self-funding and always well-defined — `p = yesPool / (yesPool + noPool)`, in basis points.
///
///         Hedgers do NOT trade this pool (that would leak their size); they read `probYesBps` and
///         price their encrypted hedge OFF it. LPs / arbers stake to keep the probability accurate.
///
///         This is a self-contained CPMM for the MVP. A Uniswap v4 custom-curve pool + `EventHook`
///         (batch/settlement guard) can replace the pricing internals without changing the hedge
///         layer, since the hedge layer only consumes `probYesBps` + `isResolved`/`outcomeYes`.
contract EventMarket {
  uint256 public constant BPS = 10_000;

  struct Market {
    uint256 yesPool; // USDG staked on YES (public)
    uint256 noPool; // USDG staked on NO (public)
    uint64 closeTime; // no new hedges after this (public)
    IResolver resolver; // decides the outcome
    bool resolved;
    bool outcomeYes;
    bool exists;
  }

  mapping(bytes32 => Market) internal _markets;
  address public immutable owner;

  event MarketCreated(bytes32 indexed eventId, address resolver, uint64 closeTime);
  event Staked(bytes32 indexed eventId, bool yes, uint256 amount, uint32 newProbYesBps);
  event MarketResolved(bytes32 indexed eventId, bool outcomeYes);

  modifier onlyOwner() {
    require(msg.sender == owner, "Market: not owner");
    _;
  }

  constructor() {
    owner = msg.sender;
  }

  function createMarket(bytes32 eventId, address resolver, uint64 closeTime, uint256 seedYes, uint256 seedNo)
    external
    onlyOwner
  {
    require(!_markets[eventId].exists, "Market: exists");
    require(seedYes > 0 && seedNo > 0, "Market: seed both sides");
    _markets[eventId] = Market({
      yesPool: seedYes,
      noPool: seedNo,
      closeTime: closeTime,
      resolver: IResolver(resolver),
      resolved: false,
      outcomeYes: false,
      exists: true
    });
    emit MarketCreated(eventId, resolver, closeTime);
  }

  /// @notice Public price discovery: stake on a side to move the odds. Amount is bookkeeping only in
  ///         the MVP (the real cash sits in the confidential collateral layer); this is what keeps the
  ///         published probability honest.
  function stake(bytes32 eventId, bool yes, uint256 amount) external {
    Market storage m = _markets[eventId];
    require(m.exists && !m.resolved, "Market: closed");
    require(block.timestamp <= m.closeTime, "Market: past close");
    require(amount > 0, "Market: zero");
    if (yes) {
      m.yesPool += amount;
    } else {
      m.noPool += amount;
    }
    emit Staked(eventId, yes, amount, uint32(probYesBps(eventId)));
  }

  /// @notice Implied probability of YES, in basis points (0..10000). This is the number hedgers price
  ///         off of: a hedge of notional N on YES costs ~ N * p / 10000.
  function probYesBps(bytes32 eventId) public view returns (uint256) {
    Market memory m = _markets[eventId];
    require(m.exists, "Market: none");
    return (m.yesPool * BPS) / (m.yesPool + m.noPool);
  }

  /// @notice Pull the outcome from the market's resolver and freeze it.
  function resolve(bytes32 eventId) external {
    Market storage m = _markets[eventId];
    require(m.exists && !m.resolved, "Market: resolved");
    (bool ok, bool yes) = m.resolver.outcome(eventId);
    require(ok, "Market: unresolved");
    m.resolved = true;
    m.outcomeYes = yes;
    emit MarketResolved(eventId, yes);
  }

  function isOpenForHedging(bytes32 eventId) external view returns (bool) {
    Market memory m = _markets[eventId];
    return m.exists && !m.resolved && block.timestamp <= m.closeTime;
  }

  function isResolved(bytes32 eventId) external view returns (bool resolved, bool outcomeYes) {
    Market memory m = _markets[eventId];
    return (m.resolved, m.outcomeYes);
  }

  function getMarket(bytes32 eventId) external view returns (Market memory) {
    return _markets[eventId];
  }
}
