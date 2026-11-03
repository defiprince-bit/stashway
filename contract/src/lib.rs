//! Stashway vault: "The AI suggests, the contract decides."
use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::store::{IterableSet, LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PublicKey};

const DAY_NS: u64 = 86_400_000_000_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    /// Agent identity: either a separate account, or a function-call key on this vault account.
    agent: Option<AccountId>,
    agent_key: Option<PublicKey>,
    per_tx_cap: NearToken,
    daily_cap: NearToken,
    allowlist: IterableSet<AccountId>,
    spent: LookupMap<u64, u128>, // day index -> yocto spent
    frozen: bool,
    /// Counterparty Guard ed25519 public key (raw 32 bytes). Required for agent transfers.
    guard_pk: Option<Vec<u8>>,
    used_nonces: LookupSet<u64>,
    /// sha256(permit message) pre-approved by the owner after a Guard WARN.
    confirmed: LookupSet<Vec<u8>>,
}

#[near]
impl Vault {
    #[init]
    pub fn new(owner: AccountId, per_tx_cap: NearToken, daily_cap: NearToken) -> Self {
        require!(per_tx_cap <= daily_cap, "per_tx_cap must be <= daily_cap");
        Self {
            owner,
            agent: None,
            agent_key: None,
            per_tx_cap,
            daily_cap,
            allowlist: IterableSet::new(b"a"),
            spent: LookupMap::new(b"s"),
            frozen: false,
            guard_pk: None,
            used_nonces: LookupSet::new(b"n"),
            confirmed: LookupSet::new(b"c"),
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
    }

    /// Identity string the Guard binds into the permit.
    fn agent_id(&self) -> String {
        let pred = env::predecessor_account_id();
        if self.agent.as_ref() == Some(&pred) {
            pred.to_string()
        } else {
            near_sdk::serde_json::to_string(&env::signer_account_pk()).unwrap().trim_matches('"').to_string()
        }
    }

    fn permit_msg(&self, receiver: &AccountId, amount: NearToken, nonce: u64, expiry: u64) -> String {
        format!("stashway-permit:v1|{}|{}|{}|{}|{}|{}|ALLOW",
            env::current_account_id(), self.agent_id(), receiver, amount.as_yoctonear(), nonce, expiry)
    }

    fn is_agent(&self) -> bool {
        let pred = env::predecessor_account_id();
        if self.agent.as_ref() == Some(&pred) {
            return true;
        }
        pred == env::current_account_id()
            && self.agent_key.as_ref() == Some(&env::signer_account_pk())
    }

    // ---------- owner ----------
    pub fn set_policy(&mut self, per_tx_cap: NearToken, daily_cap: NearToken) {
        self.assert_owner();
        require!(per_tx_cap <= daily_cap, "per_tx_cap must be <= daily_cap");
        self.per_tx_cap = per_tx_cap;
        self.daily_cap = daily_cap;
    }
    pub fn allow(&mut self, receiver: AccountId) { self.assert_owner(); self.allowlist.insert(receiver); }
    pub fn disallow(&mut self, receiver: AccountId) { self.assert_owner(); self.allowlist.remove(&receiver); }
    pub fn set_agent(&mut self, agent: Option<AccountId>, agent_key: Option<PublicKey>) {
        self.assert_owner();
        self.agent = agent;
        self.agent_key = agent_key;
        self.frozen = false;
    }
    /// Register the Guard's raw ed25519 public key (base64 of 32 bytes).
    pub fn set_guard(&mut self, guard_pk: Base64VecU8) {
        self.assert_owner();
        require!(guard_pk.0.len() == 32, "ERR_GUARD_PK_LEN");
        self.guard_pk = Some(guard_pk.0);
    }

    /// Owner pre-approves one exact intent after a Guard WARN (agent is the signer pk string or account id).
    pub fn owner_confirm(&mut self, agent: String, receiver: AccountId, amount: NearToken, nonce: U64, expiry: U64) {
        self.assert_owner();
        let msg = format!("stashway-permit:v1|{}|{}|{}|{}|{}|{}|ALLOW",
            env::current_account_id(), agent, receiver, amount.as_yoctonear(), nonce.0, expiry.0);
        self.confirmed.insert(env::sha256(msg.as_bytes()));
        env::log_str(&format!("STASHWAY_OWNER_CONFIRM nonce={}", nonce.0));
    }

    pub fn unfreeze(&mut self) { self.assert_owner(); self.frozen = false; }

    /// Freeze all agent actions and, if the agent is a key on this account, delete it.
    pub fn panic(&mut self) -> Option<Promise> {
        self.assert_owner();
        self.frozen = true;
        self.agent = None;
        env::log_str("STASHWAY_PANIC: agent frozen");
        self.agent_key
            .take()
            .map(|pk| Promise::new(env::current_account_id()).delete_key(pk))
    }

    /// Owner can always withdraw (no caps).
    pub fn owner_withdraw(&mut self, amount: NearToken) -> Promise {
        self.assert_owner();
        Promise::new(self.owner.clone()).transfer(amount)
    }

    #[payable]
    pub fn deposit(&mut self) {}

    // ---------- agent ----------
    /// Agent transfer: needs a valid, unused, unexpired Guard permit (or owner confirmation)
    /// bound to this exact vault/agent/receiver/amount, AND must pass the policy.
    pub fn agent_transfer(&mut self, receiver: AccountId, amount: NearToken, nonce: U64, expiry: U64,
                          permit_sig: Option<Base64VecU8>) -> Promise {
        require!(!self.frozen, "ERR_FROZEN");
        require!(self.is_agent(), "ERR_NOT_AGENT");
        require!(env::block_timestamp() <= expiry.0, "ERR_PERMIT_EXPIRED");
        require!(!self.used_nonces.contains(&nonce.0), "ERR_NONCE_USED");
        let msg = self.permit_msg(&receiver, amount, nonce.0, expiry.0);
        let ok = match &permit_sig {
            Some(sig) => {
                let pk = self.guard_pk.as_ref().unwrap_or_else(|| env::panic_str("ERR_NO_GUARD"));
                let sig: [u8; 64] = sig.0.as_slice().try_into().unwrap_or_else(|_| env::panic_str("ERR_BAD_PERMIT"));
                let pk: [u8; 32] = pk.as_slice().try_into().unwrap();
                env::ed25519_verify(&sig, msg.as_bytes(), &pk)
            }
            None => self.confirmed.remove(&env::sha256(msg.as_bytes())),
        };
        require!(ok, if permit_sig.is_some() { "ERR_BAD_PERMIT" } else { "ERR_NO_PERMIT" });
        self.used_nonces.insert(nonce.0);
        require!(amount.as_yoctonear() > 0, "ERR_ZERO");
        require!(self.allowlist.contains(&receiver), "ERR_NOT_ALLOWLISTED");
        require!(amount <= self.per_tx_cap, "ERR_OVER_PER_TX_CAP");
        let day = env::block_timestamp() / DAY_NS;
        let spent = self.spent.get(&day).copied().unwrap_or(0);
        let new_spent = spent + amount.as_yoctonear();
        require!(new_spent <= self.daily_cap.as_yoctonear(), "ERR_OVER_DAILY_CAP");
        self.spent.insert(day, new_spent);
        env::log_str(&format!("STASHWAY_AGENT_TRANSFER {} -> {}", amount, receiver));
        Promise::new(receiver).transfer(amount)
    }

    // ---------- views ----------
    pub fn get_policy(&self) -> (NearToken, NearToken, bool, Option<AccountId>) {
        (self.per_tx_cap, self.daily_cap, self.frozen, self.agent.clone())
    }
    pub fn get_owner(&self) -> AccountId { self.owner.clone() }
    pub fn get_allowlist(&self) -> Vec<AccountId> { self.allowlist.iter().cloned().collect() }
    pub fn get_guard(&self) -> Option<Base64VecU8> { self.guard_pk.clone().map(Base64VecU8) }
    pub fn is_nonce_used(&self, nonce: U64) -> bool { self.used_nonces.contains(&nonce.0) }
    pub fn spent_today(&self) -> NearToken {
        NearToken::from_yoctonear(self.spent.get(&(env::block_timestamp() / DAY_NS)).copied().unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }
    fn guard() -> SigningKey { SigningKey::from_bytes(&[7u8; 32]) }
    fn ctx(pred: &str) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("vault.testnet")).predecessor_account_id(acc(pred))
            .account_balance(NearToken::from_near(100)).block_timestamp(1_000);
        testing_env!(b.build());
    }
    fn setup() -> Vault {
        ctx("owner.testnet");
        let mut v = Vault::new(acc("owner.testnet"), NearToken::from_near(1), NearToken::from_near(2));
        v.allow(acc("savings.testnet"));
        v.set_agent(Some(acc("agent.testnet")), None);
        v.set_guard(Base64VecU8(guard().verifying_key().to_bytes().to_vec()));
        ctx("agent.testnet");
        v
    }
    fn msg(r: &str, n: u128, nonce: u64) -> String {
        format!("stashway-permit:v1|vault.testnet|agent.testnet|{}|{}|{}|{}|ALLOW", r, NearToken::from_near(n).as_yoctonear(), nonce, 10_000)
    }
    fn sig(m: &str) -> Option<Base64VecU8> { Some(Base64VecU8(guard().sign(m.as_bytes()).to_bytes().to_vec())) }
    fn send(v: &mut Vault, r: &str, n: u128, nonce: u64, s: Option<Base64VecU8>) {
        v.agent_transfer(acc(r), NearToken::from_near(n), U64(nonce), U64(10_000), s);
    }
    fn ok(v: &mut Vault, r: &str, n: u128, nonce: u64) { let s = sig(&msg(r, n, nonce)); send(v, r, n, nonce, s); }

