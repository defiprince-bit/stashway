# Stashway V2 — P0 cut plan (finish Thu 5 Nov 2026, WAT)
**Pitch:** The AI suggests, the Guard checks, the contract decides. Testnet only, $0.

## Keep (V1 leash)
per_tx_cap, daily_cap, allowlist, panic() (freezes + deletes agent key), function-call agent key.

## Add (P0)
1. **Counterparty Guard** (`guard/`, Node, deterministic, no AI): ALLOW / WARN / BLOCK + reasons + evidence.
   Signals: shared blocklist (seed `evil.testnet`), account exists (RPC), is_contract + code_hash (RPC),
   age (nearblocks API, soft-fail), prior vault relationship (local event log). Missing data → soft-fail to WARN, never ALLOW-by-default for unknowns. The AI never authorizes.
2. **Signed Guard Permit**: owner registers Guard ed25519 pubkey on the vault. Permit message
   `stashway-permit:v1|vault|agent|receiver|amount_yocto|nonce|expiry_ns|ALLOW`, verified on-chain with `env::ed25519_verify`; nonce consumed; caps/allowlist/frozen/agent still enforced.
   WARN → no permit until owner calls `owner_confirm` (pre-approves that exact intent). BLOCK → no permit.
3. **Intent locking**: receiver + amount are inside the signed bytes; change either → `ERR_BAD_PERMIT`.
4. **Agent wrapper**: asks Guard first; submits only on ALLOW+permit; WARN waits; BLOCK refuses off-chain. Output labels `OFFCHAIN_REFUSAL` vs `ONCHAIN_REJECT` vs `ONCHAIN_OK`; tx hashes only from RPC.
5. **Attack Arena + security event log** (`web/`): static page, nav **Vault · Policy · Guard · Arena · Events · Panic**; 5 scenarios recorded from real testnet runs (`web/results.json`) with decision, reasons, permit status, nearblocks links.
6. **Trust Drift (P1-min)**: Guard stores last code_hash per receiver; change → WARN.

## Brand
Logo = **mark B** (vault-C metaball), `/workspace/stashway/brand/logo/mark-b-*.jpg`. Not the leash ring.

## Out of scope (Thu)
FT tokens, withdraw_delay, NEAR AI, Vercel hosting (optional later, free, no secrets), mainnet.

## Order
V2-PLAN → contract permit + tests → Guard → redeploy (new faucet account) → Arena run + page → README.
