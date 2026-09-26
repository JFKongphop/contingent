#!/usr/bin/env bash
# Open a fresh "ETH ≥ $2,500" event round (e.g. before a demo retake — SETTLE resolves the current one).
# Finalises the previous round to free its capacity, registers + seeds the new market (65/35), earmarks
# 100k vault capacity, points ProtectedPerp at it, and updates the frontend EVENT_ID.
#
# Usage: ./script/new-event-round.sh <round-number|auto>     (reads PRIVATE_KEY from .env)
set -euo pipefail
cd "$(dirname "$0")/.."
ROUND=${1:?usage: new-event-round.sh <round-number|auto>}
set -a; source .env; set +a
PK=$PRIVATE_KEY; [[ $PK == 0x* ]] || PK=0x$PK
R=${ARB_RPC_PUBLIC:-https://sepolia-rollup.arbitrum.io/rpc}

RESOLVER=0xd4fa6b3b391Cc75eED61427F08051E219cB46cc4
MARKET=0xD81751083861194276BC401Fc94052De0ea3A97a
VAULT=0xB73fF66E6768eC894BaF56E48e93dBBaAD745DCf
HEDGE=0x670b2dC8EEa68Cb6BA2caC4021FCE02b85C51Dcf
PROTECTED=0xf97AA238bA1e462c05863eFa9cc4E13d240Ffb2c
FEED=0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165   # Chainlink ETH/USD
CONFIG=frontend/src/config/contracts.ts

send() { cast send --rpc-url "$R" --private-key "$PK" "$@" | awk '/^status/{print $2}'; }

PREV=$(grep -o "EVENT_ID = '0x[0-9a-f]*'" "$CONFIG" | grep -o '0x[0-9a-f]*')
if [[ $ROUND == auto ]]; then   # next round after the one the frontend currently points at
  ROUND=2
  for i in $(seq 2 300); do [[ $(cast keccak "ETH >= \$2,500 (round $i)") == "$PREV" ]] && { ROUND=$((i + 1)); break; }; done
  echo "round    $ROUND (auto)"
fi
E=$(cast keccak "ETH >= \$2,500 (round $ROUND)")
CT=$(( $(date +%s) + 7*24*3600 ))
echo "previous $PREV"
echo "new      $E"

echo "finalise previous : $(send --gas-limit 1500000 $HEDGE 'finaliseEvent(bytes32)' $PREV 2>/dev/null || echo skipped)"
echo "register          : $(send $RESOLVER 'register(bytes32,address,int256,bool,uint64)' $E $FEED 250000000000 false $CT)"
echo "createMarket      : $(send $MARKET 'createMarket(bytes32,address,uint64,uint256,uint256)' $E $RESOLVER $CT 65 35)"
echo "earmark 100k      : $(send --gas-limit 1500000 $VAULT 'earmark(bytes32,uint256)' $E 100000000000)"
echo "ProtectedPerp     : $(send $PROTECTED 'setEvent(bytes32)' $E)"

sed -i '' "s/EVENT_ID = '0x[0-9a-f]*'/EVENT_ID = '$E'/" "$CONFIG"
echo "open for hedging  : $(cast call $MARKET 'isOpenForHedging(bytes32)(bool)' $E -r $R) · odds $(cast call $MARKET 'probYesBps(bytes32)(uint256)' $E -r $R) bps"
echo "frontend EVENT_ID updated → reload the app"
