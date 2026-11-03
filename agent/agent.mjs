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
const cmd = `near contract call-function as-transaction ${VAULT} agent_transfer json-args '${args}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${AGENT} network-config testnet sign-with-keychain send`;
console.log(cmd);
if (send) { try { execSync(cmd, { stdio: "inherit" }); } catch { console.log("\n>>> CONTRACT REJECTED the action (expected for red-team). Check the tx on testnet.nearblocks.io"); } }
function toYocto(s) { const [i, f = ""] = s.split(" ")[0].split("."); return BigInt(i + (f + "0".repeat(24)).slice(0, 24)).toString(); }