    #[test]
    fn happy_path_with_permit() { let mut v = setup(); ok(&mut v, "savings.testnet", 1, 1); assert!(v.is_nonce_used(U64(1))); }

    #[test] #[should_panic(expected = "ERR_NO_PERMIT")]
    fn no_permit_rejected() { let mut v = setup(); send(&mut v, "savings.testnet", 1, 1, None); }

    #[test] #[should_panic(expected = "ERR_BAD_PERMIT")]
    fn intent_lock_amount_changed() { let mut v = setup(); let s = sig(&msg("savings.testnet", 1, 1)); send(&mut v, "savings.testnet", 2, 1, s); }

    #[test] #[should_panic(expected = "ERR_BAD_PERMIT")]
    fn intent_lock_receiver_changed() { let mut v = setup(); let s = sig(&msg("savings.testnet", 1, 1)); send(&mut v, "evil.testnet", 1, 1, s); }

    #[test] #[should_panic(expected = "ERR_BAD_PERMIT")]
    fn forged_permit_wrong_key() {
        let mut v = setup();
        let s = Some(Base64VecU8(SigningKey::from_bytes(&[9u8; 32]).sign(msg("savings.testnet", 1, 1).as_bytes()).to_bytes().to_vec()));
        send(&mut v, "savings.testnet", 1, 1, s);
    }

