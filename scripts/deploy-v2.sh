#!/usr/bin/env bash
# Testnet only. Deploys V2 vault (Guard permits) on a fresh faucet account and wires owner/agent/guard.
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER=${OWNER:?OWNER=you.testnet}; S=${S:-$(date +%s | tail -c 5)}
VAULT=${VAULT:-stashway-v2-$S.testnet}; NEWBIE=${NEWBIE:-stashway-newbie-$S.testnet}
case "$OWNER$VAULT" in *.near) echo "testnet only"; exit 1;; esac
run(){ "$@" 2>&1 | grep -E "Transaction ID|Error|panicked|public key:" || true; }
(cd contract && cargo near build non-reproducible-wasm --no-abi >/dev/null 2>&1)
for a in $VAULT $NEWBIE; do near account create-account sponsor-by-faucet-service $a autogenerate-new-keypair save-to-legacy-keychain network-config testnet create >/dev/null 2>&1; done
sleep 3
run near contract deploy $VAULT use-file contract/target/near/stashway_vault.wasm with-init-call new json-args "{\"owner\":\"$OWNER\",\"per_tx_cap\":\"1000000000000000000000000\",\"daily_cap\":\"2000000000000000000000000\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
call(){ run near contract call-function as-transaction $VAULT "$1" json-args "$2" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $OWNER network-config testnet sign-with-legacy-keychain send; }
call allow "{\"receiver\":\"$OWNER\"}"; call allow "{\"receiver\":\"$NEWBIE\"}"
GUARD=$(node -e 'import("./guard/guard.mjs").then(g=>console.log(g.guardKey().pubB64))')
call set_guard "{\"guard_pk\":\"$GUARD\"}"
near account add-key $VAULT grant-function-call-access --allowance "0.25 NEAR" --contract-account-id $VAULT --function-names agent_transfer autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-legacy-keychain send >/dev/null 2>&1
FULL=$(basename $(ls ~/.near-credentials/testnet/$VAULT.json) .json); PK=$(ls ~/.near-credentials/testnet/$VAULT/ | sed "s/.json//;s/_/:/" | grep -v "$(jq -r .public_key ~/.near-credentials/testnet/$VAULT.json)")
call set_agent "{\"agent\":null,\"agent_key\":\"$PK\"}"
cat > .env.testnet <<EOF
VAULT=$VAULT
OWNER=$OWNER
NEWBIE=$NEWBIE
AGENT_ID=$PK
AGENT_KEY_FILE=$HOME/.near-credentials/testnet/$VAULT/${PK/:/_}.json
EOF
cat .env.testnet
