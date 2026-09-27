#!/usr/bin/env bash
# Keeps the public demo usable: whenever the live "ETH ≥ $2,500" round stops being open for hedging (someone
# clicked RESOLVE on the SETTLE tab, or it expired), open the next round. The app reads the live round from
# ProtectedPerp.eventId(), so the deployed site follows automatically — no rebuild.
#
# Usage: ./script/round-keeper.sh            # check every 60 s until stopped (Ctrl-C)
#        ./script/round-keeper.sh --once     # single check (e.g. from cron)
#        INTERVAL=120 ./script/round-keeper.sh
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
PK=$PRIVATE_KEY; [[ $PK == 0x* ]] || PK=0x$PK
R=${ARB_RPC_PUBLIC:-https://sepolia-rollup.arbitrum.io/rpc}
MARKET=0xD81751083861194276BC401Fc94052De0ea3A97a
PROTECTED=0xf97AA238bA1e462c05863eFa9cc4E13d240Ffb2c
DEPLOYER=$(cast wallet address --private-key "$PK")
INTERVAL=${INTERVAL:-60}
ONCE=0; [[ ${1:-} == --once ]] && ONCE=1

check() {
  local ev open bal
  ev=$(cast call $PROTECTED 'eventId()(bytes32)' -r "$R" 2>/dev/null) || { echo "$(date +%H:%M:%S) rpc error — retry later"; return; }
  open=$(cast call $MARKET 'isOpenForHedging(bytes32)(bool)' "$ev" -r "$R" 2>/dev/null) || { echo "$(date +%H:%M:%S) rpc error — retry later"; return; }
  if [[ $open == true ]]; then
    echo "$(date +%H:%M:%S) round ${ev:0:10}… open ✓"
    return
  fi
  bal=$(cast balance "$DEPLOYER" -e -r "$R" 2>/dev/null || echo 0)
  if awk "BEGIN{exit !($bal < 0.005)}"; then
    echo "$(date +%H:%M:%S) round ${ev:0:10}… closed, but deployer has only $bal ETH — top it up"; return
  fi
  echo "$(date +%H:%M:%S) round ${ev:0:10}… closed → opening the next round"
  ./script/new-event-round.sh auto | grep -E "round|new |open for|earmark" || echo "  new round failed — will retry"
}

if [[ $ONCE == 1 ]]; then check; exit 0; fi
echo "round keeper · every ${INTERVAL}s · Ctrl-C to stop"
while true; do check; sleep "$INTERVAL"; done
