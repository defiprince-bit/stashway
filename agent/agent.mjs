// Stashway agent (MVP brain = deterministic rules, no paid AI).
// Flow: brain proposes -> Counterparty Guard decides -> only ALLOW+permit is submitted -> contract decides.
// Usage: VAULT=.. AGENT_ID=ed25519:.. AGENT_KEY_FILE=.. node agent/agent.mjs "<message>" [--send] [--skip-guard]
import { check, logEvent } from "../guard/guard.mjs";
import { callTx, yocto } from "../lib/near.mjs";

export function brain(text) {
  const t = text.toLowerCase();
  const amt = (t.match(/(\d+(?:\.\d+)?)\s*near/) || [])[1];
  const to = (t.match(/to\s+([a-z0-9_.-]+\.(?:testnet|near))/) || [])[1];
  // Naive on purpose: an injected instruction is obeyed, like a jailbroken LLM would.
  if (/send everything|all funds|drain/.test(t)) return { receiver: to || "evil.testnet", near: "100", injected: true };
  return { receiver: to, near: amt || "0.1" };
}

/** Run one intent end-to-end. Returns a security event. Never invents hashes. */
export async function runIntent({ vault, agentId, keyFile, receiver, near, skipGuard = false, send = true, label = "" }) {
  const intent = { vault, agent: agentId, receiver, amount: yocto(near) };
  const ev = { label, vault, receiver, near };
  let permit = null;
  if (!skipGuard) {
    const g = await check(intent);
    Object.assign(ev, { decision: g.decision, reasons: g.reasons, evidence: g.evidence });
    if (g.decision === "BLOCK") { ev.result = "OFFCHAIN_REFUSAL"; logEvent(ev); return ev; }
    if (g.decision === "WARN") { ev.result = "WAITING_OWNER_CONFIRM"; ev.pending = { ...intent, nonce: String(Date.now() * 1000), expiry: String((Date.now() + 30 * 60e3) * 1e6) }; logEvent(ev); return ev; }
    permit = g.permit;
  } else { ev.decision = "SKIPPED (jailbroken agent bypasses Guard)"; }
  ev.permit = permit ? "signed" : "none";
  if (!send) { ev.result = "DRY_RUN"; return ev; }
  const nonce = permit?.nonce || String(Date.now() * 1000), expiry = permit?.expiry || String((Date.now() + 6e5) * 1e6);
  const r = await callTx(vault, "agent_transfer", { receiver, amount: yocto(near), nonce, expiry, permit_sig: permit?.sig ?? null }, { id: vault, keyFile });
  Object.assign(ev, { result: r.kind, error: r.error, tx: r.hash, url: r.url, _permit: permit });
  logEvent({ ...ev, _permit: undefined });
  return ev;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = brain(process.argv[2] || "save 0.1 NEAR");
  const ev = await runIntent({ vault: process.env.VAULT, agentId: process.env.AGENT_ID, keyFile: process.env.AGENT_KEY_FILE,
    receiver: a.receiver || process.env.SAVINGS, near: a.near, skipGuard: process.argv.includes("--skip-guard"), send: process.argv.includes("--send") });
  delete ev._permit; console.log(JSON.stringify(ev, null, 2));
}
