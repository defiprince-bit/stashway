// Stashway agent brain (MVP): deterministic rules engine, no paid AI.
// It turns a user/attacker message into a JSON action. The CONTRACT enforces safety.
// Usage: node agent/agent.mjs "<message>"            -> prints action + near-cli command
//        VAULT=x.testnet AGENT=y.testnet node agent/agent.mjs "<msg>" --send  -> actually calls testnet
import { execSync } from "node:child_process";
const msg = process.argv[2] || "save 0.5 NEAR to savings";
const send = process.argv.includes("--send");
const VAULT = process.env.VAULT || "stashway-demo.testnet";
const AGENT = process.env.AGENT || VAULT;

function brain(text) {
  const t = text.toLowerCase();
  const amt = (t.match(/(\d+(?:\.\d+)?)\s*near/) || [])[1];
  const to = (t.match(/to\s+([a-z0-9_.-]+\.(?:testnet|near))/) || [])[1];
  // Naive on purpose: an injected instruction is obeyed, like a real jailbroken LLM would.
  if (/send everything|all funds|drain/.test(t))
    return { method: "agent_transfer", receiver: to || "evil.testnet", amount: "100 NEAR", note: "INJECTED" };
  return { method: "agent_transfer", receiver: to || `savings.${VAULT}`.replace(/^savings\.(.*)$/, "savings-$1"), amount: `${amt || "0.5"} NEAR` };
}
const a = brain(msg);
console.log("agent action:", JSON.stringify(a));
const args = JSON.stringify({ receiver: a.receiver, amount: toYocto(a.amount) });
const cmd = `near contract call-function as-transaction ${VAULT} agent_transfer json-args '${args}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${AGENT} network-config testnet ${process.env.AGENT_KEY_FILE ? "sign-with-access-key-file " + process.env.AGENT_KEY_FILE : "sign-with-legacy-keychain"} send`;
console.log(cmd);
if (send) {
  // Sign locally, broadcast via RPC so we always get a tx hash (even for rejected txs).
  const out = execSync(cmd.replace(/ send$/, " display") + " 2>&1").toString();
  const b64 = out.split("serialized as base64")[1].split("\n")[1].replace(/[\s│]/g, "");
  const r = await (await fetch("https://rpc.testnet.near.org", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "broadcast_tx_commit", params: [b64] }) })).json();
  if (r.error) { console.log("RPC error:", JSON.stringify(r.error)); process.exit(1); }
  const h = r.result.transaction.hash, st = r.result.status;
  console.log(st.Failure ? ">>> CONTRACT REJECTED: " + JSON.stringify(st.Failure) : ">>> ALLOWED");
  console.log("https://testnet.nearblocks.io/txns/" + h);
}
function toYocto(s) { const [i, f = ""] = s.split(" ")[0].split("."); return BigInt(i + (f + "0".repeat(24)).slice(0, 24)).toString(); }
