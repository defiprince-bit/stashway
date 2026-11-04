import fs from "node:fs";
import crypto from "node:crypto";
import { okOwner, createViaFaucet, vaultAccount, guardPub, limited, ip, transactions } from "./_prov.mjs";
const WASM = new URL("./_vault.wasm", import.meta.url);
const CAPS = { per_tx_cap: "1000000000000000000000000", daily_cap: "2000000000000000000000000" };
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST { owner }" });
  const owner = String(req.body?.owner || "").trim().toLowerCase();
  if (!okOwner(owner)) return res.status(400).json({ error: "owner must be a *.testnet account" });
  if (limited("ip:" + ip(req), 3) || limited("o:" + owner, 3)) return res.status(429).json({ error: "limit: 3 vaults/day — try tomorrow or reuse your vault" });
  const vault = `sw-${crypto.createHash("sha256").update(owner).digest("hex").slice(0, 6)}-${Date.now().toString(36)}.testnet`;
  try {
    await createViaFaucet(vault);
    await new Promise((r) => setTimeout(r, 2500));
    const acct = await vaultAccount(vault), g = guardPub();
    // set_guard / allow / set_policy are owner-only: the user's wallet signs them in Setup step 4.
    const r = await acct.signAndSendTransaction({ receiverId: vault, actions: [
      transactions.deployContract(fs.readFileSync(WASM)),
      transactions.functionCall("new", { owner, ...CAPS }, 100000000000000n, 0n),
    ] });
    return res.json({ vault, owner, network: "testnet", explorer: `https://testnet.nearblocks.io/address/${vault}`,
      tx: `https://testnet.nearblocks.io/txns/${r.transaction.hash}`, guard_pub: g, ...CAPS });
  } catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300), vault }); }
}
