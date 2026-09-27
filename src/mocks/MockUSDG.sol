// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDG - test stand-in for Paxos USDG (6 decimals, like the real thing)
/// @notice Plaintext ERC-20. On Arbitrum Sepolia point ConfidentialUSDG at the canonical USDG instead.
contract MockUSDG is ERC20 {
  constructor() ERC20("Global Dollar", "USDG") {}

  function decimals() public pure override returns (uint8) {
    return 6;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}
