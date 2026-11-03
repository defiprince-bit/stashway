// Arena scenario 6 (film-last, opt-in): real on-chain panic -> agent blocked -> recovery.
// Testnet only. Run: node arena/panic.mjs   (or scripts/panic-demo.sh). Appends scenario 6 to web/results.json.
// Recovery: vault full key (local keychain) adds a fresh agent_transfer-only key; owner set_agent(new pk) also unfreezes.
import fs from "node:fs";
import { execSync } from "node:child_process";
import { callTx, view } from "../lib/near.mjs";
import { runIntent } from "../agent/agent.mjs";
import { logEvent, events } from "../guard/guard.mjs";

const envUrl = new URL("../.env.testnet", import.meta.url);
const env = Object.fromEntries(fs.readFileSync(envUrl, "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
if (!env.VAULT.endsWith(".testnet")) throw new Error("testnet only");
const owner = { id: env.OWNER }, steps = [];
const step = (s) => { steps.push(s); logEvent({ vault: env.VAULT, ...s }); console.log(s.label, "→", s.result, s.error || "", s.url || ""); };
const tx = (label, r, extra = {}) => step({ label, ...extra, result: r.kind, error: r.error, tx: r.hash, url: r.url });

// 1. Owner hits Panic
tx("owner presses PANIC: freeze + delete agent key", await callTx(env.VAULT, "panic", {}, owner), { decision: "OWNER" });
const pol = await view(env.VAULT, "get_policy");
console.log("policy after panic: frozen =", pol[2]);
// 2. Agent's old key is gone: cannot even sign/broadcast
const exp = String((Date.now() + 6e5) * 1e6), nonce = String(Date.now() * 1000);
const args = { receiver: env.OWNER, amount: "100000000000000000000000", nonce, expiry: exp, permit_sig: null };
const old = await callTx(env.VAULT, "agent_transfer", args, { id: env.VAULT, keyFile: env.AGENT_KEY_FILE });
step({ label: "agent retries with its old key (deleted by panic)", result: old.kind === "ONCHAIN_OK" ? old.kind : "KEY_REVOKED", error: old.error ? (old.error.match(/InvalidAccessKey\w*|AccessKeyNotFound|does not exist/)?.[0] || "access key deleted") : undefined, tx: old.hash, url: old.url });
// 3. Any other signer hitting agent_transfer gets ERR_FROZEN on-chain
tx("any signer calls agent_transfer while frozen", await callTx(env.VAULT, "agent_transfer", args, owner));

// 4. Recovery: fresh function-call key (agent_transfer only), owner re-registers it (set_agent also unfreezes)
const before = new Set(fs.readdirSync(`${process.env.HOME}/.near-credentials/testnet/${env.VAULT}`));
execSync(`near account add-key ${env.VAULT} grant-function-call-access --allowance '0.25 NEAR' --contract-account-id ${env.VAULT} --function-names agent_transfer autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-legacy-keychain send`, { stdio: "ignore" });
const file = fs.readdirSync(`${process.env.HOME}/.near-credentials/testnet/${env.VAULT}`).find((f) => !before.has(f));
if (!file) throw new Error("new agent key not found; recovery incomplete");
const PK = file.replace(".json", "").replace("_", ":");
tx("owner re-registers a fresh agent key (set_agent → unfrozen)", await callTx(env.VAULT, "set_agent", { agent: null, agent_key: PK }, owner), { decision: "OWNER" });
env.AGENT_ID = PK; env.AGENT_KEY_FILE = `${process.env.HOME}/.near-credentials/testnet/${env.VAULT}/${file}`;
fs.writeFileSync(envUrl, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
// 5. Prove it works again
const ok = await runIntent({ vault: env.VAULT, agentId: env.AGENT_ID, keyFile: env.AGENT_KEY_FILE, receiver: env.OWNER, near: "0.1", label: "new agent key saves 0.1 NEAR (vault usable again)" });
const { _permit, ...okc } = ok; steps.push(okc); console.log(okc.label, "→", okc.result, okc.url || "");

const rUrl = new URL("../web/results.json", import.meta.url), d = JSON.parse(fs.readFileSync(rUrl, "utf8"));
d.results = d.results.filter((r) => r.id !== 6).concat({ id: 6, title: "Panic button", attack: "owner kill-switch mid-incident", steps });
d.agent_key = PK; d.panic_generated = new Date().toISOString(); d.events = events().slice(-50);
fs.writeFileSync(rUrl, JSON.stringify(d, null, 1));
console.log("scenario 6 written; new agent key", PK);