    #[test] #[should_panic(expected = "ERR_NONCE_USED")]
    fn replay_rejected() { let mut v = setup(); ok(&mut v, "savings.testnet", 1, 1); ok(&mut v, "savings.testnet", 1, 1); }

    #[test] #[should_panic(expected = "ERR_PERMIT_EXPIRED")]
    fn expired_rejected() {
        let mut v = setup();
        let s = sig(&msg("savings.testnet", 1, 1));
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("vault.testnet")).predecessor_account_id(acc("agent.testnet")).block_timestamp(20_000);
        testing_env!(b.build());
        send(&mut v, "savings.testnet", 1, 1, s);
    }

    #[test]
    fn owner_confirm_allows_warn_intent_once() {
        let mut v = setup();
        ctx("owner.testnet");
        v.owner_confirm("agent.testnet".into(), acc("savings.testnet"), NearToken::from_near(1), U64(5), U64(10_000));
        ctx("agent.testnet");
        send(&mut v, "savings.testnet", 1, 5, None);
    }

    #[test] #[should_panic(expected = "ERR_NOT_ALLOWLISTED")]
    fn red_team_valid_permit_still_needs_allowlist() { let mut v = setup(); ok(&mut v, "evil.testnet", 1, 1); }

    #[test] #[should_panic(expected = "ERR_OVER_PER_TX_CAP")]
    fn over_per_tx_cap() { let mut v = setup(); ok(&mut v, "savings.testnet", 5, 1); }

    #[test] #[should_panic(expected = "ERR_OVER_DAILY_CAP")]
    fn over_daily_cap() { let mut v = setup(); ok(&mut v, "savings.testnet", 1, 1); ok(&mut v, "savings.testnet", 1, 2); ok(&mut v, "savings.testnet", 1, 3); }

    #[test] #[should_panic(expected = "ERR_NOT_AGENT")]
    fn stranger_rejected() { let mut v = setup(); ctx("rando.testnet"); ok(&mut v, "savings.testnet", 1, 1); }

    #[test] #[should_panic(expected = "ERR_FROZEN")]
    fn panic_freezes_agent() { let mut v = setup(); ctx("owner.testnet"); v.panic(); ctx("agent.testnet"); ok(&mut v, "savings.testnet", 1, 1); }

    #[test] #[should_panic(expected = "ERR_NOT_OWNER")]
    fn agent_cannot_change_policy() { let mut v = setup(); v.set_policy(NearToken::from_near(100), NearToken::from_near(100)); }

    #[test] #[should_panic(expected = "ERR_NOT_OWNER")]
    fn agent_cannot_swap_guard() { let mut v = setup(); v.set_guard(Base64VecU8(vec![0u8; 32])); }
}
