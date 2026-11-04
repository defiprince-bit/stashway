// Counterparty Guard: deterministic ALLOW / WARN / BLOCK with reasons + evidence. No AI authorizes anything.
// On ALLOW it signs an ed25519 permit bound to vault|agent|receiver|amount|nonce|expiry (intent lock).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { view, viewAccount } from "../lib/near.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.GUARD_KEY_FILE || path.join(DIR, ".guard-key.json"); // gitignored, testnet-only key
const EVENTS = path.join(DIR, "events.jsonl");       // security event log (gitignored, exported to web/)
const DRIFT = path.join(DIR, "code-hashes.json");    // Trust Drift memory
const BLOCKLIST = JSON.parse(fs.readFileSync(path.join(DIR, "blocklist.json")));
const EMPTY_CODE = "11111111111111111111111111111111";

export function guardKey() {
  if (!fs.existsSync(KEY)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(KEY, JSON.stringify({ priv: privateKey.export({ format: "pem", type: "pkcs8" }),
      pubRaw: publicKey.export({ format: "jwk" }).x }), { mode: 0o600 });
  }
  const k = JSON.parse(fs.readFileSync(KEY));
  return { priv: crypto.createPrivateKey(k.priv), pubB64: Buffer.from(k.pubRaw, "base64url").toString("base64") };
}
export function logEvent(e) { fs.appendFileSync(EVENTS, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n"); }
export function events() { return fs.existsSync(EVENTS) ? fs.readFileSync(EVENTS, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; }

export const permitMsg = (p) => `stashway-permit:v1|${p.vault}|${p.agent}|${p.receiver}|${p.amount}|${p.nonce}|${p.expiry}|ALLOW`;
export function signPermit(p) {
  return Buffer.from(crypto.sign(null, Buffer.from(permitMsg(p)), guardKey().priv)).toString("base64");
}

async function ageDays(id) {
  try {
    const r = await (await fetch(`https://api-testnet.nearblocks.io/v1/account/${id}`)).json();
    const ts = r?.account?.[0]?.created?.block_timestamp;
    return ts ? (Date.now() - Number(ts) / 1e6) / 864e5 : null;
  } catch { return null; }
}

/** intent: { vault, agent, receiver, amount (yocto string) } */
export async function check(intent) {
  const reasons = [], evidence = {};
  let level = 0; // 0 ALLOW, 1 WARN, 2 BLOCK
  const bump = (l, r) => { level = Math.max(level, l); reasons.push(r); };
  const { vault, receiver } = intent;

  if (BLOCKLIST.includes(receiver)) bump(2, `receiver ${receiver} is on the shared blocklist`);
  let owner = null, allow = [], policy = null;
  try { [policy, allow] = await Promise.all([view(vault, "get_policy"), view(vault, "get_allowlist")]);
        owner = await view(vault, "get_owner").catch(() => null); }
  catch { bump(1, "could not read vault policy (soft-fail)"); }
  evidence.allowlisted = allow.includes(receiver);
  if (policy && !evidence.allowlisted) bump(2, "receiver is not on the vault allowlist");
  if (policy && BigInt(intent.amount) > BigInt(policy[0])) bump(2, "amount exceeds per_tx_cap");
  if (policy && policy[2]) bump(2, "vault is frozen (panic)");

  const acct = level < 2 ? await viewAccount(receiver).catch(() => undefined) : undefined;
  if (acct === null) bump(2, "receiver account does not exist");
  else if (acct === undefined) { if (level < 2) bump(1, "account lookup unavailable (soft-fail)"); }
  else {
    evidence.is_contract = acct.code_hash !== EMPTY_CODE;
    evidence.code_hash = acct.code_hash;
    const drift = fs.existsSync(DRIFT) ? JSON.parse(fs.readFileSync(DRIFT)) : {};
    if (drift[receiver] && drift[receiver] !== acct.code_hash) bump(1, `Trust Drift: code_hash changed (${drift[receiver]} → ${acct.code_hash})`);
    drift[receiver] = acct.code_hash; fs.writeFileSync(DRIFT, JSON.stringify(drift, null, 1));
    if (evidence.is_contract) bump(1, "receiver is a contract (review before paying)");
  }
  if (level < 2) {
    const age = await ageDays(receiver);
    evidence.age_days = age === null ? "unknown" : +age.toFixed(2);
    if (age !== null && age < 1) bump(1, "receiver account is less than 1 day old");
    const prior = events().some((e) => e.vault === vault && e.receiver === receiver && e.result === "ONCHAIN_OK");
    evidence.prior_relationship = prior || receiver === owner;
    if (!evidence.prior_relationship) bump(1, "first-time receiver for this vault (no prior successful transfer)");
  }
  const decision = ["ALLOW", "WARN", "BLOCK"][level];
  if (!reasons.length) reasons.push("all signals clean");
  const out = { decision, reasons, evidence };
  if (decision === "ALLOW") {
    const p = { ...intent, nonce: String(Date.now() * 1000 + crypto.randomInt(1000)), expiry: String((Date.now() + 10 * 60e3) * 1e6) };
    out.permit = { ...p, sig: signPermit(p) };
  }
  return out;
}
