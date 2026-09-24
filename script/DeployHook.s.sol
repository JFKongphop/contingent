// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {EventHook} from "../src/EventHook.sol";

/// @notice Mines a CREATE2 salt and deploys the EventHook against an already-deployed EventMarket.
/// Env: POOL_MANAGER, EVENT_MARKET
contract DeployHook is Script {
  function run() external {
    address poolManager = vm.envAddress("POOL_MANAGER");
    address market = vm.envAddress("EVENT_MARKET");

    uint160 flags = uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
    bytes memory args = abi.encode(IPoolManager(poolManager), market);
    (address hookAddr, bytes32 salt) = HookMiner.find(CREATE2_FACTORY, flags, type(EventHook).creationCode, args);

    vm.startBroadcast();
    EventHook hook = new EventHook{salt: salt}(IPoolManager(poolManager), market);
    vm.stopBroadcast();

    require(address(hook) == hookAddr, "hook address mismatch");
    console.log("EventHook:", address(hook));
  }
}
