// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ConfidentialPerp} from "../src/ConfidentialPerp.sol";
import {ContingentHedge} from "../src/ContingentHedge.sol";
import {ProtectedPerp} from "../src/ProtectedPerp.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

interface IAuth {
  function authorise(address who, bool ok) external;
}

/// @notice One-button protected perps: redeploy ConfidentialPerp + ContingentHedge with authorised `…For` entry
///         points, deploy the ProtectedPerp router, rewire permissions (old contracts revoked), seed the house pool.
contract DeployProtected is Script {
  address constant USDG = 0x766f287682ecfbD8f97551727684c7d7aD67a53f;
  address constant CUSDG = 0xd8f57E64bc235D4bceF8D2f791BDf46908408F94;
  address constant COLLATERAL = 0x4E4cb1b3B326C79FDFD51E14C26C9bDA7a5F5898;
  address constant PM = 0xA39438870296a652A268B7A187C5a540bf89cD36;
  address constant MARKET = 0xD81751083861194276BC401Fc94052De0ea3A97a;
  address constant VAULT = 0xB73fF66E6768eC894BaF56E48e93dBBaAD745DCf;
  address constant NFT = 0xA526FADAA46544da9b54EC97Ab7e1B80DE00a542;
  address constant ROUTER = 0xF0573896166052659A90Fa3626A0ff36637353CF;
  address constant ETH_FEED = 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165; // Chainlink ETH/USD
  bytes32 constant EVENT_ID = 0x382b22a5b69cca0d9052d576a47a70e809027ec9873547a993a8c9cf2d0e5295; // ETH ≥ $2,500

  address constant OLD_PERP = 0x736C33198D8f3289494103dd311423E6C50aE730;
  address constant OLD_HEDGE = 0xc68d7380cf5Dad89cf76FD4b08D7e4D991e9D0df;

  function run() external {
    uint256 seed = vm.envOr("HOUSE_SEED", uint256(100_000e6));
    vm.startBroadcast();

    ConfidentialPerp perp = new ConfidentialPerp(USDG, CUSDG, COLLATERAL, ETH_FEED);
    ContingentHedge hedge = new ContingentHedge(MARKET, COLLATERAL, PM, CUSDG, VAULT, NFT, ROUTER);
    ProtectedPerp protected = new ProtectedPerp(address(perp), address(hedge), EVENT_ID);

    // perp: releaseTo on close + lock collateral on open
    IAuth(CUSDG).authorise(address(perp), true);
    IAuth(COLLATERAL).authorise(address(perp), true);
    IAuth(CUSDG).authorise(OLD_PERP, false);
    IAuth(COLLATERAL).authorise(OLD_PERP, false);

    // hedge: everywhere the orchestrator acts
    address[6] memory targets = [CUSDG, COLLATERAL, PM, VAULT, NFT, ROUTER];
    for (uint256 i; i < targets.length; i++) {
      IAuth(targets[i]).authorise(address(hedge), true);
      IAuth(targets[i]).authorise(OLD_HEDGE, false);
    }

    // router may open on a trader's behalf
    perp.authorise(address(protected), true);
    hedge.authorise(address(protected), true);

    // house pool
    MockUSDG(USDG).mint(msg.sender, seed);
    MockUSDG(USDG).approve(address(perp), seed);
    perp.deposit(seed);

    vm.stopBroadcast();
    console.log("ConfidentialPerp:", address(perp));
    console.log("ContingentHedge:", address(hedge));
    console.log("ProtectedPerp:", address(protected));
  }
}
