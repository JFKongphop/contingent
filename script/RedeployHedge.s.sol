// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ContingentHedge} from "../src/ContingentHedge.sol";

interface IAuth {
  function authorise(address who, bool ok) external;
}

/// @notice Redeploy ContingentHedge (premium-first cover fix) against the live stack, authorise the new
///         orchestrator everywhere and revoke the old one.
contract RedeployHedge is Script {
  address constant MARKET = 0xD81751083861194276BC401Fc94052De0ea3A97a;
  address constant COLLATERAL = 0x4E4cb1b3B326C79FDFD51E14C26C9bDA7a5F5898;
  address constant PM = 0xA39438870296a652A268B7A187C5a540bf89cD36;
  address constant CUSDG = 0xd8f57E64bc235D4bceF8D2f791BDf46908408F94;
  address constant VAULT = 0xB73fF66E6768eC894BaF56E48e93dBBaAD745DCf;
  address constant NFT = 0xA526FADAA46544da9b54EC97Ab7e1B80DE00a542;
  address constant ROUTER = 0xF0573896166052659A90Fa3626A0ff36637353CF;
  address constant OLD_HEDGE = 0x71Eb2B20e2666EbB510EbE4e7EEBE6D1125EB39C;

  function run() external {
    vm.startBroadcast();
    ContingentHedge hedge = new ContingentHedge(MARKET, COLLATERAL, PM, CUSDG, VAULT, NFT, ROUTER);

    address[6] memory targets = [CUSDG, COLLATERAL, PM, VAULT, NFT, ROUTER];
    for (uint256 i; i < targets.length; i++) {
      IAuth(targets[i]).authorise(address(hedge), true);
      IAuth(targets[i]).authorise(OLD_HEDGE, false);
    }
    vm.stopBroadcast();
    console.log("ContingentHedge:", address(hedge));
  }
}
