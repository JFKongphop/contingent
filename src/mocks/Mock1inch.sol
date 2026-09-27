// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAquaLiquiditySource, IOneInchRouter} from "../SettlementRouter.sol";

/// @title MockAquaSource - stands in for 1inch Aqua non-custodial shared liquidity
/// @notice Holds USDG and hands it out on request. On Arbitrum this is replaced by a real Aqua
///         liquidity source pulling from shared virtual balances.
contract MockAquaSource is IAquaLiquiditySource {
  IERC20 public immutable usdg;

  constructor(address usdg_) {
    usdg = IERC20(usdg_);
  }

  function provideUSDG(address to, uint256 amount) external override returns (uint256 provided) {
    usdg.transfer(to, amount);
    return amount;
  }
}

/// @title MockOneInchRouter - stands in for the 1inch aggregation router (fixed 1:1 rate)
contract MockOneInchRouter is IOneInchRouter {
  function swap(address srcToken, address dstToken, uint256 amount, uint256, /* minReturn */ bytes calldata /* data */ )
    external
    override
    returns (uint256 returnAmount)
  {
    IERC20(srcToken).transferFrom(msg.sender, address(this), amount);
    returnAmount = amount; // 1:1 for the test
    IERC20(dstToken).transfer(msg.sender, returnAmount);
  }
}
