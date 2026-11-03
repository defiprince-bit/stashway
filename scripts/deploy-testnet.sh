#!/usr/bin/env bash
# Testnet only. Needs near-cli-rs (free): cargo install near-cli-rs  (or npx near-cli-rs)
# Creates FREE faucet-funded accounts; keys stay in your local keychain, never in git.
set -euo pipefail
OWNER=${OWNER:?set OWNER=yourname.testnet}
VAULT=${VAULT:-stashway-$RANDOM.testnet}
SAVINGS=${SAVINGS:-$OWNER}
case "$OWNER$VAULT" in *.near*) echo "testnet only"; exit 1;; esac
cd "$(dirname "$0")/../contract"
cargo near build non-reproducible-wasm --no-abi 2>/dev/null || cargo build --release --target wasm32-unknown-unknown
WASM=$(ls target/near/*.wasm 2>/dev/null || ls target/wasm32-unknown-unknown/release/stashway_vault.wasm)
near account create-account sponsor-by-faucet-service $VAULT autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
near contract deploy $VAULT use-file $WASM with-init-call new json-args "{\"owner\":\"$OWNER\",\"per_tx_cap\":\"1000000000000000000000000\",\"daily_cap\":\"2000000000000000000000000\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
near contract call-function as-transaction $VAULT allow json-args "{\"receiver\":\"$SAVINGS\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $OWNER network-config testnet sign-with-legacy-keychain send
echo "Next: add the agent function-call key (see README step 3). VAULT=$VAULT"
