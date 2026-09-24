// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";
import {ConfidentialUSDG} from "../src/ConfidentialUSDG.sol";
import {ConfidentialCollateral} from "../src/ConfidentialCollateral.sol";
import {ConfidentialPositionManager} from "../src/ConfidentialPositionManager.sol";
import {EventMarket} from "../src/EventMarket.sol";
import {UnderwriterVault} from "../src/UnderwriterVault.sol";
import {SettlementRouter} from "../src/SettlementRouter.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {ContingentHedge} from "../src/ContingentHedge.sol";
import {PriceThresholdResolver} from "../src/resolvers/PriceThresholdResolver.sol";
import {EventHook} from "../src/EventHook.sol";

/// @title Deploy - full Contingent stack on Arbitrum Sepolia (CoFHE is live at chain 421614)
/// @notice Deploys the confidential-hedging core, wires authorisations, seeds a sample depeg market,
///         and (if a PoolManager is provided) mines + deploys the v4 EventHook.
///
/// Env (all optional; mocks are deployed when unset — handy on a fresh testnet):
///   USDG          canonical USDG ERC-20 (else a MockUSDG is deployed)
///   CHAINLINK_FEED price feed for the sample depeg market (else a MockAggregatorV3 @ $1.00)
///   POOL_MANAGER  Uniswap v4 PoolManager (Arbitrum Sepolia: 0x...); skip the hook if unset
contract Deploy is Script {
  // CREATE2_FACTORY is inherited from forge-std's Script.

  // deployed addresses held as state to keep run()'s stack shallow (avoids via-ir stack-too-deep)
  MockUSDG usdg;
  ConfidentialUSDG cusdg;
  ConfidentialCollateral collateralVault;
  ConfidentialPositionManager pm;
  EventMarket market;
  UnderwriterVault vault;
  SettlementRouter router;
  PositionNFT nft;
  PriceThresholdResolver resolver;
  ContingentHedge hedge;
  EventHook hook;

  bytes32 constant EVENT_ID = keccak256("USDC depeg < $0.97");

  function run() external {
    address usdgAddr = vm.envOr("USDG", address(0));
    address feedAddr = vm.envOr("CHAINLINK_FEED", address(0));
    address poolManager = vm.envOr("POOL_MANAGER", address(0));
    uint256 seedCapacity = vm.envOr("SEED_CAPACITY", uint256(100_000e6));

    vm.startBroadcast();
    (usdgAddr, feedAddr) = _deps(usdgAddr, feedAddr);
    _deployCore(usdgAddr);
    _wire();
    _seedMarket(feedAddr, seedCapacity, usdgAddr == address(usdg)); // mock iff we deployed it
    vm.stopBroadcast();

    _log();

    if (poolManager != address(0)) _deployHook(poolManager);
  }

  function _deps(address usdgAddr, address feedAddr) internal returns (address, address) {
    if (usdgAddr == address(0)) {
      usdg = new MockUSDG();
      usdgAddr = address(usdg);
      console.log("MockUSDG:", usdgAddr);
    }
    if (feedAddr == address(0)) {
      feedAddr = address(new MockAggregatorV3(8, 1_00_000_000)); // $1.00
      console.log("MockAggregatorV3:", feedAddr);
    }
    return (usdgAddr, feedAddr);
  }

  function _deployCore(address usdgAddr) internal {
    cusdg = new ConfidentialUSDG(usdgAddr);
    collateralVault = new ConfidentialCollateral(address(cusdg));
    pm = new ConfidentialPositionManager();
    market = new EventMarket();
    vault = new UnderwriterVault(usdgAddr);
    router = new SettlementRouter(address(vault));
    nft = new PositionNFT();
    resolver = new PriceThresholdResolver();
    hedge = new ContingentHedge(
      address(market), address(collateralVault), address(pm), address(cusdg), address(vault), address(nft), address(router)
    );
  }

  function _wire() internal {
    cusdg.authorise(address(hedge), true); // premium sweep
    collateralVault.authorise(address(hedge), true);
    pm.authorise(address(hedge), true);
    vault.authorise(address(hedge), true);
    vault.authorise(address(router), true);
    router.authorise(address(hedge), true);
    nft.authorise(address(hedge), true);
  }

  function _seedMarket(address feedAddr, uint256 seedCapacity, bool usdgIsMock) internal {
    uint64 closeTime = uint64(block.timestamp + 30 days);
    resolver.register(EVENT_ID, feedAddr, 97_000_000, true, closeTime); // YES if USDC <= $0.97
    market.createMarket(EVENT_ID, address(resolver), closeTime, 5, 95); // ~5% implied

    // seed LP capital so the market can immediately underwrite hedges (mock USDG only)
    if (usdgIsMock) {
      usdg.mint(msg.sender, seedCapacity);
      usdg.approve(address(vault), seedCapacity);
      vault.deposit(seedCapacity); // deployer is the first LP
      vault.earmark(EVENT_ID, seedCapacity); // back the sample event's payouts
      console.log("Seeded LP capacity (USDG):", seedCapacity);
    }
  }

  function _deployHook(address poolManager) internal {
    uint160 flags = uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
    bytes memory args = abi.encode(IPoolManager(poolManager), address(market));
    (address hookAddr, bytes32 salt) = HookMiner.find(CREATE2_FACTORY, flags, type(EventHook).creationCode, args);

    vm.startBroadcast();
    hook = new EventHook{salt: salt}(IPoolManager(poolManager), address(market));
    vm.stopBroadcast();

    require(address(hook) == hookAddr, "hook address mismatch");
    console.log("EventHook:", address(hook));
    console.log("PoolManager:", poolManager);
  }

  function _log() internal view {
    console.log("ConfidentialUSDG:", address(cusdg));
    console.log("ConfidentialCollateral:", address(collateralVault));
    console.log("ConfidentialPositionManager:", address(pm));
    console.log("EventMarket:", address(market));
    console.log("UnderwriterVault:", address(vault));
    console.log("PositionNFT:", address(nft));
    console.log("SettlementRouter:", address(router));
    console.log("PriceThresholdResolver:", address(resolver));
    console.log("ContingentHedge:", address(hedge));
  }
}
