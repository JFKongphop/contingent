// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {FHE, euint64, ebool, externalEuint64, externalEbool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title ConfidentialPositionManager - encrypted event-hedge positions
/// @notice Stores each hedge with its **size, direction, and premium encrypted** (`euint64`/`ebool`);
///         only the event id, the public entry-odds snapshot, and existence flags are plaintext.
///         Nobody — not LPs, searchers, nor the protocol — can read a position's size or side.
///
///         Port note (Zama to Fhenix): this is the prior PositionManager.sol generalised from
///         futures/options to a binary event position, on CoFHE (fhenixprotocol lib, no ZamaConfig).
contract ConfidentialPositionManager {
  struct EventPosition {
    euint64 size; // encrypted notional payout if the position wins (USDG, 6-dec)
    euint64 premium; // encrypted collateral locked to open (the cost of the hedge)
    ebool isYes; // encrypted direction: true = betting the event happens
    bytes32 eventId; // which event (public)
    uint32 entryProbBps; // public odds snapshot at entry (0..10000)
    uint256 openedAt; // public timestamp
    address owner; // position owner
    bool isOpen; // existence flag
    bool settled; // set once payout has been finalised
  }

  mapping(uint256 => EventPosition) internal _positions;
  mapping(address => uint256[]) public positionsOf;
  uint256 public nextPositionId = 1;

  mapping(address => bool) public authorised;
  address public immutable owner;

  event PositionOpened(uint256 indexed positionId, address indexed user, bytes32 indexed eventId, uint32 entryProbBps);
  event PositionSettled(uint256 indexed positionId);

  modifier onlyOwner() {
    require(msg.sender == owner, "PM: not owner");
    _;
  }

  modifier onlyAuthorised() {
    require(authorised[msg.sender] || msg.sender == owner, "PM: not authorised");
    _;
  }

  constructor() {
    owner = msg.sender;
  }

  function authorise(address account, bool ok) external onlyOwner {
    authorised[account] = ok;
  }

  function add(
    address user,
    bytes32 eventId,
    euint64 size,
    euint64 premium,
    ebool isYes,
    uint32 entryProbBps
  ) external onlyAuthorised returns (uint256 positionId) {
    positionId = nextPositionId++;
    _positions[positionId] = EventPosition({
      size: size,
      premium: premium,
      isYes: isYes,
      eventId: eventId,
      entryProbBps: entryProbBps,
      openedAt: block.timestamp,
      owner: user,
      isOpen: true,
      settled: false
    });
    positionsOf[user].push(positionId);
    emit PositionOpened(positionId, user, eventId, entryProbBps);
  }

  function get(uint256 positionId) external view returns (EventPosition memory) {
    require(_positions[positionId].isOpen, "PM: not open");
    return _positions[positionId];
  }

  function markSettled(uint256 positionId) external onlyAuthorised {
    require(_positions[positionId].isOpen, "PM: not open");
    _positions[positionId].settled = true;
    emit PositionSettled(positionId);
  }

  function close(uint256 positionId) external onlyAuthorised {
    require(_positions[positionId].isOpen, "PM: not open");
    delete _positions[positionId];
  }
}
