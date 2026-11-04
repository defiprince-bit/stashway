// Self-serve vault provisioning (testnet only). Vault full-access key is derived from GUARD_KEY + vault id (HMAC),
// so the server can later add the agent's function-call key without storing anything. Contract owner = user's wallet.
import crypto from "node:crypto";
import { KeyPair, connect, keyStores, transactions, utils } from "near-api-js";
export const RPC = process.env.NEAR_RPC || "https://rpc.testnet.near.org";
const HELPER = process.env.NEAR_HELPER || "https://helper.testnet.near.org";
const secret = () => { if (!process.env.GUARD_KEY) throw new Error("GUARD_KEY env missing"); return process.env.GUARD_KEY; };
export function vaultKey(vault) {
  const seed = crypto.createHmac("sha256", secret()).update("stashway-vault:v1|" + vault).digest();
  const sk = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(crypto.createPublicKey(sk).export({ format: "jwk" }).x, "base64url");
  return KeyPair.fromString("ed25519:" + utils.serialize.base_encode(Buffer.concat([seed, pub])));
}
export function guardPub() {
  const k = crypto.createPrivateKey(secret().replace(/\\n/g, "\n"));
  return Buffer.from(crypto.createPublicKey(k).export({ format: "jwk" }).x, "base64url").toString("base64");
}
export async function vaultAccount(vault) {
  const ks = new keyStores.InMemoryKeyStore(); await ks.setKey("testnet", vault, vaultKey(vault));
  return (await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks })).account(vault);
}
export const okOwner = (o) => typeof o === "string" && /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.testnet$/.test(o) && o.length <= 64;
export async function createViaFaucet(vault) {
  const r = await fetch(HELPER + "/account", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: vault, newAccountPublicKey: vaultKey(vault).getPublicKey().toString() }) });
  if (!r.ok) throw new Error("faucet " + r.status + " " + (await r.text()).slice(0, 200));
}
const hits = new Map();
export function limited(key, max, ms = 864e5) {
  const now = Date.now(), a = (hits.get(key) || []).filter((t) => now - t < ms); a.push(now); hits.set(key, a); return a.length > max;
}
export const ip = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
export { transactions };
