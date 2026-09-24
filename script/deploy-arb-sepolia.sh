#!/usr/bin/env bash
# Deploy the full Contingent stack to Arbitrum Sepolia (chain 421614, where Fhenix CoFHE is live).
#
# Reads from contingent/.env:
#   ARB_RPC      - Arbitrum Sepolia RPC URL   (required)
#   PRIVATE_KEY  - deployer key, 0x-prefixed  (required)
# Optional (export before running, or add to .env):
#   USDG           - canonical USDG ERC-20    (else a MockUSDG is deployed)
#   CHAINLINK_FEED - price feed for the depeg (else a MockAggregatorV3 @ $1.00)
#   POOL_MANAGER   - Uniswap v4 PoolManager   (else the v4 EventHook is skipped)
#   ARBISCAN_API_KEY - set to also verify on Arbiscan
#
# Usage:
#   ./script/deploy-arb-sepolia.sh            # simulate (no broadcast)
#   ./script/deploy-arb-sepolia.sh --broadcast
set -euo pipefail

cd "$(dirname "$0")/.."

# ── load .env ──
if [[ -f .env ]]; then
  set -a; source .env; set +a
else
  echo "error: contingent/.env not found" >&2; exit 1
fi

: "${ARB_RPC:?set ARB_RPC in .env}"
: "${PRIVATE_KEY:?set PRIVATE_KEY in .env}"

# ── flags ──
BROADCAST=""
VERIFY=""
for arg in "$@"; do
  case "$arg" in
    --broadcast) BROADCAST="--broadcast --slow" ;;
    --verify)    VERIFY="--verify" ;;
  esac
done

# auto-verify if an Arbiscan key is present and --verify was passed
if [[ -n "${VERIFY}" ]]; then
  : "${ARBISCAN_API_KEY:?set ARBISCAN_API_KEY to verify}"
  VERIFY="--verify --etherscan-api-key ${ARBISCAN_API_KEY}"
fi

DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "── Contingent → Arbitrum Sepolia (421614) ─────────────────────────"
echo "  deployer : $DEPLOYER"
echo "  rpc      : ${ARB_RPC%%\?*}"
echo "  balance  : $(cast balance "$DEPLOYER" --rpc-url "$ARB_RPC" --ether 2>/dev/null || echo '?') ETH"
echo "  mode     : ${BROADCAST:+BROADCAST}${BROADCAST:-simulate}"
echo "───────────────────────────────────────────────────────────────────"

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$ARB_RPC" \
  --private-key "$PRIVATE_KEY" \
  --gas-estimate-multiplier 300 \
  ${BROADCAST} \
  ${VERIFY} \
  -vvv
# NB: FHE ops (earmark) cost ~10x forge's simulated estimate — the multiplier prevents out-of-gas.

echo "───────────────────────────────────────────────────────────────────"
if [[ -n "$BROADCAST" ]]; then
  echo "  ✅ broadcast complete — addresses & tx hashes in the log above and in:"
  echo "     broadcast/Deploy.s.sol/421614/run-latest.json"
else
  echo "  simulation only — re-run with --broadcast to send transactions."
fi
