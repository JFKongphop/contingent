// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FHE, euint64, ebool, externalEuint64, externalEbool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {ConfidentialPerp} from "./ConfidentialPerp.sol";
import {ContingentHedge} from "./ContingentHedge.sol";

/// @title ProtectedPerp - one transaction: a leveraged perp + its prediction-market protection
/// @notice Opens an encrypted ETH perp and, atomically, an encrypted hedge on the "ETH ≥ strike" event on the
///         OPPOSITE side of the perp: a long is protected by NO (pays if ETH ends below the strike), a short by
///         YES (pays if ETH ends above it). The hedge side is computed on the ciphertext as `NOT isLong`, so
///         the trader's direction stays hidden — observers can't even tell whether the protection is YES or NO.
///
///         The perp ↔ protection link is recorded on-chain. Both legs stay owned by the trader and are closed
///         through their own contracts (perp close is async-decrypted; the hedge is closed or settled normally).
contract ProtectedPerp {
  ConfidentialPerp public immutable perp;
  ContingentHedge public immutable hedge;
  address public immutable owner;
  bytes32 public eventId; // the event market used for protection

  mapping(uint256 => uint256) public protectionOf; // perp position id => hedge position id (0 = none)

  event ProtectedOpened(address indexed trader, uint256 indexed perpId, uint256 indexed hedgeId, uint64 leverage);
  event EventSet(bytes32 eventId);

  constructor(address perp_, address hedge_, bytes32 eventId_) {
    perp = ConfidentialPerp(perp_);
    hedge = ContingentHedge(hedge_);
    owner = msg.sender;
    eventId = eventId_;
    emit EventSet(eventId_);
  }

  /// @notice Roll protection to a new event market (e.g. the next expiry).
  function setEvent(bytes32 eventId_) external {
    require(msg.sender == owner, "Protected: not owner");
    eventId = eventId_;
    emit EventSet(eventId_);
  }

  /// @notice Open a protected position. Collateral, direction and cover notional arrive encrypted (bound to
  ///         this contract); leverage is public. Cover is scaled to the premium the trader can actually pay.
  function openProtected(
    externalEuint64 encCollateral,
    bytes calldata collateralProof,
    externalEbool encIsLong,
    bytes calldata directionProof,
    uint64 leverage,
    externalEuint64 encCover,
    bytes calldata coverProof
  ) external returns (uint256 perpId, uint256 hedgeId) {
    euint64 collateral = FHE.asEuint64(encCollateral, collateralProof);
    ebool isLong = FHE.asEbool(encIsLong, directionProof);
    euint64 cover = FHE.asEuint64(encCover, coverProof);
    ebool isYes = FHE.not(isLong); // long → NO, short → YES — decided on the ciphertext

    FHE.allowTransient(collateral, address(perp));
    FHE.allowTransient(isLong, address(perp));
    perpId = perp.openPositionFor(msg.sender, collateral, isLong, leverage);

    FHE.allowTransient(cover, address(hedge));
    FHE.allowTransient(isYes, address(hedge));
    hedgeId = hedge.openHedgeFor(msg.sender, eventId, cover, isYes);

    protectionOf[perpId] = hedgeId;
    emit ProtectedOpened(msg.sender, perpId, hedgeId, leverage);
  }
}
