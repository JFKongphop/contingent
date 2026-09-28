// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FHE, euint64, ebool} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title UnderwriterVault - the counterparty that makes Contingent solvent by construction
/// @notice LPs deposit plaintext USDG and take the *other side* of hedges (the yield-seeker who sells
///         protection). Each event is given a public **capacity** — the most the vault will pay a
///         single winning side. When a hedger opens, the vault reserves liability for their (encrypted)
///         notional with an **encrypted clamp**: the accepted notional is bounded so total committed
///         liability per side can never exceed `capacity`. Because only one side of a binary event
///         wins, `capacity <= earmarked reserve` guarantees every winner can be paid — **solvency is
///         enforced on ciphertext, without ever revealing a position's size.**
///
///         LP yield comes from an **aggregate premium sweep**: each hedge's premium is added to an
///         encrypted per-event pool; after resolution the *aggregate* (not any individual premium) is
///         decrypted and credited to the reserve, raising the share price.
///
///         Share accounting is a minimal ERC-4626-style claim over the plaintext reserve. Only the
///         *free* reserve (not earmarked to a live event) is withdrawable.
contract UnderwriterVault {
  using SafeERC20 for IERC20;

  IERC20 public immutable usdg;
  address public immutable owner;

  // ── LP reserve / shares ──
  uint256 public totalReserve; // plaintext USDG held (grows with premium sweeps = LP yield)
  uint256 public totalShares;
  mapping(address => uint256) public sharesOf;
  uint256 public earmarked; // reserve locked as capacity for live events (not withdrawable)

  // ── per-event underwriting ──
  struct Event {
    uint256 capacity; // public max single-side payout
    uint256 paidOut; // plaintext paid so far (<= capacity)
    bool active; // earmarked and not yet finalised
    bool premiumsSwept;
  }

  mapping(bytes32 => Event) public events;
  mapping(bytes32 => euint64) internal _committedYes; // encrypted YES-side liability
  mapping(bytes32 => euint64) internal _committedNo; // encrypted NO-side liability
  mapping(bytes32 => euint64) internal _premiumPool; // encrypted sum of premiums for the event

  mapping(address => bool) public authorised; // Hedge (reserve/collect) + settlement (payWinner)

  event Deposit(address indexed lp, uint256 assets, uint256 shares);
  event Withdraw(address indexed lp, uint256 assets, uint256 shares);
  event Earmarked(bytes32 indexed eventId, uint256 capacity);
  event WinnerPaid(bytes32 indexed eventId, address indexed to, uint256 amount);
  event PremiumsSwept(bytes32 indexed eventId, uint256 amount);
  event EventFinalised(bytes32 indexed eventId, uint256 releasedCapacity);

  modifier onlyOwner() {
    require(msg.sender == owner, "Vault: not owner");
    _;
  }

  modifier onlyAuthorised() {
    require(authorised[msg.sender] || msg.sender == owner, "Vault: not authorised");
    _;
  }

  constructor(address usdg_) {
    usdg = IERC20(usdg_);
    owner = msg.sender;
  }

  function authorise(address account, bool ok) external onlyOwner {
    authorised[account] = ok;
  }

  function freeReserve() public view returns (uint256) {
    return totalReserve - earmarked;
  }

  // ── LP deposits / withdrawals (ERC-4626-lite) ───────────────────────────────

  function deposit(uint256 assets) external returns (uint256 shares) {
    require(assets > 0, "Vault: zero");
    shares = totalShares == 0 ? assets : (assets * totalShares) / totalReserve;
    usdg.safeTransferFrom(msg.sender, address(this), assets);
    totalReserve += assets;
    totalShares += shares;
    sharesOf[msg.sender] += shares;
    emit Deposit(msg.sender, assets, shares);
  }

  /// @notice Withdraw LP shares for USDG. Only the *free* reserve can be withdrawn — capital
  ///         earmarked to a live event is locked until that event finalises.
  function withdraw(uint256 shares) external returns (uint256 assets) {
    require(shares > 0 && shares <= sharesOf[msg.sender], "Vault: bad shares");
    assets = (shares * totalReserve) / totalShares;
    require(assets <= freeReserve(), "Vault: reserve earmarked");
    sharesOf[msg.sender] -= shares;
    totalShares -= shares;
    totalReserve -= assets;
    usdg.safeTransfer(msg.sender, assets);
    emit Withdraw(msg.sender, assets, shares);
  }

  // ── Per-event capacity ──────────────────────────────────────────────────────

  /// @notice Earmark `capacity` of the free reserve to back a single winning side of `eventId`.
  function earmark(bytes32 eventId, uint256 capacity) external onlyAuthorised {
    require(!events[eventId].active, "Vault: active");
    require(capacity > 0 && capacity <= freeReserve(), "Vault: insufficient free reserve");
    require(capacity <= type(uint64).max, "Vault: capacity too large");
    events[eventId] = Event({capacity: capacity, paidOut: 0, active: true, premiumsSwept: false});
    earmarked += capacity;
    // init encrypted accumulators
    _committedYes[eventId] = FHE.asEuint64(0);
    _committedNo[eventId] = FHE.asEuint64(0);
    _premiumPool[eventId] = FHE.asEuint64(0);
    FHE.allowThis(_committedYes[eventId]);
    FHE.allowThis(_committedNo[eventId]);
    FHE.allowThis(_premiumPool[eventId]);
    emit Earmarked(eventId, capacity);
  }

  // ── Underwriting: reserve liability with an encrypted solvency clamp ─────────

  /// @notice Reserve liability for a hedge of encrypted `notional` on the side `isYes`. Returns the
  ///         **accepted** notional, clamped so total committed liability on that side never exceeds
  ///         `capacity`. The Hedge uses the accepted value as the position's size, so a hedger can
  ///         never be sold more cover than the vault can pay — enforced without revealing the size.
  function reserveLiability(bytes32 eventId, ebool isYes, euint64 notional)
    external
    onlyAuthorised
    returns (euint64 accepted)
  {
    require(events[eventId].active, "Vault: event inactive");
    FHE.allowThis(notional);
    euint64 capE = FHE.asEuint64(uint64(events[eventId].capacity));

    euint64 curYes = _committedYes[eventId];
    euint64 curNo = _committedNo[eventId];

    // route the notional to the chosen side (the other side gets 0)
    euint64 zero = FHE.asEuint64(0);
    euint64 wantYes = FHE.select(isYes, notional, zero);
    euint64 wantNo = FHE.select(isYes, zero, notional);

    // accept only up to the remaining room on each side: min(want, capacity - committed)
    euint64 roomYes = FHE.sub(capE, curYes); // >= 0: invariant committed <= capacity
    euint64 roomNo = FHE.sub(capE, curNo);
    euint64 accYes = FHE.select(FHE.lte(wantYes, roomYes), wantYes, roomYes);
    euint64 accNo = FHE.select(FHE.lte(wantNo, roomNo), wantNo, roomNo);

    _committedYes[eventId] = FHE.add(curYes, accYes);
    _committedNo[eventId] = FHE.add(curNo, accNo);
    accepted = FHE.add(accYes, accNo); // exactly one side is non-zero

    FHE.allowThis(_committedYes[eventId]);
    FHE.allowThis(_committedNo[eventId]);
    FHE.allowThis(accepted);
    FHE.allowSender(accepted); // caller (Hedge) keeps the accepted handle
  }

  /// @notice Add an encrypted `premium` to the event's premium pool (LP income, swept in aggregate).
  function collectPremium(bytes32 eventId, euint64 premium) external onlyAuthorised {
    require(events[eventId].active, "Vault: event inactive");
    FHE.allowThis(premium);
    _premiumPool[eventId] = FHE.add(_premiumPool[eventId], premium);
    FHE.allowThis(_premiumPool[eventId]);
  }

  /// @notice Release reserved liability of encrypted `size` on side `isYes` (a hedge was cancelled).
  ///         Subtraction is clamped so committed liability can never underflow.
  function releaseLiability(bytes32 eventId, ebool isYes, euint64 size) external onlyAuthorised {
    require(events[eventId].active, "Vault: event inactive");
    FHE.allowThis(isYes);
    FHE.allowThis(size);
    euint64 zero = FHE.asEuint64(0);
    euint64 subYes = FHE.select(isYes, size, zero);
    euint64 subNo = FHE.select(isYes, zero, size);
    euint64 curYes = _committedYes[eventId];
    euint64 curNo = _committedNo[eventId];
    _committedYes[eventId] = FHE.sub(curYes, FHE.select(FHE.lte(subYes, curYes), subYes, curYes));
    _committedNo[eventId] = FHE.sub(curNo, FHE.select(FHE.lte(subNo, curNo), subNo, curNo));
    FHE.allowThis(_committedYes[eventId]);
    FHE.allowThis(_committedNo[eventId]);
  }

  /// @notice Remove an encrypted `premium` from the pool (a cancelled hedge's premium is refunded,
  ///         not earned by LPs). Clamped so the pool can never underflow.
  function refundPremium(bytes32 eventId, euint64 premium) external onlyAuthorised {
    require(events[eventId].active, "Vault: event inactive");
    FHE.allowThis(premium);
    euint64 pool = _premiumPool[eventId];
    _premiumPool[eventId] = FHE.sub(pool, FHE.select(FHE.lte(premium, pool), premium, pool));
    FHE.allowThis(_premiumPool[eventId]);
  }

  // ── Settlement: pay winners from the reserve ────────────────────────────────

  /// @notice Pay a winning hedger `amount` USDG from the reserve. Bounded by the event's capacity so
  ///         the vault can never pay more than it earmarked (the on-chain solvency backstop).
  function payWinner(bytes32 eventId, address to, uint256 amount) external onlyAuthorised {
    Event storage e = events[eventId];
    require(e.active, "Vault: event inactive");
    require(e.paidOut + amount <= e.capacity, "Vault: exceeds capacity");
    e.paidOut += amount;
    totalReserve -= amount;
    usdg.safeTransfer(to, amount);
    emit WinnerPaid(eventId, to, amount);
  }

  // ── Premium sweep (aggregate decrypt) → LP yield ────────────────────────────

  /// @notice Expose the aggregate premium pool for decryption (step 1). Only the *total* is revealed,
  ///         never an individual premium.
  function requestPremiumSweep(bytes32 eventId) external onlyAuthorised returns (euint64) {
    require(events[eventId].active && !events[eventId].premiumsSwept, "Vault: swept");
    FHE.allowPublic(_premiumPool[eventId]);
    return _premiumPool[eventId];
  }

  /// @notice Credit the decrypted aggregate premium to the reserve (LP yield). The USDG for these
  ///         premiums is delivered by the settlement layer (released from the confidential collateral
  ///         pool) in the same flow; here we account it and verify the signature.
  function fulfillPremiumSweep(bytes32 eventId, uint64 totalPremium, bytes calldata signature) external onlyAuthorised {
    require(events[eventId].active && !events[eventId].premiumsSwept, "Vault: swept");
    FHE.publishDecryptResult(_premiumPool[eventId], totalPremium, signature);
    events[eventId].premiumsSwept = true;
    // the settlement layer pushes the matching USDG (cusdg.releaseTo) alongside this call; book it as
    // reserve so the LP share price reflects the earned premium.
    totalReserve += totalPremium;
    emit PremiumsSwept(eventId, totalPremium);
  }

  /// @notice Book externally-delivered USDG (e.g. swept premiums) into the reserve.
  function fund(uint256 amount) external {
    usdg.safeTransferFrom(msg.sender, address(this), amount);
    totalReserve += amount;
  }

  /// @notice Release an event's earmarked capacity back to the free reserve once it's fully settled.
  function finaliseEvent(bytes32 eventId) external onlyAuthorised {
    Event storage e = events[eventId];
    require(e.active, "Vault: inactive");
    e.active = false;
    earmarked -= e.capacity;
    emit EventFinalised(eventId, e.capacity);
  }

  // ── Views ───────────────────────────────────────────────────────────────────

  function committedYes(bytes32 eventId) external view returns (euint64) {
    return _committedYes[eventId];
  }

  function committedNo(bytes32 eventId) external view returns (euint64) {
    return _committedNo[eventId];
  }

  function premiumPool(bytes32 eventId) external view returns (euint64) {
    return _premiumPool[eventId];
  }

  function sharePriceWad() external view returns (uint256) {
    return totalShares == 0 ? 1e18 : (totalReserve * 1e18) / totalShares;
  }
}
