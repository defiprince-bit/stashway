#!/usr/bin/env bash
# Testnet only. Real panic -> agent blocked -> recovery with a fresh agent key. Film this LAST.
set -euo pipefail; cd "$(dirname "$0")/.."; node arena/panic.mjs
