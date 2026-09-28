// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {FHE, euint64, ebool, externalEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IConfidentialToken, IERC7984Receiver} from "./interfaces/IConfidentialToken.sol";

/// @title ConfidentialCollateral - encrypted collateral vault for Contingent hedges
/// @notice Users deposit confidential USDG (cUSDG); balances are stored encrypted. Deposits arrive
///         via `confidentialTransferAndCall` (the token verifies the proof and calls us back with an
///         already-decoded euint64). Withdrawals are synchronous — `FHE.select` clamps to the
///         available balance, so there is no oracle round-trip and nothing leaks.
///
///         Port note (Zama to Fhenix): this is the prior `Collateral.sol` on CoFHE — same structure,
///         `FHE.fromExternal` becomes `FHE.asEuint64(input, proof)`, `FHE.ge` becomes `FHE.gte`, and
///         the `ZamaEthereumConfig` base is dropped. The Hedge contract is `authorise`d to lock and
///         release collateral for positions.
contract ConfidentialCollateral is IERC7984Receiver {
  IConfidentialToken public immutable token;
  address public immutable owner;

  /// @dev per-user encrypted free (unlocked) collateral balance
  mapping(address => euint64) internal _collateral;
  mapping(address => bool) public authorised;

  event Deposit(address indexed user, euint64 amount);
  event Withdraw(address indexed user, euint64 amount);
  event Locked(address indexed user, euint64 amount);
  event Released(address indexed user, euint64 amount);

  modifier onlyOwner() {
    require(msg.sender == owner, "Collateral: not owner");
    _;
  }

  modifier onlyAuthorised() {
    require(authorised[msg.sender] || msg.sender == owner, "Collateral: not authorised");
    _;
  }

  constructor(address tokenAddress) {
    token = IConfidentialToken(tokenAddress);
    owner = msg.sender;
  }

  function authorise(address account, bool ok) external onlyOwner {
    authorised[account] = ok;
  }

  // ── Deposit via ERC-7984 receiver callback ──────────────────────────────────

  /// @notice Called by the token after `confidentialTransferAndCall`. `amount` is already verified.
  function onConfidentialTransferReceived(
    address, /* operator */
    address from,
    euint64 amount,
    bytes calldata /* data */
  ) external override returns (ebool) {
    require(msg.sender == address(token), "Collateral: only token");
    _credit(from, amount);
    emit Deposit(from, amount);

    // token needs transient access to the returned ebool for its FHE.select refund check
    ebool success = FHE.asEbool(true);
    FHE.allowTransient(success, msg.sender);
    return success;
  }

  // ── User withdraw (synchronous, clamped) ────────────────────────────────────

  /// @notice Withdraw up to `encAmount` cUSDG back to the caller in one tx. If the encrypted balance
  ///         is less than requested, the whole balance is returned (no revert, no leak).
  function withdraw(externalEuint64 encAmount, bytes calldata inputProof) external {
    euint64 requested = FHE.asEuint64(encAmount, inputProof);
    euint64 bal = _collateral[msg.sender];
    euint64 actual = FHE.select(FHE.gte(bal, requested), requested, bal);

    _collateral[msg.sender] = FHE.sub(bal, actual);
    FHE.allowThis(_collateral[msg.sender]);
    FHE.allow(_collateral[msg.sender], msg.sender);
    FHE.allow(actual, msg.sender);

    // token needs transient access to move `actual`
    FHE.allowTransient(actual, address(token));
    token.confidentialTransfer(msg.sender, actual);

    emit Withdraw(msg.sender, actual);
  }

  /// @notice Encrypted free-collateral handle for `msg.sender` (decrypt client-side).
  function myCollateral() external view returns (euint64) {
    return _collateral[msg.sender];
  }

  function collateralOf(address user) external view onlyAuthorised returns (euint64) {
    return _collateral[user];
  }

  // ── Hedge-facing: lock / release encrypted amounts ──────────────────────────

  /// @notice Move `amount` from `user`'s free balance into a lock (clamped). Returns the amount
  ///         actually locked, which the caller (Hedge) uses as the position's collateral.
  function lock(address user, euint64 amount) external onlyAuthorised returns (euint64 locked) {
    FHE.allowThis(amount);
    euint64 bal = _collateral[user];
    locked = FHE.select(FHE.gte(bal, amount), amount, bal); // never lock more than free balance
    _collateral[user] = FHE.sub(bal, locked);

    FHE.allowThis(_collateral[user]);
    FHE.allow(_collateral[user], user);
    FHE.allowThis(locked);
    FHE.allowSender(locked); // caller (Hedge) keeps the locked handle
    emit Locked(user, locked);
  }

  /// @notice Return an already-encrypted `amount` to `user`'s free balance (e.g. hedge closed / won).
  function release(address user, euint64 amount) external onlyAuthorised {
    FHE.allowThis(amount);
    _credit(user, amount);
    emit Released(user, amount);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  function _credit(address user, euint64 amount) internal {
    if (FHE.isInitialized(_collateral[user])) {
      _collateral[user] = FHE.add(_collateral[user], amount);
    } else {
      _collateral[user] = amount;
    }
    FHE.allowThis(_collateral[user]);
    FHE.allow(_collateral[user], user);
  }
}
