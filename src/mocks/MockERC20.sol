// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20 - generic mintable 18-decimal token for tests (e.g. v4 pool currencies)
contract MockERC20 is ERC20 {
  constructor(string memory n, string memory s) ERC20(n, s) {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}
