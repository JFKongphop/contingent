// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {CofheTest} from "@cofhe/foundry-plugin/contracts/CofheTest.sol";
import {CofheClient} from "@cofhe/foundry-plugin/contracts/CofheClient.sol";
import {externalEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {ConfidentialUSDG} from "../src/ConfidentialUSDG.sol";
import {ConfidentialCollateral} from "../src/ConfidentialCollateral.sol";

contract CollateralTest is CofheTest {
  MockUSDG usdg;
  ConfidentialUSDG cusdg;
  ConfidentialCollateral vault;
  CofheClient bob;
  address user;

  function setUp() public {
    deployMocks();
    bob = createCofheClient();
    bob.connect(0xB0B);
    user = bob.account();

    usdg = new MockUSDG();
    cusdg = new ConfidentialUSDG(address(usdg));
    vault = new ConfidentialCollateral(address(cusdg));

    usdg.mint(user, 1_000e6);
    vm.prank(user);
    usdg.approve(address(cusdg), type(uint256).max);
  }

  function test_wrap() public {
    vm.prank(user);
    cusdg.wrap(1_000e6);
    expectPlaintext(cusdg.confidentialBalanceOf(user), 1_000e6);
    assertEq(usdg.balanceOf(address(cusdg)), 1_000e6);
    assertEq(cusdg.totalWrapped(), 1_000e6);
  }

  function test_depositViaTransferAndCall() public {
    vm.prank(user);
    cusdg.wrap(1_000e6);

    (externalEuint64 h, bytes memory proof) = bob.createExternalEuint64(600e6, address(cusdg));
    vm.prank(user);
    cusdg.confidentialTransferAndCall(address(vault), h, proof, "");

    expectPlaintext(cusdg.confidentialBalanceOf(user), 400e6);
    expectPlaintext(cusdg.confidentialBalanceOf(address(vault)), 600e6);
    vm.prank(user);
    expectPlaintext(vault.myCollateral(), 600e6);
  }

  function test_withdrawClamped() public {
    vm.prank(user);
    cusdg.wrap(1_000e6);
    (externalEuint64 h, bytes memory proof) = bob.createExternalEuint64(600e6, address(cusdg));
    vm.prank(user);
    cusdg.confidentialTransferAndCall(address(vault), h, proof, "");

    // withdraw 200 back
    (externalEuint64 w, bytes memory wp) = bob.createExternalEuint64(200e6, address(vault));
    vm.prank(user);
    vault.withdraw(w, wp);

    vm.prank(user);
    expectPlaintext(vault.myCollateral(), 400e6);
    expectPlaintext(cusdg.confidentialBalanceOf(user), 600e6); // 400 left + 200 back
  }
}
