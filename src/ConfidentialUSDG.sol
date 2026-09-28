// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {FHE, euint64, ebool, externalEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IConfidentialToken, IERC7984Receiver} from "./interfaces/IConfidentialToken.sol";

/// @title ConfidentialUSDG (cUSDG) - a confidential ledger over plaintext USDG
/// @notice Wraps a standard USDG ERC-20 (6 decimals) 1:1 into a confidential token whose per-holder
///         balances are `euint64` ciphertexts. Plaintext USDG sits in this contract; the encrypted
///         ledger tracks who owns it. This is the collateral + settlement currency for Contingent.
///
///         Port note (Zama to Fhenix): mirrors the prior ConfidentialWETHWrapper, but on CoFHE —
///         the fhevm import becomes fhenixprotocol, FHE.ge becomes FHE.gte, and there is no
///         ZamaConfig base contract to inherit.
///
///         Design choices that matter:
///         - **6-decimal match.** USDG is 6-dec and the confidential unit is 6-dec (euint64), so the
///           wrap rate is 1 — no scaling, no precision loss.
///         - **Zero-replace transfers.** Sending more than balance moves 0 (a revert would leak the
///           balance); callers must read the returned `euint64`.
///         - **Operators, not allowances.** A holder authorises an operator for a time window,
///           all-or-nothing, so no amount ever leaks.
///         - **Plaintext solvency is decoupled.** `releaseTo` (settlement-only) sends plaintext USDG
///           for an amount the settlement layer obtained by verified decryption, so total released
///           is always backed by wraps + forfeited collateral (a zero-sum event pot).
contract ConfidentialUSDG is IConfidentialToken {
  using SafeERC20 for IERC20;

  string public constant name = "Confidential USDG";
  string public constant symbol = "cUSDG";
  uint8 public constant decimals = 6;

  IERC20 public immutable usdg;
  address public immutable owner;

  /// @dev per-holder encrypted balance
  mapping(address => euint64) internal _balances;
  /// @dev holder => operator => authorised-until (unix seconds); active while >= now
  mapping(address => mapping(address => uint48)) public operatorUntil;
  /// @dev contracts allowed to call settlement release (Hedge / SettlementRouter)
  mapping(address => bool) public authorised;

  /// @dev total plaintext USDG held (public; total collateral in the system is not the secret)
  uint256 public totalWrapped;

  event Wrapped(address indexed user, uint256 amount);
  event Released(address indexed to, uint256 amount);
  event ConfidentialTransfer(address indexed from, address indexed to);
  event OperatorSet(address indexed holder, address indexed operator, uint48 until);

  modifier onlyOwner() {
    require(msg.sender == owner, "cUSDG: not owner");
    _;
  }

  modifier onlyAuthorised() {
    require(authorised[msg.sender] || msg.sender == owner, "cUSDG: not authorised");
    _;
  }

  constructor(address usdgAddress) {
    usdg = IERC20(usdgAddress);
    owner = msg.sender;
  }

  function authorise(address account, bool ok) external onlyOwner {
    authorised[account] = ok;
  }

  // ── Wrap: plaintext USDG in → encrypted cUSDG credited ─────────────────────

  /// @notice Pull `amount` plaintext USDG and credit the caller an equal encrypted balance.
  ///         The wrap amount is public (it's your total collateral, not your positions).
  function wrap(uint256 amount) external {
    require(amount > 0 && amount <= type(uint64).max, "cUSDG: bad amount");
    usdg.safeTransferFrom(msg.sender, address(this), amount);
    totalWrapped += amount;
    _credit(msg.sender, FHE.asEuint64(uint64(amount)));
    emit Wrapped(msg.sender, amount);
  }

  // ── Confidential transfers ─────────────────────────────────────────────────

  function confidentialTransfer(address to, euint64 amount) external returns (euint64 sent) {
    FHE.allowThis(amount);
    sent = _move(msg.sender, to, amount);
    emit ConfidentialTransfer(msg.sender, to);
  }

  function confidentialTransfer(address to, externalEuint64 amount, bytes calldata inputProof)
    external
    returns (euint64 sent)
  {
    euint64 amt = FHE.asEuint64(amount, inputProof);
    sent = _move(msg.sender, to, amt);
    emit ConfidentialTransfer(msg.sender, to);
  }

  function confidentialTransferFrom(address from, address to, euint64 amount) external returns (euint64 sent) {
    require(isOperator(from, msg.sender), "cUSDG: not operator");
    FHE.allowThis(amount);
    sent = _move(from, to, amount);
    emit ConfidentialTransfer(from, to);
  }

  function confidentialTransferAndCall(
    address to,
    externalEuint64 amount,
    bytes calldata inputProof,
    bytes calldata data
  ) external returns (euint64 sent) {
    euint64 amt = FHE.asEuint64(amount, inputProof);
    sent = _move(msg.sender, to, amt);
    // let the receiver read the amount it was sent, for this call only
    FHE.allowTransient(sent, to);
    IERC7984Receiver(to).onConfidentialTransferReceived(msg.sender, msg.sender, sent, data);
    emit ConfidentialTransfer(msg.sender, to);
  }

  // ── Operators (time-boxed, all-or-nothing) ─────────────────────────────────

  function setOperator(address operator, uint48 until) external {
    operatorUntil[msg.sender][operator] = until;
    emit OperatorSet(msg.sender, operator, until);
  }

  function isOperator(address holder, address operator) public view returns (bool) {
    return operatorUntil[holder][operator] >= block.timestamp;
  }

  // ── Views ───────────────────────────────────────────────────────────────────

  function confidentialBalanceOf(address account) external view returns (euint64) {
    return _balances[account];
  }

  // ── Settlement: encrypted burn is done by the vault; here we release plaintext ─

  /// @notice Send `plaintextAmount` plaintext USDG to `to`. Callable only by authorised settlement
  ///         contracts, which pass an amount obtained by verified decryption of a winning payout.
  function releaseTo(address to, uint256 plaintextAmount) external onlyAuthorised {
    require(plaintextAmount <= totalWrapped, "cUSDG: insolvent");
    totalWrapped -= plaintextAmount;
    usdg.safeTransfer(to, plaintextAmount);
    emit Released(to, plaintextAmount);
  }

  // ── Internal encrypted accounting ───────────────────────────────────────────

  /// @dev debit `from` by min(balance, amount) (zero-replace), credit `to` the same. Returns moved.
  function _move(address from, address to, euint64 amount) internal returns (euint64 sent) {
    euint64 bal = _balances[from];
    if (!FHE.isInitialized(bal)) {
      bal = FHE.asEuint64(0);
    }
    ebool ok = FHE.gte(bal, amount);
    sent = FHE.select(ok, amount, FHE.asEuint64(0)); // clamp: never move more than held
    _balances[from] = FHE.sub(bal, sent);
    _credit(to, sent);

    FHE.allowThis(_balances[from]);
    FHE.allow(_balances[from], from);
    FHE.allow(sent, from);
  }

  /// @dev credit `to` by `amount`, initialising the handle if needed.
  function _credit(address to, euint64 amount) internal {
    if (FHE.isInitialized(_balances[to])) {
      _balances[to] = FHE.add(_balances[to], amount);
    } else {
      _balances[to] = amount;
    }
    FHE.allowThis(_balances[to]);
    FHE.allow(_balances[to], to);
  }
}
