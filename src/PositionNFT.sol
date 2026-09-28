// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title PositionNFT - transferable ownership of a Contingent hedge
/// @notice One ERC-721 per position (tokenId == positionId). The **current holder** is the hedge's
///         beneficiary: they can close it and they receive the payout at settlement. Because the
///         position's size and side are encrypted, transferring the NFT transfers a *private* payoff —
///         a secondary market in event hedges without revealing anyone's exposure. Mint/burn are
///         restricted to the authorised `ContingentHedge`.
contract PositionNFT is ERC721 {
  address public immutable owner;
  mapping(address => bool) public authorised;

  modifier onlyAuthorised() {
    require(authorised[msg.sender] || msg.sender == owner, "NFT: not authorised");
    _;
  }

  constructor() ERC721("Contingent Hedge Position", "cHEDGE") {
    owner = msg.sender;
  }

  function authorise(address account, bool ok) external {
    require(msg.sender == owner, "NFT: not owner");
    authorised[account] = ok;
  }

  function mint(address to, uint256 tokenId) external onlyAuthorised {
    _mint(to, tokenId);
  }

  function burn(uint256 tokenId) external onlyAuthorised {
    _burn(tokenId);
  }

  /// @notice Owner if minted, else address(0) (burned/never-minted) — avoids the ERC-721 revert.
  function ownerOrZero(uint256 tokenId) external view returns (address) {
    return _ownerOf(tokenId);
  }
}
