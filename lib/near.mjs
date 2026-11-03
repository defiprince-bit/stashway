// Minimal testnet helpers: sign with near-cli-rs (local keys), broadcast via RPC. Hashes come ONLY from RPC.
import { execSync } from "node:child_process";
export const RPC = process.env.NEAR_RPC || "https://rpc.testnet.near.org";
export const explorer = (h) => `https://testnet.nearblocks.io/txns/${h}`;

export async function rpc(method, params) {
  const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw Object.assign(new Error(JSON.stringify(r.error)), { rpcError: r.error });
  return r.result;
}
export async function view(contract, method, args = {}) {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: contract,
    method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
}
export async function viewAccount(id) {
  try { return await rpc("query", { request_type: "view_account", finality: "final", account_id: id }); }
  catch (e) { if (/UNKNOWN_ACCOUNT|does not exist/.test(e.message)) return null; throw e; }
}
/** signer: { id, keyFile } (agent function-call key) or { id } (legacy keychain full key). */
export async function callTx(contract, method, args, signer) {
  const sign = signer.keyFile ? `sign-with-access-key-file ${signer.keyFile}` : "sign-with-legacy-keychain";
  const cmd = `near contract call-function as-transaction ${contract} ${method} json-args '${JSON.stringify(args)}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as ${signer.id} network-config testnet ${sign} display 2>&1`;
  let out;
  try { out = execSync(cmd).toString(); } catch (e) { return { kind: "SIGN_ERROR", error: String(e.stdout || e.message).slice(-400) }; }
  const b64 = out.split("serialized as base64")[1].split("\n")[1].replace(/[\s│]/g, "");
  try {
    const r = await rpc("broadcast_tx_commit", [b64]);
    const h = r.transaction.hash;
    if (r.status.Failure) {
      const err = JSON.stringify(r.status.Failure).match(/ERR_[A-Z_]+/)?.[0] || JSON.stringify(r.status.Failure);
      return { kind: "ONCHAIN_REJECT", error: err, hash: h, url: explorer(h) };
    }
    return { kind: "ONCHAIN_OK", hash: h, url: explorer(h) };
  } catch (e) { return { kind: "RPC_ERROR", error: e.message.slice(0, 300) }; }
}
export const yocto = (near) => { const [i, f = ""] = String(near).split("."); return BigInt(i + (f + "0".repeat(24)).slice(0, 24)).toString(); };
