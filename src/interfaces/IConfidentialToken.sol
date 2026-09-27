// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {euint64, ebool, externalEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IConfidentialToken - minimal ERC-7984-style confidential token interface
/// @notice Balances and transfer amounts are `euint64` ciphertext handles. There are no
///         allowances (an amount would leak); a holder authorises a time-boxed **operator**
///         instead. Transfers **zero-replace** on insufficient balance (a revert would leak),
///         so callers must use the returned `euint64` (the amount actually moved).
interface IConfidentialToken {
  /// @return the caller-decryptable encrypted balance handle for `account`.
  function confidentialBalanceOf(address account) external view returns (euint64);

  /// @notice Move an already-on-chain encrypted amount to `to`. Returns the amount actually sent.
  function confidentialTransfer(address to, euint64 amount) external returns (euint64 sent);

  /// @notice Move a client-encrypted amount to `to` (externalEuint64 + shared proof).
  function confidentialTransfer(address to, externalEuint64 amount, bytes calldata inputProof)
    external
    returns (euint64 sent);

  /// @notice Operator path: move `from`'s encrypted balance. Caller must be an active operator of `from`.
  function confidentialTransferFrom(address from, address to, euint64 amount) external returns (euint64 sent);

  /// @notice Transfer then invoke `IERC7984Receiver.onConfidentialTransferReceived` on `to`.
  function confidentialTransferAndCall(address to, externalEuint64 amount, bytes calldata inputProof, bytes calldata data)
    external
    returns (euint64 sent);

  /// @notice Authorise `operator` to move the caller's balance until `until` (unix seconds). 0 revokes.
  function setOperator(address operator, uint48 until) external;

  /// @notice True while `operator` is authorised for `holder`.
  function isOperator(address holder, address operator) external view returns (bool);
}

/// @title IERC7984Receiver - callback for confidentialTransferAndCall
interface IERC7984Receiver {
  /// @param amount already-verified encrypted amount received.
  /// @return an encrypted "accepted" flag; the token may `FHE.select` on it to decide a refund.
  function onConfidentialTransferReceived(address operator, address from, euint64 amount, bytes calldata data)
    external
    returns (ebool);
}
