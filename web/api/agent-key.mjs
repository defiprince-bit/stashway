import { okOwner, vaultAccount, limited, ip, RPC } from "./_prov.mjs";
import { transactions, utils } from "near-api-js";
const view = async (v, m) => { const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: v, method_name: m, args_base64: "e30=" } }) })).json();
  if (r.error || !r.result?.result) throw new Error("vault not found"); return JSON.parse(Buffer.from(r.result.result).toString()); };
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST { vault, owner, agent_pk }" });
  const { vault, owner, agent_pk } = req.body || {};
  if (!/^sw-[a-f0-9]{6}-[a-z0-9]+\.testnet$/.test(vault || "") || !okOwner(owner) || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(agent_pk || ""))
    return res.status(400).json({ error: "bad vault / owner / agent_pk" });
  if (limited("k:" + ip(req), 10)) return res.status(429).json({ error: "rate limited" });
  try {
    if ((await view(vault, "get_owner")) !== owner) return res.status(403).json({ error: "owner does not match vault" });
    const acct = await vaultAccount(vault);
    const r = await acct.signAndSendTransaction({ receiverId: vault, actions: [
      transactions.addKey(utils.PublicKey.from(agent_pk), transactions.functionCallAccessKey(vault, ["agent_transfer"], 250000000000000000000000n)) ] });
    return res.json({ ok: true, agent_pk, tx: `https://testnet.nearblocks.io/txns/${r.transaction.hash}` });
  } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
}
