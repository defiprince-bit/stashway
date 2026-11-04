// Stashway try API core: the same brain -> Guard -> contract path as agent/agent.mjs, stateless for serverless.
// Testnet sandbox only. Secrets come from Vercel env (AGENT_KEY, GUARD_KEY); never from git.
import crypto from "node:crypto";
import fs from "node:fs";
import { KeyPair, connect, keyStores, transactions } from "near-api-js";

export const NET = "testnet", RPC = process.env.NEAR_RPC || "https://rpc.testnet.near.org";
export const VAULT = process.env.VAULT || "stashway-judge-3074.testnet";
export const OWNER = process.env.OWNER || "stashway-owner-3238.testnet";
export const SAVINGS = process.env.SAVINGS || "stashway-judge-save-3074.testnet";
export const AGENT_ID = process.env.AGENT_ID || "ed25519:EnXcyJGwodV9bCHahiL8mn4DSGWxuKgVoozSKCZGRhof";
const BLOCKLIST = JSON.parse(fs.readFileSync(new URL("./_blocklist.json", import.meta.url)));
const EMPTY = "11111111111111111111111111111111";
const nb = (h) => `https://testnet.nearblocks.io/txns/${h}`;
export const yocto = (n) => { const [i, f = ""] = String(n).split("."); return BigInt(i + (f + "0".repeat(24)).slice(0, 24)).toString(); };

async function rpc(method, params) {
  const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(JSON.stringify(r.error)); return r.result;
}
export async function view(m) {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: VAULT, method_name: m, args_base64: Buffer.from("{}").toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
}
async function viewAccount(id) {
  try { return await rpc("query", { request_type: "view_account", finality: "final", account_id: id }); }
  catch (e) { if (/UNKNOWN_ACCOUNT|does not exist/.test(e.message)) return null; throw e; }
}
async function ageDays(id) {
  try { const r = await (await fetch(`https://api-testnet.nearblocks.io/v1/account/${id}`)).json();
    const ts = r?.account?.[0]?.created?.block_timestamp; return ts ? (Date.now() - Number(ts) / 1e6) / 864e5 : null; } catch { return null; }
}

/** Deliberately naive brain (a jailbroken LLM would obey the injection too). */
export function brain(text) {
  const t = String(text).toLowerCase();
  const amt = (t.match(/(\d+(?:\.\d+)?)\s*near/) || [])[1];
  const to = (t.match(/to\s+([a-z0-9_.-]+\.(?:testnet|near))/) || [])[1];
  if (/send everything|all funds|drain/.test(t)) return { receiver: to || "evil.testnet", near: "100", injected: true };
  return { receiver: to || OWNER, near: amt || "0.1" };
}

const permitMsg = (p) => `stashway-permit:v1|${p.vault}|${p.agent}|${p.receiver}|${p.amount}|${p.nonce}|${p.expiry}|ALLOW`;
function guardPriv() { if (!process.env.GUARD_KEY) throw new Error("GUARD_KEY env missing"); return crypto.createPrivateKey(process.env.GUARD_KEY.replace(/\\n/g, "\n")); }

/** Counterparty Guard (stateless port of guard/guard.mjs). */
export async function check(intent) {
  const reasons = [], evidence = {}; let level = 0;
  const bump = (l, r) => { level = Math.max(level, l); reasons.push(r); };
  const { receiver } = intent;
  if (BLOCKLIST.includes(receiver)) bump(2, `receiver ${receiver} is on the shared blocklist`);
  let policy = null, allow = [];
  try { [policy, allow] = await Promise.all([view("get_policy"), view("get_allowlist")]); } catch { bump(1, "could not read vault policy (soft-fail)"); }
  evidence.allowlisted = allow.includes(receiver);
  if (policy && !evidence.allowlisted) bump(2, "receiver is not on the vault allowlist");
  if (policy && BigInt(intent.amount) > BigInt(policy[0])) bump(2, "amount exceeds per_tx_cap");
  if (policy && policy[2]) bump(2, "vault is frozen (panic)");
  const acct = level < 2 ? await viewAccount(receiver).catch(() => undefined) : undefined;
  if (acct === null) bump(2, "receiver account does not exist");
  else if (acct) { evidence.is_contract = acct.code_hash !== EMPTY; if (evidence.is_contract) bump(1, "receiver is a contract (review before paying)"); }
  if (level < 2) {
    const age = await ageDays(receiver); evidence.age_days = age === null ? "unknown" : +age.toFixed(2);
    if (age !== null && age < 1) bump(1, "receiver account is less than 1 day old");
    evidence.prior_relationship = receiver === OWNER || receiver === SAVINGS;
  }
  const decision = ["ALLOW", "WARN", "BLOCK"][level]; if (!reasons.length) reasons.push("all signals clean");
  const out = { decision, reasons, evidence };
  if (decision === "ALLOW") {
    const p = { ...intent, nonce: String(Date.now() * 1000 + crypto.randomInt(1000)), expiry: String((Date.now() + 10 * 60e3) * 1e6) };
    out.permit = { ...p, sig: Buffer.from(crypto.sign(null, Buffer.from(permitMsg(p)), guardPriv())).toString("base64") };
  }
  return out;
}

async function agentAccount() {
  if (!process.env.AGENT_KEY) throw new Error("AGENT_KEY env missing");
  const ks = new keyStores.InMemoryKeyStore(); await ks.setKey(NET, VAULT, KeyPair.fromString(process.env.AGENT_KEY));
  return (await connect({ networkId: NET, nodeUrl: RPC, keyStore: ks })).account(VAULT);
}
/** Sign with the sandbox agent function-call key; hash/labels come only from RPC. */
export async function agentTransfer(args) {
  try {
    const a = await agentAccount(); // fresh each call: avoids stale cached nonce
    const [, signed] = await a.signTransaction(VAULT, [transactions.functionCall("agent_transfer", args, 30000000000000n, 0n)]);
    const r = await a.connection.provider.sendTransaction(signed);
    const h = r.transaction.hash;
    if (r.status.Failure) return { result: "ONCHAIN_REJECT", error: JSON.stringify(r.status.Failure).match(/ERR_[A-Z_]+/)?.[0] || JSON.stringify(r.status.Failure).slice(0, 300), tx: h, url: nb(h) };
    return { result: "ONCHAIN_OK", tx: h, url: nb(h) };
  } catch (e) { return { result: "RPC_ERROR", error: String(e.message || e).slice(0, 300) }; }
}
