// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
  FHE,
  euint64,
  ebool,
  externalEuint64,
  externalEbool
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {EventMarket} from "./EventMarket.sol";
import {ConfidentialCollateral} from "./ConfidentialCollateral.sol";
import {ConfidentialPositionManager} from "./ConfidentialPositionManager.sol";
import {ConfidentialUSDG} from "./ConfidentialUSDG.sol";
import {UnderwriterVault} from "./UnderwriterVault.sol";
import {PositionNFT} from "./PositionNFT.sol";
import {ISettlement} from "./interfaces/ISettlement.sol";

/// @title ContingentHedge - confidential event-risk hedging, priced by a public prediction market
/// @notice The orchestrator. A hedger opens an encrypted position (size + direction hidden) on a
///         binary event, priced OFF the public odds in `EventMarket`. The `UnderwriterVault` (LP
///         capital) is the counterparty: `openHedge` first reserves liability against the event's
///         capacity — an **encrypted clamp** bounds the accepted notional so the vault can always pay
///         winners — then charges premium ~ accepted * p / 10000 (NO costs (1-p)) from confidential
///         collateral. Premiums accrue to LPs in aggregate. At resolution the winning payout is
///         computed branchlessly with `FHE.select`, revealed via the CoFHE 3-step async decrypt, and
///         paid from the vault reserve in USDG.
///
///         Front-running resistance: size and side never touch the public pool, so an informed
///         hedger's edge is not visible or copyable while the hedge is live. Only a *winning* payout
///         (and the *aggregate* premium) is ever decrypted — the honest privacy boundary.
contract ContingentHedge {
  uint256 public constant BPS = 10_000;

  EventMarket public immutable market;
  ConfidentialCollateral public immutable collateral;
  ConfidentialPositionManager public immutable positions;
  ConfidentialUSDG public immutable cusdg;
  UnderwriterVault public immutable vault;
  PositionNFT public immutable positionNFT;
  ISettlement public immutable settlement;
  address public immutable owner;

  mapping(uint256 => euint64) internal _payout; // positionId => encrypted payout handle
  mapping(uint256 => bool) public paid;
  mapping(address => bool) public authorised; // routers allowed to open on a user's behalf (ProtectedPerp)

  event HedgeOpened(uint256 indexed positionId, address indexed user, bytes32 indexed eventId, uint32 entryProbBps);
  event HedgeClosed(uint256 indexed positionId, address indexed user);
  event SettlementRequested(uint256 indexed positionId, euint64 payoutHandle);
  event SettlementPaid(uint256 indexed positionId, address indexed user, uint256 amount);
  event PremiumsSwept(bytes32 indexed eventId, uint64 total);

  constructor(
    address market_,
    address collateral_,
    address positions_,
    address cusdg_,
    address vault_,
    address positionNFT_,
    address settlement_
  ) {
    market = EventMarket(market_);
    collateral = ConfidentialCollateral(collateral_);
    positions = ConfidentialPositionManager(positions_);
    cusdg = ConfidentialUSDG(cusdg_);
    vault = UnderwriterVault(vault_);
    positionNFT = PositionNFT(positionNFT_);
    settlement = ISettlement(settlement_);
    owner = msg.sender;
  }

  function authorise(address account, bool ok) external {
    require(msg.sender == owner, "Hedge: not owner");
    authorised[account] = ok;
  }

  // ── Open a confidential hedge ───────────────────────────────────────────────

  /// @notice Open an encrypted hedge on `eventId`. `encSize` is the notional payout you receive if you
  ///         win; direction (`encIsYes`) and size stay encrypted. Cover is only granted for premium that
  ///         was actually paid: the full premium is locked first (clamped to free collateral), the cover
  ///         is scaled down to what that premium buys, the vault clamps it to remaining capacity, and any
  ///         excess premium is refunded. (The SDK batches both inputs under one signature; on-chain each
  ///         is verified with its own proof so per-input encryption also works.)
  function openHedge(
    bytes32 eventId,
    externalEuint64 encSize,
    bytes calldata sizeProof,
    externalEbool encIsYes,
    bytes calldata dirProof
  ) external returns (uint256 positionId) {
    euint64 size = FHE.asEuint64(encSize, sizeProof);
    ebool isYes = FHE.asEbool(encIsYes, dirProof);
    positionId = _openHedge(msg.sender, eventId, size, isYes);
  }

  /// @notice Open on behalf of `user` with already-verified ciphertexts (the caller must have granted this
  ///         contract transient access). Used by `ProtectedPerp` to buy a perp's protection atomically.
  function openHedgeFor(address user, bytes32 eventId, euint64 size, ebool isYes)
    external
    returns (uint256 positionId)
  {
    require(authorised[msg.sender], "Hedge: not authorised");
    positionId = _openHedge(user, eventId, size, isYes);
  }

  function _openHedge(address user, bytes32 eventId, euint64 size, ebool isYes) internal returns (uint256 positionId) {
    require(market.isOpenForHedging(eventId), "Hedge: market closed");
    uint256 pBps = market.probYesBps(eventId);
    FHE.allowThis(size);
    FHE.allowThis(isYes);

    // premium factor in bps: YES costs p, NO costs (1 - p). Floor at 1 so the affordability division is safe.
    uint256 pYes = pBps == 0 ? 1 : pBps;
    uint256 pNo = pBps >= BPS ? 1 : BPS - pBps;
    euint64 pf = FHE.select(isYes, FHE.asEuint64(pYes), FHE.asEuint64(pNo));
    euint64 bps = FHE.asEuint64(BPS);

    // 1. lock the full premium for the requested size (clamped to the trader's free collateral)
    euint64 premiumRequested = FHE.div(FHE.mul(size, pf), bps);
    FHE.allowTransient(premiumRequested, address(collateral));
    euint64 locked = collateral.lock(user, premiumRequested);
    FHE.allowThis(locked);

    // 2. cover only what was actually paid — no free protection when collateral is short
    euint64 affordable = FHE.min(FHE.div(FHE.mul(locked, bps), pf), size);

    // 3. reserve underwriting capacity — accepted cover is clamped so the vault stays solvent
    FHE.allowTransient(affordable, address(vault));
    FHE.allowTransient(isYes, address(vault));
    euint64 accepted = vault.reserveLiability(eventId, isYes, affordable);
    FHE.allowThis(accepted);

    // 4. final premium on the accepted cover; refund whatever was locked beyond it
    euint64 premium = FHE.min(FHE.div(FHE.mul(accepted, pf), bps), locked);
    euint64 refund = FHE.sub(locked, premium);
    FHE.allowThis(premium);
    FHE.allowTransient(refund, address(collateral));
    collateral.release(user, refund);

    // 5. premium accrues to LPs in aggregate (swept after resolution)
    FHE.allowTransient(premium, address(vault));
    vault.collectPremium(eventId, premium);

    // 6. persist encrypted position + mint a transferable ownership NFT (tokenId == positionId)
    FHE.allow(accepted, user);
    positionId = positions.add(user, eventId, accepted, premium, isYes, uint32(pBps));
    positionNFT.mint(user, positionId);
    emit HedgeOpened(positionId, user, eventId, uint32(pBps));
  }

  // ── Cancel a hedge before the event resolves ────────────────────────────────

  /// @notice Close your hedge while the market is still open for hedging: the reserved vault liability
  ///         is released, your premium is refunded to free collateral, and the position is removed.
  ///         (A binary event that hasn't happened yet means no exposure was consumed — a clean cancel.)
  function closeHedge(uint256 positionId) external {
    ConfidentialPositionManager.EventPosition memory p = positions.get(positionId);
    require(positionNFT.ownerOf(positionId) == msg.sender, "Hedge: not holder");
    require(!p.settled, "Hedge: settled");
    require(market.isOpenForHedging(p.eventId), "Hedge: market closed");

    // release the vault's reserved liability for this size/side
    FHE.allowTransient(p.isYes, address(vault));
    FHE.allowTransient(p.size, address(vault));
    vault.releaseLiability(p.eventId, p.isYes, p.size);

    // refund the premium to the hedger's free collateral, and remove it from the LP pool
    FHE.allowTransient(p.premium, address(collateral));
    collateral.release(msg.sender, p.premium);
    FHE.allowTransient(p.premium, address(vault));
    vault.refundPremium(p.eventId, p.premium);

    positionNFT.burn(positionId);
    positions.close(positionId);
    emit HedgeClosed(positionId, msg.sender);
  }

  // ── Settle: compute encrypted payout, then reveal (async) ───────────────────

  /// @notice Step 1 of settlement (keeper). Requires the market resolved. Computes the payout
  ///         branchlessly (winner gets the full accepted notional, loser gets 0) and marks it publicly
  ///         decryptable. Off-chain, decrypt the emitted handle and call `fulfillSettlement`.
  function requestSettlement(uint256 positionId) external {
    ConfidentialPositionManager.EventPosition memory p = positions.get(positionId);
    require(!p.settled, "Hedge: settled");
    (bool resolved, bool outcomeYes) = market.isResolved(p.eventId);
    require(resolved, "Hedge: unresolved");

    ebool won = FHE.eq(p.isYes, FHE.asEbool(outcomeYes));
    euint64 payout = FHE.select(won, p.size, FHE.asEuint64(0));

    FHE.allowThis(payout);
    FHE.allowPublic(payout);
    _payout[positionId] = payout;

    positions.markSettled(positionId);
    emit SettlementRequested(positionId, payout);
  }

  /// @notice Step 3 of settlement. Submit the decrypted payout + Teecryptor signature; verifies the
  ///         signature on-chain and pays the owner from the vault reserve in USDG.
  function fulfillSettlement(uint256 positionId, uint64 plaintextPayout, bytes calldata signature) external {
    require(!paid[positionId], "Hedge: paid");
    ConfidentialPositionManager.EventPosition memory p = positions.get(positionId);

    FHE.publishDecryptResult(_payout[positionId], plaintextPayout, signature);

    // the CURRENT NFT holder is the beneficiary (positions are transferable)
    address beneficiary = positionNFT.ownerOf(positionId);
    paid[positionId] = true;
    if (plaintextPayout > 0) {
      settlement.settle(p.eventId, beneficiary, plaintextPayout); // pay from the vault (direct / 1inch)
    }
    positionNFT.burn(positionId);
    emit SettlementPaid(positionId, beneficiary, plaintextPayout);
  }

  // ── LP yield: aggregate premium sweep ───────────────────────────────────────

  /// @notice Step 1 of the premium sweep: expose the event's aggregate premium pool for decryption.
  ///         Returns the handle; decrypt it off-chain, then call `sweepPremiums`.
  function requestPremiumSweep(bytes32 eventId) external returns (euint64) {
    return vault.requestPremiumSweep(eventId);
  }

  /// @notice Step 3 of the premium sweep: verify the decrypted aggregate on-chain, then move that USDG
  ///         from the confidential collateral pool into the vault reserve (LP yield). Only the total is
  ///         ever revealed — never an individual premium.
  function sweepPremiums(bytes32 eventId, uint64 totalPremium, bytes calldata signature) external {
    vault.fulfillPremiumSweep(eventId, totalPremium, signature);
    if (totalPremium > 0) {
      cusdg.releaseTo(address(vault), totalPremium);
    }
    emit PremiumsSwept(eventId, totalPremium);
  }

  /// @notice Release the event's earmarked capacity back to the free reserve once fully settled.
  function finaliseEvent(bytes32 eventId) external {
    vault.finaliseEvent(eventId);
  }

  function payoutHandle(uint256 positionId) external view returns (euint64) {
    return _payout[positionId];
  }
}
