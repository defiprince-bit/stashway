//! Stashway vault: "The AI suggests, the contract decides."
use near_sdk::store::{IterableSet, LookupMap};
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
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
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
    pub fn agent_transfer(&mut self, receiver: AccountId, amount: NearToken) -> Promise {
        require!(!self.frozen, "ERR_FROZEN");
        require!(self.is_agent(), "ERR_NOT_AGENT");
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
    pub fn get_allowlist(&self) -> Vec<AccountId> { self.allowlist.iter().cloned().collect() }
    pub fn spent_today(&self) -> NearToken {
        NearToken::from_yoctonear(self.spent.get(&(env::block_timestamp() / DAY_NS)).copied().unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }
    fn ctx(pred: &str) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("vault.testnet")).predecessor_account_id(acc(pred))
            .account_balance(NearToken::from_near(100));
        testing_env!(b.build());
    }
    fn setup() -> Vault {
        ctx("owner.testnet");
        let mut v = Vault::new(acc("owner.testnet"), NearToken::from_near(1), NearToken::from_near(2));
        v.allow(acc("savings.testnet"));
        v.set_agent(Some(acc("agent.testnet")), None);
        ctx("agent.testnet");
        v
    }

    #[test]
    fn happy_path() { let mut v = setup(); v.agent_transfer(acc("savings.testnet"), NearToken::from_near(1)); }

    #[test]
    #[should_panic(expected = "ERR_NOT_ALLOWLISTED")]
    fn red_team_send_everything_to_evil() {
        let mut v = setup();
        v.agent_transfer(acc("evil.testnet"), NearToken::from_near(100));
    }

    #[test]
    #[should_panic(expected = "ERR_OVER_PER_TX_CAP")]
    fn over_per_tx_cap() { let mut v = setup(); v.agent_transfer(acc("savings.testnet"), NearToken::from_near(5)); }

    #[test]
    #[should_panic(expected = "ERR_OVER_DAILY_CAP")]
    fn over_daily_cap() {
        let mut v = setup();
        v.agent_transfer(acc("savings.testnet"), NearToken::from_near(1));
        v.agent_transfer(acc("savings.testnet"), NearToken::from_near(1));
        v.agent_transfer(acc("savings.testnet"), NearToken::from_near(1));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_AGENT")]
    fn stranger_rejected() { let mut v = setup(); ctx("rando.testnet"); v.agent_transfer(acc("savings.testnet"), NearToken::from_near(1)); }

    #[test]
    #[should_panic(expected = "ERR_FROZEN")]
    fn panic_freezes_agent() {
        let mut v = setup();
        ctx("owner.testnet"); v.panic();
        ctx("agent.testnet"); v.agent_transfer(acc("savings.testnet"), NearToken::from_near(1));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn agent_cannot_change_policy() { let mut v = setup(); v.set_policy(NearToken::from_near(100), NearToken::from_near(100)); }
}
