// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ConfidentialPerp} from "../src/ConfidentialPerp.sol";
import {ConfidentialUSDG} from "../src/ConfidentialUSDG.sol";
import {ConfidentialCollateral} from "../src/ConfidentialCollateral.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

/// @notice Deploys ConfidentialPerp against the live Contingent stack on Arbitrum Sepolia, authorises it on
///         cUSDG + the collateral vault, and seeds the house pool.
contract DeployPerp is Script {
  address constant USDG = 0x766f287682ecfbD8f97551727684c7d7aD67a53f;
  address constant CUSDG = 0xd8f57E64bc235D4bceF8D2f791BDf46908408F94;
  address constant COLLATERAL = 0x4E4cb1b3B326C79FDFD51E14C26C9bDA7a5F5898;
  address constant ETH_FEED = 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165; // Chainlink ETH/USD

  function run() external {
    uint256 seed = vm.envOr("HOUSE_SEED", uint256(100_000e6));
    vm.startBroadcast();
    ConfidentialPerp perp = new ConfidentialPerp(USDG, CUSDG, COLLATERAL, ETH_FEED);
    ConfidentialUSDG(CUSDG).authorise(address(perp), true);
    ConfidentialCollateral(COLLATERAL).authorise(address(perp), true);
    MockUSDG(USDG).mint(msg.sender, seed);
    MockUSDG(USDG).approve(address(perp), seed);
    perp.deposit(seed);
    vm.stopBroadcast();
    console.log("ConfidentialPerp:", address(perp));
    console.log("House liquidity (USDG):", seed);
  }
}
