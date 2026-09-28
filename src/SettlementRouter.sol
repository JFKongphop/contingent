// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISettlement} from "./interfaces/ISettlement.sol";
import {UnderwriterVault} from "./UnderwriterVault.sol";

/// @dev Minimal 1inch aggregation-router swap interface (subset). On Arbitrum this is the canonical
///      1inch router; `swap` exchanges a source asset for USDG using off-chain-built calldata (`data`).
interface IOneInchRouter {
  function swap(address srcToken, address dstToken, uint256 amount, uint256 minReturn, bytes calldata data)
    external
    returns (uint256 returnAmount);
}

/// @dev Non-custodial 1inch Aqua liquidity source. Aqua's shared virtual balances back the payout
///      pool: the router pulls USDG liquidity on demand rather than pre-funding a custodial vault.
interface IAquaLiquiditySource {
  function provideUSDG(address to, uint256 amount) external returns (uint256 provided);
}

/// @title SettlementRouter - routes winning USDG payouts (1inch Aqua / SwapVM integration point)
/// @notice Sits between `ContingentHedge` and the money. By default it pays the winner from the
///         `UnderwriterVault` reserve (LP capital, bounded per-event by capacity). When configured, it
///         can instead **pull USDG from a 1inch Aqua** shared-liquidity source or **swap a reserve
///         asset into USDG via the 1inch aggregation router**, then top the vault up so the bounded
///         `payWinner` still runs. This is Contingent's 1inch settlement seam; the direct vault path
///         keeps the MVP self-contained and testable.
///
///         Full Aqua/SwapVM wiring reuses the vendored 1inch aqua + swap-vm libraries (as in the
///         sibling Airbag project); the typed interfaces here are the integration seams.
contract SettlementRouter is ISettlement {
  using SafeERC20 for IERC20;

  UnderwriterVault public immutable vault;
  IERC20 public immutable usdg;
  address public immutable owner;

  mapping(address => bool) public authorised; // the Hedge contract

  // ── optional 1inch routing config ──
  IOneInchRouter public oneInch;
  IAquaLiquiditySource public aqua;
  IERC20 public reserveAsset;

  event Settled(bytes32 indexed eventId, address indexed to, uint256 amount, uint8 route); // 0=vault
  event ToppedUp(uint256 amount, uint8 source); // 1=1inch swap 2=aqua
  event RoutingConfigured(address oneInch, address aqua, address reserveAsset);

  modifier onlyOwner() {
    require(msg.sender == owner, "Router: not owner");
    _;
  }

  modifier onlyAuthorised() {
    require(authorised[msg.sender] || msg.sender == owner, "Router: not authorised");
    _;
  }

  constructor(address vault_) {
    vault = UnderwriterVault(vault_);
    usdg = IERC20(UnderwriterVault(vault_).usdg());
    owner = msg.sender;
  }

  function authorise(address account, bool ok) external onlyOwner {
    authorised[account] = ok;
  }

  function configureRouting(address oneInch_, address aqua_, address reserveAsset_) external onlyOwner {
    oneInch = IOneInchRouter(oneInch_);
    aqua = IAquaLiquiditySource(aqua_);
    reserveAsset = IERC20(reserveAsset_);
    emit RoutingConfigured(oneInch_, aqua_, reserveAsset_);
  }

  /// @inheritdoc ISettlement
  /// @notice Default route: pay the winner from the underwriter vault reserve.
  function settle(bytes32 eventId, address to, uint256 amount) external onlyAuthorised {
    if (amount == 0) return;
    vault.payWinner(eventId, to, amount);
    emit Settled(eventId, to, amount, 0);
  }

  /// @notice Top up the vault reserve by pulling USDG from a 1inch **Aqua** shared-liquidity source.
  ///         Payouts always run through the bounded vault; this just refills it non-custodially, so a
  ///         hedger is always fillable without pre-parking idle LP capital.
  function topUpFromAqua(uint256 amount) external onlyAuthorised returns (uint256 funded) {
    require(address(aqua) != address(0), "Router: no aqua");
    funded = aqua.provideUSDG(address(this), amount);
    require(funded >= amount, "Router: aqua short");
    usdg.forceApprove(address(vault), funded);
    vault.fund(funded);
    emit ToppedUp(funded, 2);
  }

  /// @notice Top up the vault reserve by swapping a reserve asset into USDG via the **1inch**
  ///         aggregation router (calldata built off-chain).
  function topUpViaSwap(uint256 srcAmount, uint256 minReturn, bytes calldata data)
    external
    onlyAuthorised
    returns (uint256 funded)
  {
    require(address(oneInch) != address(0) && address(reserveAsset) != address(0), "Router: no swap route");
    reserveAsset.forceApprove(address(oneInch), srcAmount);
    funded = oneInch.swap(address(reserveAsset), address(usdg), srcAmount, minReturn, data);
    require(funded >= minReturn, "Router: swap short");
    usdg.forceApprove(address(vault), funded);
    vault.fund(funded);
    emit ToppedUp(funded, 1);
  }
}
